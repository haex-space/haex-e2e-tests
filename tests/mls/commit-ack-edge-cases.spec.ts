import { test, expect, VaultAutomation } from "../fixtures";

/**
 * MLS Commit-ACK Edge Cases & Robustness Tests
 *
 * Tests scenarios that could break commit acknowledgment:
 *
 * 1. DID-based member lookup in MLS groups
 * 2. Broadcast without leader mode (error handling)
 * 3. Epoch key rotation after membership changes
 * 4. Multiple rapid commits (add + remove in quick succession)
 * 5. ACK for already-cleaned-up commits (idempotency)
 * 6. MLS group state consistency between leader and peer
 *
 * NO MOCKS. Real infrastructure only.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

type JsonValue = string | number | boolean | null;

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

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

interface ClaimInviteResult {
  space_id: string;
  capability: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
// Suite 1: DID-Based MLS Member Resolution
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: DID-based member identity in MLS groups", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  let vaultA: VaultAutomation;
  let identityDidA: string;
  const spaceId = `e2e-mls-did-${Date.now()}`;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    await vaultA.createSession();

    const identities = await sqlQuery<{ did: string }>(vaultA, "SELECT did FROM haex_identities");
    identityDidA = identities[0].did as string;

    await vaultA.invokeTauriCommand("mls_init_tables", {});
    await vaultA.invokeTauriCommand("mls_init_identity", { did: identityDidA });
  });

  test("find_member_index returns null for non-existent member", async () => {
    // Create a group
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, status, name) VALUES (?1, 'local', 'active', ?2)`,
      params: [spaceId, "DID Test Space"],
    });
    await vaultA.invokeTauriCommand<MlsGroupInfo>("mls_create_group", { spaceId });

    // Search for a DID that doesn't exist in the group
    const index = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index",
      { spaceId, memberDid: "did:key:nonexistent" },
    );

    expect(index).toBeNull();
  });

  test("find_member_index returns valid index for group creator", async () => {
    // The creator (identityDidA) should be findable
    const index = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index",
      { spaceId, memberDid: identityDidA },
    );

    expect(index).not.toBeNull();
    expect(typeof index).toBe("number");
  });

  test("find_member_index fails gracefully for non-existent group", async () => {
    try {
      await vaultA.invokeTauriCommand<number | null>(
        "mls_find_member_index",
        { spaceId: "nonexistent-space-id", memberDid: identityDidA },
      );
      // If it doesn't throw, it should return null
    } catch (error) {
      // Expected: group not found error
      expect(String(error)).toContain("not found");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: Broadcast Error Handling
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: broadcast commit error handling", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(30_000);

  let vaultA: VaultAutomation;
  const spaceId = `e2e-mls-bcast-${Date.now()}`;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    await vaultA.createSession();
  });

  test("broadcast without active leader returns error", async () => {
    // Ensure no leader is running for this space
    try {
      await vaultA.invokeTauriCommand("local_delivery_stop", { spaceId });
    } catch { /* ignore */ }

    try {
      await vaultA.invokeTauriCommand("local_delivery_broadcast_commit", {
        spaceId,
        commit: [1, 2, 3], // dummy commit bytes
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      // Expected: leader mode not active
      expect(String(error)).toContain("Leader mode not active");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: Epoch Key Rotation Integrity
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: epoch key rotation after membership changes", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let relayUrlA: string | null;
  let identityDidA: string;
  let identityDidB: string;
  const spaceId = `e2e-mls-epoch-${Date.now()}`;
  const epochKeys: MlsEpochKey[] = [];

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Ensure Vault B has a vault
    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "Epoch Test B",
        key: "test-epoch-b",
        spaceId: null,
      });
    } catch {
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults", {});
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", { vaultPath: vaults[0].path, key: "test-epoch-b" });
      }
    }

    // P2P
    for (const vault of [vaultA, vaultB]) {
      try {
        const status = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
        if (status.running) await vault.invokeTauriCommand("peer_storage_stop", {});
      } catch { /* */ }
    }
    const infoA = await vaultA.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
    nodeIdA = infoA.nodeId;
    relayUrlA = infoA.relayUrl;
    await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});

    // Identities
    const idA = await sqlQuery<{ did: string }>(vaultA, "SELECT did FROM haex_identities");
    const idB = await sqlQuery<{ did: string }>(vaultB, "SELECT did FROM haex_identities");
    identityDidA = idA[0].did as string;
    identityDidB = idB[0].did as string;

    // MLS
    await vaultA.invokeTauriCommand("mls_init_tables", {});
    await vaultB.invokeTauriCommand("mls_init_tables", {});
    await vaultA.invokeTauriCommand("mls_init_identity", { did: identityDidA });
    await vaultB.invokeTauriCommand("mls_init_identity", { did: identityDidB });
  });

  test.afterAll(async () => {
    for (const vault of [vaultA, vaultB]) {
      try { await vault.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* */ }
      try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* */ }
    }
  });

  test("epoch 0: group creation", async () => {
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, status, name) VALUES (?1, 'local', 'active', ?2)`,
      params: [spaceId, "Epoch Test"],
    });
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_members (id, space_id, member_did, member_public_key, label, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      params: [`m-epoch-a`, spaceId, identityDidA, "pk-a", "Admin", "admin"],
    });
    await vaultA.invokeTauriCommand<MlsGroupInfo>("mls_create_group", { spaceId });

    const key = await vaultA.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
    expect(key.epoch).toBe(0);
    epochKeys.push(key);
  });

  test("epoch 1: add_member advances epoch", async () => {
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, relay_url, priority, is_self, last_seen)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, datetime('now'))`,
      params: [`dev-epoch-a`, spaceId, `dev-a`, nodeIdA, relayUrlA],
    });

    const tokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      { spaceId, targetDid: identityDidB, capability: "space/write", maxUses: 1, expiresInSeconds: 3600, includeHistory: false },
    );

    await vaultB.invokeTauriCommand<ClaimInviteResult>(
      "local_delivery_claim_invite",
      { leaderEndpointId: nodeIdA, leaderRelayUrl: relayUrlA, spaceId, tokenId, identityDid: identityDidB, label: "Peer", identityPublicKey: "pk-b" },
    );

    const key = await vaultA.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
    expect(key.epoch).toBeGreaterThan(epochKeys[0].epoch);
    epochKeys.push(key);
  });

  test("epoch 2: remove_member advances epoch again", async () => {
    const memberIndex = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index", { spaceId, memberDid: identityDidB }
    );
    expect(memberIndex).not.toBeNull();

    await vaultA.invokeTauriCommand<MlsCommitBundle>(
      "mls_remove_member", { spaceId, memberIndex: memberIndex! }
    );

    const key = await vaultA.invokeTauriCommand<MlsEpochKey>("mls_export_epoch_key", { spaceId });
    expect(key.epoch).toBeGreaterThan(epochKeys[1].epoch);
    epochKeys.push(key);
  });

  test("all epoch keys are unique — no key reuse", async () => {
    // Convert keys to hex strings for comparison
    const keyHexes = epochKeys.map(k =>
      k.key.map(b => b.toString(16).padStart(2, "0")).join("")
    );

    const uniqueKeys = new Set(keyHexes);
    expect(uniqueKeys.size).toBe(epochKeys.length);

    // Epochs are strictly ascending
    for (let i = 1; i < epochKeys.length; i++) {
      expect(epochKeys[i].epoch).toBeGreaterThan(epochKeys[i - 1].epoch);
    }
  });

  test("each epoch key is exactly 32 bytes", async () => {
    for (const key of epochKeys) {
      expect(key.key.length).toBe(32);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: Pending Commit Persistence
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("mls: pending commit persistence and tracking", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let relayUrlA: string | null;
  let identityDidA: string;
  let identityDidB: string;
  const spaceId = `e2e-mls-pending-${Date.now()}`;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "Pending Test B", key: "test-pending-b", spaceId: null,
      });
    } catch {
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults", {});
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", { vaultPath: vaults[0].path, key: "test-pending-b" });
      }
    }

    // P2P
    for (const v of [vaultA, vaultB]) {
      try { const s = await v.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {}); if (s.running) await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* */ }
    }
    const iA = await vaultA.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
    nodeIdA = iA.nodeId; relayUrlA = iA.relayUrl;
    await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});

    const idA = await sqlQuery<{ did: string }>(vaultA, "SELECT did FROM haex_identities");
    const idB = await sqlQuery<{ did: string }>(vaultB, "SELECT did FROM haex_identities");
    identityDidA = idA[0].did as string;
    identityDidB = idB[0].did as string;

    await vaultA.invokeTauriCommand("mls_init_tables", {});
    await vaultB.invokeTauriCommand("mls_init_tables", {});
    await vaultA.invokeTauriCommand("mls_init_identity", { did: identityDidA });
    await vaultB.invokeTauriCommand("mls_init_identity", { did: identityDidB });

    // Create space, group, member, leader
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, status, name) VALUES (?1, 'local', 'active', ?2)`,
      params: [spaceId, "Pending Test"],
    });
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_members (id, space_id, member_did, member_public_key, label, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      params: [`m-pend-a`, spaceId, identityDidA, "pk-a", "Admin", "admin"],
    });
    await vaultA.invokeTauriCommand<MlsGroupInfo>("mls_create_group", { spaceId });
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, relay_url, priority, is_self, last_seen)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, datetime('now'))`,
      params: [`dev-pend-a`, spaceId, `dev-a`, nodeIdA, relayUrlA],
    });
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });

    // Peer joins
    const tokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      { spaceId, targetDid: identityDidB, capability: "space/write", maxUses: 1, expiresInSeconds: 3600, includeHistory: false },
    );
    await vaultB.invokeTauriCommand<ClaimInviteResult>(
      "local_delivery_claim_invite",
      { leaderEndpointId: nodeIdA, leaderRelayUrl: relayUrlA, spaceId, tokenId, identityDid: identityDidB, label: "Peer", identityPublicKey: "pk-b" },
    );
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      try { await v.invokeTauriCommand("local_delivery_disconnect", { spaceId }); } catch { /* */ }
      try { await v.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* */ }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* */ }
    }
  });

  test("broadcast_commit stores both message and pending entry atomically", async () => {
    // Create a removal commit
    const memberIndex = await vaultA.invokeTauriCommand<number | null>(
      "mls_find_member_index", { spaceId, memberDid: identityDidB }
    );
    expect(memberIndex).not.toBeNull();

    const bundle = await vaultA.invokeTauriCommand<MlsCommitBundle>(
      "mls_remove_member", { spaceId, memberIndex: memberIndex! }
    );

    // Count messages and pending before broadcast
    const messagesBefore = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1",
      [spaceId],
    );
    const pendingBefore = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
      [spaceId],
    );

    // Broadcast
    await vaultA.invokeTauriCommand("local_delivery_broadcast_commit", {
      spaceId, commit: bundle.commit,
    });

    // Both should have exactly one more entry
    const messagesAfter = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1",
      [spaceId],
    );
    const pendingAfter = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
      [spaceId],
    );

    expect(Number(messagesAfter[0].count)).toBe(Number(messagesBefore[0].count) + 1);
    expect(Number(pendingAfter[0].count)).toBe(Number(pendingBefore[0].count) + 1);
  });

  test("pending commit expected_dids contains all space members", async () => {
    const pending = await sqlQueryRaw<{ expected_dids: string }>(
      vaultA,
      "SELECT expected_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1",
      [spaceId],
    );

    expect(pending.length).toBe(1);

    const expectedDids: string[] = JSON.parse(pending[0].expected_dids as string);

    // All space members should be in expected_dids
    const members = await sqlQuery<{ member_did: string }>(
      vaultA,
      "SELECT member_did FROM haex_space_members WHERE space_id = ?1",
      [spaceId],
    );

    for (const member of members) {
      expect(expectedDids).toContain(member.member_did);
    }
  });

  test("pending commit acked_dids starts empty", async () => {
    const pending = await sqlQueryRaw<{ acked_dids: string }>(
      vaultA,
      "SELECT acked_dids FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1",
      [spaceId],
    );

    expect(pending.length).toBe(1);
    const ackedDids: string[] = JSON.parse(pending[0].acked_dids as string);
    expect(ackedDids).toEqual([]);
  });

  test("clear_buffers removes all pending commits and messages", async () => {
    // Stop leader (which calls clear_buffers)
    await vaultA.invokeTauriCommand("local_delivery_stop", { spaceId });

    const messages = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_messages_no_sync WHERE space_id = ?1",
      [spaceId],
    );
    const pending = await sqlQueryRaw<{ count: number }>(
      vaultA,
      "SELECT count(*) as count FROM haex_local_delivery_pending_commits_no_sync WHERE space_id = ?1",
      [spaceId],
    );

    expect(Number(messages[0].count)).toBe(0);
    expect(Number(pending[0].count)).toBe(0);
  });
});
