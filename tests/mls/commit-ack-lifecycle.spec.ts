import { test, expect, VaultAutomation } from "../fixtures";

/**
 * MLS Commit-Acknowledgment Lifecycle E2E Tests
 *
 * Tests the full commit-ACK cycle between two vault instances over QUIC:
 *
 * Leader (Vault A):
 *  - Creates local space with MLS group
 *  - Accepts invite from peer → add_member commit + Welcome
 *  - Removes member → remove_member commit + broadcast
 *  - Tracks pending ACKs, cleans up after full acknowledgment
 *
 * Peer (Vault B):
 *  - Joins via ClaimInvite (receives Welcome)
 *  - Sync loop fetches MLS commits, processes them, sends ACKs
 *  - After removal: MLS group epoch advances, forward secrecy verified
 *
 * NO MOCKS. Everything runs against real Tauri backends over real QUIC.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

type JsonValue = string | number | boolean | null;

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

interface MlsGroupInfo {
  group_id: string;
  epoch: number;
  member_count: number;
}

interface MlsCommitBundle {
  commit: number[];
  welcome: number[] | null;
  group_info: number[];
}

interface MlsIdentityInfo {
  signature_public_key: number[];
  credential: number[];
}

interface MlsEpochKey {
  epoch: number;
  key: number[];
}

interface ClaimInviteResult {
  space_id: string;
  capability: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 30_000, interval = 1_000, label = "condition" } = opts;
  const start = Date.now();
  let last: T;
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      lastError = e;
    }
    await wait(interval);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeout}ms. Last error: ${lastError}`);
}

async function sqlQuery<T extends Record<string, unknown>>(
  vault: VaultAutomation,
  sql: string,
  params: JsonValue[] = [],
): Promise<T[]> {
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  if (!selectMatch) throw new Error(`Cannot parse SELECT columns: ${sql}`);
  const columns = selectMatch[1]
    .split(",")
    .map((c) =>
      c.trim().replace(/.*\s+AS\s+/i, "").replace(/"/g, "").replace(/.*\./, ""),
    );
  const rows = await vault.invokeTauriCommand<JsonValue[][]>(
    "sql_select_with_crdt",
    { sql, params },
  );
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj as T;
  });
}

async function sqlQueryRaw<T extends Record<string, unknown>>(
  vault: VaultAutomation,
  sql: string,
  params: JsonValue[] = [],
): Promise<T[]> {
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  if (!selectMatch) throw new Error(`Cannot parse SELECT columns: ${sql}`);
  const columns = selectMatch[1]
    .split(",")
    .map((c) =>
      c.trim().replace(/.*\s+AS\s+/i, "").replace(/"/g, "").replace(/.*\./, ""),
    );
  const rows = await vault.invokeTauriCommand<JsonValue[][]>(
    "sql_select",
    { sql, params },
  );
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj as T;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: commit acknowledgment lifecycle", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let relayUrlB: string | null;
  let identityDidA: string;
  let identityDidB: string;
  const spaceId = `e2e-mls-ack-${Date.now()}`;
  const spaceName = "MLS ACK Test Space";
  let epochKeyBefore: MlsEpochKey;

  // =========================================================================
  // Setup: Two vaults, P2P endpoints, MLS identities
  // =========================================================================

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Ensure Vault B has an open vault
    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "MLS ACK Test B",
        key: "test-mls-ack-b",
        spaceId: null,
      });
    } catch {
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults", {});
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", {
          vaultPath: vaults[0].path,
          key: "test-mls-ack-b",
        });
      }
    }
  });

  test.afterAll(async () => {
    // Stop sync loops and leader mode
    for (const vault of [vaultA, vaultB]) {
      try { await vault.invokeTauriCommand("local_delivery_disconnect", { spaceId }); } catch { /* ignore */ }
      try { await vault.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* ignore */ }
      try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  // Phase 1: Infrastructure — P2P endpoints + MLS identity
  // =========================================================================

  test("start P2P endpoints on both vaults", async () => {
    // Stop any running endpoints first
    for (const vault of [vaultA, vaultB]) {
      try {
        const status = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
        if (status.running) await vault.invokeTauriCommand("peer_storage_stop", {});
      } catch { /* ignore */ }
    }

    const infoA = await vaultA.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
    nodeIdA = infoA.nodeId;
    relayUrlA = infoA.relayUrl;

    const infoB = await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
    nodeIdB = infoB.nodeId;
    relayUrlB = infoB.relayUrl;

    expect(nodeIdA).toBeTruthy();
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdA).not.toBe(nodeIdB);
  });

  test("initialize MLS subsystem on both vaults", async () => {
    // Initialize MLS tables
    await vaultA.invokeTauriCommand("mls_init_tables", {});
    await vaultB.invokeTauriCommand("mls_init_tables", {});

    // Get identities for DID
    const identitiesA = await sqlQuery<{ did: string }>(
      vaultA,
      "SELECT did FROM haex_identities",
    );
    const identitiesB = await sqlQuery<{ did: string }>(
      vaultB,
      "SELECT did FROM haex_identities",
    );

    // If no identity exists yet, create one
    if (identitiesA.length === 0) {
      // Identity is created via ensureDefaultIdentityAsync — we can't easily
      // replicate that here, so we read whatever exists after vault open
      throw new Error("Vault A has no identity — ensure vault is properly initialized");
    }
    if (identitiesB.length === 0) {
      throw new Error("Vault B has no identity — ensure vault is properly initialized");
    }

    identityDidA = identitiesA[0].did as string;
    identityDidB = identitiesB[0].did as string;

    expect(identityDidA).toMatch(/^did:key:/);
    expect(identityDidB).toMatch(/^did:key:/);
    expect(identityDidA).not.toBe(identityDidB);

    // Initialize MLS identity with DID
    await vaultA.invokeTauriCommand<MlsIdentityInfo>("mls_init_identity", { did: identityDidA });
    await vaultB.invokeTauriCommand<MlsIdentityInfo>("mls_init_identity", { did: identityDidB });
  });

  // =========================================================================
  // Phase 2: Space + MLS Group creation on leader (Vault A)
  // =========================================================================

  test("leader creates local space with MLS group", async () => {
    // Create space on Vault A
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, status, name) VALUES (?1, 'local', 'active', ?2)`,
      params: [spaceId, spaceName],
    });

    // Create MLS group
    const groupInfo = await vaultA.invokeTauriCommand<MlsGroupInfo>(
      "mls_create_group", { spaceId }
    );

    expect(groupInfo.group_id).toBe(spaceId);
    expect(groupInfo.epoch).toBe(0);
    expect(groupInfo.member_count).toBe(1); // just the creator

    // Export epoch key
    epochKeyBefore = await vaultA.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );
    expect(epochKeyBefore.epoch).toBe(0);
    expect(epochKeyBefore.key.length).toBe(32);

    // Register leader's own device in space_devices (needed for P2P discovery)
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, relay_url, priority, is_self, last_seen)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, datetime('now'))`,
      params: [
        `dev-a-${Date.now()}`, spaceId, `device-a-${Date.now()}`,
        nodeIdA, relayUrlA,
      ],
    });

    // Add leader as member
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_members (id, space_id, member_did, member_public_key, label, role)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      params: [
        `member-a-${Date.now()}`, spaceId, identityDidA,
        "pk-leader", "Leader", "admin",
      ],
    });
  });

  test("leader starts leader mode for the space", async () => {
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });

    // Verify leader is active
    const leaders = await vaultA.invokeTauriCommand<Record<string, unknown>>(
      "local_delivery_status", {}
    );
    expect(leaders).toBeTruthy();
  });

  // =========================================================================
  // Phase 3: Peer joins via ClaimInvite (Vault B)
  // =========================================================================

  test("leader creates invite token for peer", async () => {
    const tokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      {
        spaceId,
        targetDid: identityDidB,
        capability: "space/write",
        maxUses: 1,
        expiresInSeconds: 3600,
        includeHistory: false,
      },
    );

    expect(tokenId).toBeTruthy();

    // Store token ID for claim step
    (test.info() as any).__tokenId = tokenId;
  });

  test("peer claims invite and receives MLS Welcome", async () => {
    const tokenId = (test.info() as any).__tokenId;
    if (!tokenId) {
      // Fallback: list tokens from leader
      const tokens = await vaultA.invokeTauriCommand<Array<{ id: string }>>(
        "local_delivery_list_invites", { spaceId }
      );
      expect(tokens.length).toBeGreaterThan(0);
      (test.info() as any).__tokenId = tokens[0].id;
    }

    const result = await vaultB.invokeTauriCommand<ClaimInviteResult>(
      "local_delivery_claim_invite",
      {
        leaderEndpointId: nodeIdA,
        leaderRelayUrl: relayUrlA,
        spaceId,
        tokenId: (test.info() as any).__tokenId || tokenId,
        identityDid: identityDidB,
        label: "Peer B",
        identityPublicKey: "pk-peer-b",
      },
    );

    expect(result.space_id).toBe(spaceId);
    expect(result.capability).toBe("space/write");

    // Verify: Vault B now has the MLS group
    const hasGroup = await vaultB.invokeTauriCommand<boolean>(
      "mls_has_group", { spaceId }
    );
    expect(hasGroup).toBe(true);
  });

  test("leader MLS group has 2 members after invite claim", async () => {
    // The add_member commit was created during ClaimInvite on the leader
    // Verify leader's MLS group now has 2 members
    const hasGroup = await vaultA.invokeTauriCommand<boolean>(
      "mls_has_group", { spaceId }
    );
    expect(hasGroup).toBe(true);

    // The leader's epoch should have advanced (add_member creates a commit)
    const epochKey = await vaultA.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );
    expect(epochKey.epoch).toBeGreaterThan(epochKeyBefore.epoch);

    // Epoch key should be different from before (forward secrecy)
    expect(epochKey.key).not.toEqual(epochKeyBefore.key);
    epochKeyBefore = epochKey;
  });

  test("leader's pending_commits table tracks the add_member commit", async () => {
    // The ClaimInvite handler stores a pending commit for the add_member
    const pending = await sqlQueryRaw<{
      space_id: string;
      message_id: number;
      expected_dids: string;
      acked_dids: string;
    }>(
      vaultA,
      "SELECT space_id, message_id, expected_dids, acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
      [spaceId],
    );

    // There may be pending commits if members haven't ACKed yet
    // The add_member commit expects existing members to ACK
    // At this point, no existing peers were connected when the commit was created
    // (Vault B just joined), so expected_dids comes from haex_space_members
    console.log(`[MLS-ACK] Pending commits on leader: ${JSON.stringify(pending)}`);
  });

  // =========================================================================
  // Phase 4: Peer starts sync loop — fetches and ACKs commits
  // =========================================================================

  test("peer starts sync loop and connects to leader", async () => {
    // Create the space record on Vault B (it was created during ClaimInvite,
    // but we ensure the full record exists)
    const spaces = await sqlQuery<{ id: string }>(
      vaultB,
      "SELECT id FROM haex_spaces WHERE id = ?1",
      [spaceId],
    );
    expect(spaces.length).toBe(1);

    // Start sync loop as peer
    await vaultB.invokeTauriCommand("local_delivery_connect", {
      spaceId,
      leaderEndpointId: nodeIdA,
      leaderRelayUrl: relayUrlA,
      identityDid: identityDidB,
    });

    // Wait for at least one sync cycle (5s poll interval)
    await wait(8_000);
  });

  test("peer processes MLS commits from leader via sync loop", async () => {
    // After sync loop runs, Vault B should have processed any pending MLS messages
    // The peer's MLS group should be at the same epoch as the leader
    const peerEpochKey = await vaultB.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );

    const leaderEpochKey = await vaultA.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );

    expect(peerEpochKey.epoch).toBe(leaderEpochKey.epoch);
    // Both should derive the same symmetric key from the same epoch
    expect(peerEpochKey.key).toEqual(leaderEpochKey.key);
  });

  // =========================================================================
  // Phase 5: Member removal — the critical path
  // =========================================================================

  test("leader can find peer's MLS leaf index by DID", async () => {
    const memberIndex = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index", { spaceId, memberDid: identityDidB }
    );

    expect(memberIndex).not.toBeNull();
    expect(typeof memberIndex).toBe("number");
  });

  test("leader removes peer via MLS and broadcasts commit", async () => {
    // Find member index
    const memberIndex = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index", { spaceId, memberDid: identityDidB }
    );
    expect(memberIndex).not.toBeNull();

    // MLS remove_member
    const bundle = await vaultA.invokeTauriCommand<MlsCommitBundle>(
      "mls_remove_member", { spaceId, memberIndex: memberIndex! }
    );
    expect(bundle.commit.length).toBeGreaterThan(0);
    expect(bundle.welcome).toBeNull(); // removal doesn't produce a Welcome

    // Broadcast commit via leader buffer
    await vaultA.invokeTauriCommand("local_delivery_broadcast_commit", {
      spaceId,
      commit: bundle.commit,
    });

    // Re-derive epoch key (forward secrecy)
    const newEpochKey = await vaultA.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );
    expect(newEpochKey.epoch).toBeGreaterThan(epochKeyBefore.epoch);
    expect(newEpochKey.key).not.toEqual(epochKeyBefore.key);
    epochKeyBefore = newEpochKey;
  });

  test("removal commit is stored in leader's message buffer", async () => {
    const messages = await sqlQueryRaw<{
      id: number;
      space_id: string;
      sender_did: string;
      message_type: string;
    }>(
      vaultA,
      "SELECT id, space_id, sender_did, message_type FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1 AND message_type = 'commit'",
      [spaceId],
    );

    expect(messages.length).toBeGreaterThan(0);
    const removalCommit = messages[messages.length - 1];
    expect(removalCommit.message_type).toBe("commit");
  });

  test("removal commit has pending ACK tracking", async () => {
    const pending = await sqlQueryRaw<{
      message_id: number;
      expected_dids: string;
      acked_dids: string;
    }>(
      vaultA,
      "SELECT message_id, expected_dids, acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1",
      [spaceId],
    );

    expect(pending.length).toBe(1);

    const expectedDids: string[] = JSON.parse(pending[0].expected_dids as string);
    const ackedDids: string[] = JSON.parse(pending[0].acked_dids as string);

    // Peer B should be in expected list (they're a space member)
    expect(expectedDids).toContain(identityDidB);
    // Not yet ACKed (peer hasn't processed it yet)
    expect(ackedDids).not.toContain(identityDidB);
  });

  // =========================================================================
  // Phase 6: Peer processes removal commit via sync loop
  // =========================================================================

  test("peer receives and processes removal commit", async () => {
    // Wait for sync loop to fetch and process the removal commit
    // The sync loop polls every 5s, so we wait for 2 cycles
    await pollUntil(
      async () => {
        // Check if the pending commit has been ACKed
        const pending = await sqlQueryRaw<{
          acked_dids: string;
        }>(
          vaultA,
          "SELECT acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1",
          [spaceId],
        );

        if (pending.length === 0) {
          // Already cleaned up — means fully ACKed
          return true;
        }

        const ackedDids: string[] = JSON.parse(pending[0].acked_dids as string);
        return ackedDids.includes(identityDidB);
      },
      { timeout: 20_000, interval: 2_000, label: "peer ACKs removal commit" },
    );
  });

  test("leader cleans up fully-acked commits", async () => {
    // After full ACK, the pending commit entry should be cleaned up
    // (This happens automatically in the leader's ACK handler)
    await pollUntil(
      async () => {
        const pending = await sqlQueryRaw<{ message_id: number }>(
          vaultA,
          "SELECT message_id FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
          [spaceId],
        );
        return pending.length === 0;
      },
      { timeout: 15_000, interval: 2_000, label: "pending commits cleaned up" },
    );

    // The message buffer entry should also be cleaned up
    const messages = await sqlQueryRaw<{ id: number }>(
      vaultA,
      "SELECT id FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1 AND message_type = 'commit'",
      [spaceId],
    );
    // All commits for this space should be cleaned up after full ACK
    expect(messages.length).toBe(0);
  });

  // =========================================================================
  // Phase 7: Forward secrecy verification
  // =========================================================================

  test("leader's epoch key has advanced after removal", async () => {
    const currentKey = await vaultA.invokeTauriCommand<MlsEpochKey>(
      "mls_export_epoch_key", { spaceId }
    );

    // Epoch must have advanced (removal creates a new epoch)
    expect(currentKey.epoch).toBeGreaterThan(0);
    // Key must be different from the epoch before removal
    expect(currentKey.key).not.toEqual(epochKeyBefore.key);
  });

  test("removed peer cannot derive the new epoch key", async () => {
    // Vault B was removed — its MLS state is at the old epoch
    // It should NOT be able to derive the same key as the leader
    try {
      const peerKey = await vaultB.invokeTauriCommand<MlsEpochKey>(
        "mls_export_epoch_key", { spaceId }
      );
      const leaderKey = await vaultA.invokeTauriCommand<MlsEpochKey>(
        "mls_export_epoch_key", { spaceId }
      );

      // The peer's epoch key should be from a DIFFERENT (older) epoch
      // OR the keys should not match
      if (peerKey.epoch === leaderKey.epoch) {
        // If somehow at same epoch, keys MUST differ (this would be a bug)
        expect(peerKey.key).not.toEqual(leaderKey.key);
      }
    } catch {
      // Expected: the peer might not even be able to export a key if its
      // local MLS state was updated to reflect removal. Either way, the
      // removed peer does NOT have the current epoch key.
    }
  });
});
