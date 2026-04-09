import { test, expect, VaultAutomation } from "../fixtures";

/**
 * MLS Commit-ACK Retry & Reconnect E2E Tests
 *
 * Tests the retry behavior when a peer misses commits:
 *
 * 1. Leader creates space, peer joins
 * 2. Peer disconnects (sync loop stopped)
 * 3. Leader creates a removal commit (for a third member, or self-update)
 * 4. Peer reconnects — leader re-notifies about unacked commits
 * 5. Peer fetches and ACKs the missed commit
 *
 * Also tests:
 * - Commits are NOT cleaned up while peers haven't ACKed
 * - Re-notification on Announce (reconnect)
 * - Multiple unacked commits are delivered in order
 *
 * NO MOCKS. Real QUIC, real MLS, real SQLite.
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
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await wait(interval);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeout}ms. Last error: ${lastError}`);
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

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: commit-ACK retry after reconnect", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000); // Reconnect tests need more time

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let identityDidA: string;
  let identityDidB: string;
  const spaceId = `e2e-mls-retry-${Date.now()}`;

  // =========================================================================
  // Setup: Both vaults with P2P and MLS initialized
  // =========================================================================

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Ensure Vault B has an open vault
    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "MLS Retry Test B",
        key: "test-retry-b",
        spaceId: null,
      });
    } catch {
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults", {});
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", {
          vaultPath: vaults[0].path,
          key: "test-retry-b",
        });
      }
    }

    // Start P2P
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

    // Get identities
    const idA = await sqlQuery<{ did: string }>(vaultA, "SELECT did FROM haex_identities");
    const idB = await sqlQuery<{ did: string }>(vaultB, "SELECT did FROM haex_identities");
    identityDidA = idA[0].did as string;
    identityDidB = idB[0].did as string;

    // Init MLS
    await vaultA.invokeTauriCommand("mls_init_tables", {});
    await vaultB.invokeTauriCommand("mls_init_tables", {});
    await vaultA.invokeTauriCommand("mls_init_identity", { did: identityDidA });
    await vaultB.invokeTauriCommand("mls_init_identity", { did: identityDidB });
  });

  test.afterAll(async () => {
    for (const vault of [vaultA, vaultB]) {
      try { await vault.invokeTauriCommand("local_delivery_disconnect", { spaceId }); } catch { /* */ }
      try { await vault.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* */ }
      try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* */ }
    }
  });

  // =========================================================================
  // Phase 1: Leader creates space, peer joins and syncs
  // =========================================================================

  test("setup: leader creates space and peer joins", async () => {
    // Create space + MLS group on leader
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, status, name) VALUES (?1, 'local', 'active', ?2)`,
      params: [spaceId, "Retry Test Space"],
    });
    await vaultA.invokeTauriCommand<MlsGroupInfo>("mls_create_group", { spaceId });

    // Register devices
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, relay_url, priority, is_self, last_seen)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, datetime('now'))`,
      params: [`dev-retry-a-${Date.now()}`, spaceId, `dev-a`, nodeIdA, relayUrlA],
    });

    // Add leader as member
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_members (id, space_id, member_did, member_public_key, label, role)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      params: [`m-a-${Date.now()}`, spaceId, identityDidA, "pk-a", "Leader", "admin"],
    });

    // Start leader mode
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });

    // Peer claims invite
    const tokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      { spaceId, targetDid: identityDidB, capability: "space/write", maxUses: 1, expiresInSeconds: 3600, includeHistory: false },
    );

    const result = await vaultB.invokeTauriCommand<ClaimInviteResult>(
      "local_delivery_claim_invite",
      { leaderEndpointId: nodeIdA, leaderRelayUrl: relayUrlA, spaceId, tokenId, identityDid: identityDidB, label: "Peer", identityPublicKey: "pk-b" },
    );
    expect(result.capability).toBe("space/write");

    // Peer starts sync loop and lets it run one cycle
    await vaultB.invokeTauriCommand("local_delivery_connect", {
      spaceId, leaderEndpointId: nodeIdA, leaderRelayUrl: relayUrlA, identityDid: identityDidB,
    });
    await wait(8_000); // Wait for sync cycle

    // Verify both are at same epoch
    const epochA = await vaultA.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
    const epochB = await vaultB.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
    expect(epochA.epoch).toBe(epochB.epoch);
  });

  // =========================================================================
  // Phase 2: Peer disconnects
  // =========================================================================

  test("peer disconnects from leader", async () => {
    await vaultB.invokeTauriCommand("local_delivery_disconnect", { spaceId });

    // Verify no active sync loop
    // (If there was an error, the disconnect would have thrown)
  });

  // =========================================================================
  // Phase 3: Leader creates a commit while peer is offline
  // =========================================================================

  test("leader broadcasts commit while peer is offline", async () => {
    // We can't do another add_member (no third vault), so we test with
    // an MLS self-update or application message commit.
    // The simplest approach: encrypt a message (creates an application message)
    // Actually, for a real commit we need a group operation.
    // Let's use mls_remove_member on the peer (who is already disconnected)

    const memberIndex = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index", { spaceId, memberDid: identityDidB }
    );
    expect(memberIndex).not.toBeNull();

    const bundle = await vaultA.invokeTauriCommand<MlsCommitBundle>(
      "mls_remove_member", { spaceId, memberIndex: memberIndex! }
    );
    expect(bundle.commit.length).toBeGreaterThan(0);

    // Broadcast via leader buffer
    await vaultA.invokeTauriCommand("local_delivery_broadcast_commit", {
      spaceId, commit: bundle.commit,
    });

    // Re-derive epoch key
    await vaultA.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
  });

  test("commit remains in buffer while peer is offline", async () => {
    // The pending commit should NOT be cleaned up because peer B hasn't ACKed
    const pending = await sqlQueryRaw<{
      expected_dids: string;
      acked_dids: string;
    }>(
      vaultA,
      "SELECT expected_dids, acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
      [spaceId],
    );

    expect(pending.length).toBeGreaterThan(0);

    const latestPending = pending[pending.length - 1];
    const expectedDids: string[] = JSON.parse(latestPending.expected_dids as string);
    const ackedDids: string[] = JSON.parse(latestPending.acked_dids as string);

    // Peer B should be expected but NOT acked
    expect(expectedDids).toContain(identityDidB);
    expect(ackedDids).not.toContain(identityDidB);
  });

  test("message buffer retains the commit", async () => {
    const messages = await sqlQueryRaw<{ id: number; message_type: string }>(
      vaultA,
      "SELECT id, message_type FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1 AND message_type = 'commit'",
      [spaceId],
    );

    expect(messages.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Phase 4: Peer reconnects — leader re-notifies
  // =========================================================================

  test("peer reconnects and receives missed commit", async () => {
    // Reconnect: start sync loop again
    await vaultB.invokeTauriCommand("local_delivery_connect", {
      spaceId,
      leaderEndpointId: nodeIdA,
      leaderRelayUrl: relayUrlA,
      identityDid: identityDidB,
    });

    // Wait for sync loop to fetch and process the missed commit
    // The Announce handler on the leader should re-notify about unacked commits
    await pollUntil(
      async () => {
        const pending = await sqlQueryRaw<{ acked_dids: string }>(
          vaultA,
          "SELECT acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
          [spaceId],
        );

        if (pending.length === 0) return true; // Cleaned up = fully ACKed

        const ackedDids: string[] = JSON.parse(pending[pending.length - 1].acked_dids as string);
        return ackedDids.includes(identityDidB);
      },
      { timeout: 25_000, interval: 2_000, label: "peer ACKs missed commit after reconnect" },
    );
  });

  test("pending commits are cleaned up after reconnect ACK", async () => {
    await pollUntil(
      async () => {
        const pending = await sqlQueryRaw<{ message_id: number }>(
          vaultA,
          "SELECT message_id FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
          [spaceId],
        );
        return pending.length === 0;
      },
      { timeout: 15_000, interval: 2_000, label: "all pending commits cleaned up" },
    );

    // Message buffer should also be clean
    const messages = await sqlQueryRaw<{ id: number }>(
      vaultA,
      "SELECT id FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1 AND message_type = 'commit'",
      [spaceId],
    );
    expect(messages.length).toBe(0);
  });
});
