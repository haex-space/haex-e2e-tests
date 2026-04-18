/**
 * Evil Scenarios: Tests that verify the sync server correctly rejects
 * malicious, malformed, and unauthorized requests.
 *
 * These are NOT happy-path tests. Every test here should FAIL if security
 * checks are missing.
 */
import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { AuthContext } from "../helpers";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  pushChanges,
  pullChanges,
  makeSyncChange,
  toAuthContext,
  createDidAuthHeader,
  DidAuthAction,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("sync: evil scenarios", () => {
  test.describe.configure({ mode: "serial" });

  let victimAuth: AuthContext;
  let attackerAuth: AuthContext;
  const victimSpaceId = crypto.randomUUID();
  const attackerSpaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const victim = await createAdminUser();
    const attacker = await createAdminUser();
    victimAuth = toAuthContext(victim);
    attackerAuth = toAuthContext(attacker);

    await createVaultKey(victimAuth, victimSpaceId);
    await createVaultKey(attackerAuth, attackerSpaceId);

    // Victim pushes sensitive data
    await pushChanges(victimAuth, victimSpaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "secret-setting" }),
        columnName: "value",
        deviceId: "victim-device",
        encryptedValue: btoa("my-secret-password"),
      }),
    ]);
  });

  // =====================================================================
  // Cross-Vault Data Theft
  // =====================================================================

  test("attacker cannot pull from victim's vault", async () => {
    const res = await fetch(
      `${SYNC_SERVER_URL}/sync/pull?spaceId=${victimSpaceId}&limit=100`,
      {
        headers: {
          Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.SyncPull),
        },
      },
    );

    if (res.status === 200) {
      const data = await res.json();
      // If 200, RLS must filter out victim's data
      expect(data.changes.length).toBe(0);
    } else {
      // 403 is also acceptable
      expect(res.status).toBe(403);
    }
  });

  test("attacker cannot push to victim's vault", async () => {
    const bodyObj = {
      spaceId: victimSpaceId,
      changes: [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: "injected" }),
          columnName: "value",
          deviceId: "attacker-device",
          encryptedValue: btoa("pwned"),
        }),
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    // Must be rejected — attacker has no vault_key for victim's vault
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("attacker cannot delete victim's vault", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/sync/vault/${victimSpaceId}`, {
      method: "DELETE",
      headers: {
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.VaultDelete),
      },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Verify victim's vault still exists
    const pullRes = await pullChanges(victimAuth, victimSpaceId);
    expect(pullRes.changes.length).toBeGreaterThan(0);
  });

  test("attacker cannot read victim's vault key", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/sync/vaults`, {
      headers: {
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.VaultList),
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Attacker should only see their own vaults
    const victimVault = data.vaults.find(
      (v: { spaceId: string }) => v.spaceId === victimSpaceId,
    );
    expect(victimVault).toBeUndefined();
  });

  // =====================================================================
  // DID-Auth Manipulation
  // =====================================================================

  test("tampered DID-Auth payload is rejected", async () => {
    // Create a valid DID-Auth header then tamper with the payload
    const validHeader = await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.VaultList);
    const parts = validHeader.replace("DID ", "").split(".");
    // Tamper with the payload (change the DID to victim's)
    const payload = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    payload.did = victimAuth.did;
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedHeader = `DID ${tamperedPayload}.${parts[1]}`;

    const res = await fetch(`${SYNC_SERVER_URL}/sync/vaults`, {
      headers: { Authorization: tamperedHeader },
    });

    expect(res.status).toBe(401);
  });

  test("forged DID-Auth with wrong key is rejected", async () => {
    // Create a DID-Auth header signed by attacker but claiming to be victim
    const forgedHeader = await createDidAuthHeader(attackerAuth.privateKeyBase64, victimAuth.did, DidAuthAction.VaultList);

    const res = await fetch(`${SYNC_SERVER_URL}/sync/vaults`, {
      headers: { Authorization: forgedHeader },
    });

    expect(res.status).toBe(401);
  });

  // =====================================================================
  // Push Injection Attacks
  // =====================================================================

  test("SQL injection in table name is handled safely", async () => {
    const bodyObj = {
      spaceId: attackerSpaceId,
      changes: [
        makeSyncChange({
          tableName: "haex_vault_settings'; DROP TABLE sync_changes; --",
          rowPks: JSON.stringify({ id: "x" }),
          columnName: "value",
          deviceId: "attacker",
        }),
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    // Server must reject the malformed table name with a client error.
    // A 2xx or 500 would both indicate the injection payload was not properly rejected.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Verify sync_changes still exists by pulling
    const pullRes = await pullChanges(victimAuth, victimSpaceId);
    expect(pullRes.changes.length).toBeGreaterThan(0);
  });

  test("extremely large payload is rejected", async () => {
    const hugeValue = "x".repeat(10 * 1024 * 1024); // 10 MB

    const bodyObj = {
      spaceId: attackerSpaceId,
      changes: [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: "huge" }),
          columnName: "value",
          deviceId: "attacker",
          encryptedValue: hugeValue,
        }),
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    // Server must reject the oversized payload with a client error (e.g. 413, 400).
    // Must NOT crash (500) and must NOT silently accept.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("negative batchSeq is handled", async () => {
    const bodyObj = {
      spaceId: attackerSpaceId,
      changes: [
        {
          ...makeSyncChange({
            tableName: "haex_vault_settings",
            rowPks: JSON.stringify({ id: "batch-evil" }),
            columnName: "value",
            deviceId: "attacker",
          }),
          batchId: crypto.randomUUID(),
          batchSeq: -1,
          batchTotal: 1,
        },
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(attackerAuth.privateKeyBase64, attackerAuth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    // Negative batchSeq must be rejected with a client error, not silently accepted.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // CRDT Timestamp Manipulation
  // =====================================================================

  test("future timestamp does not break conflict resolution", async () => {
    // Push with a timestamp far in the future
    const futureTimestamp = "2099-12-31T23:59:59.999Z:99999999:evil-device";

    await pushChanges(attackerAuth, attackerSpaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "time-travel" }),
        columnName: "value",
        deviceId: "evil-device",
        hlcTimestamp: futureTimestamp,
        encryptedValue: btoa("future-value"),
      }),
    ]);

    // Now push with a normal timestamp — should NOT win (future timestamp wins LWW)
    await pushChanges(attackerAuth, attackerSpaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "time-travel" }),
        columnName: "value",
        deviceId: "normal-device",
        hlcTimestamp: `2026-03-21T12:00:00.000Z:00000001:normal-device`,
        encryptedValue: btoa("normal-value"),
      }),
    ]);

    // Pull — future timestamp should have won
    const pulled = await pullChanges(attackerAuth, attackerSpaceId);
    const change = pulled.changes.find(
      (c: { rowPks: string; columnName: string }) =>
        c.rowPks === JSON.stringify({ id: "time-travel" }) && c.columnName === "value",
    );
    expect(change).toBeDefined();
    expect(change!.encryptedValue).toBe(btoa("future-value"));
  });

  // =====================================================================
  // Concurrent Push Race
  // =====================================================================

  test("concurrent pushes to same vault from same user do not corrupt data", async () => {
    const spaceId = crypto.randomUUID();
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);
    await createVaultKey(auth, spaceId);

    // Push 10 changes concurrently
    const pushPromises = Array.from({ length: 10 }, (_, i) =>
      pushChanges(auth, spaceId, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: `concurrent-${i}` }),
          columnName: "value",
          deviceId: `device-${i}`,
          hlcTimestamp: `2026-03-21T14:00:0${i}.000Z:00000001:device-${i}`,
          encryptedValue: btoa(`value-${i}`),
        }),
      ]),
    );

    const results = await Promise.allSettled(pushPromises);

    // All should succeed (no corruption)
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBe(10);

    // Pull should return all 10 distinct rows
    const pulled = await pullChanges(auth, spaceId);
    const concurrentChanges = pulled.changes.filter(
      (c: { tableName: string; rowPks: string }) =>
        c.tableName === "haex_vault_settings" &&
        c.rowPks.includes("concurrent-"),
    );

    // Should have at least 10 changes (one per row × one column)
    const uniqueRows = new Set(concurrentChanges.map((c: { rowPks: string }) => c.rowPks));
    expect(uniqueRows.size).toBe(10);
  });

  // =====================================================================
  // 3+ Device CRDT Conflict
  // =====================================================================

  test("3 devices modify same cell — latest HLC wins", async () => {
    const spaceId = crypto.randomUUID();
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);
    await createVaultKey(auth, spaceId);

    const rowPks = JSON.stringify({ id: "3way-conflict" });

    // Device A: earliest
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "value",
        deviceId: "device-a",
        hlcTimestamp: "2026-03-21T10:00:00.000Z:00000001:device-a",
        encryptedValue: btoa("from-a"),
      }),
    ]);

    // Device C: latest (should win)
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "value",
        deviceId: "device-c",
        hlcTimestamp: "2026-03-21T12:00:00.000Z:00000001:device-c",
        encryptedValue: btoa("from-c"),
      }),
    ]);

    // Device B: middle (pushed last but earlier HLC — should NOT win)
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "value",
        deviceId: "device-b",
        hlcTimestamp: "2026-03-21T11:00:00.000Z:00000001:device-b",
        encryptedValue: btoa("from-b"),
      }),
    ]);

    // Pull — device C should win (latest HLC, not latest push)
    const pulled = await pullChanges(auth, spaceId);
    const conflict = pulled.changes.find(
      (c: { rowPks: string; columnName: string }) =>
        c.rowPks === rowPks && c.columnName === "value",
    );

    expect(conflict).toBeDefined();
    expect(conflict!.encryptedValue).toBe(btoa("from-c"));
    expect(conflict!.deviceId).toBe("device-c");
  });

  // =====================================================================
  // Tombstone Resurrection
  // =====================================================================

  test("deleted record can be resurrected with later timestamp", async () => {
    const spaceId = crypto.randomUUID();
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);
    await createVaultKey(auth, spaceId);

    const rowPks = JSON.stringify({ id: "phoenix" });

    // Create
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "value",
        deviceId: "device-1",
        hlcTimestamp: "2026-03-21T10:00:00.000Z:00000001:device-1",
        encryptedValue: btoa("alive"),
      }),
    ]);

    // Delete (tombstone)
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "haex_tombstone",
        deviceId: "device-1",
        hlcTimestamp: "2026-03-21T11:00:00.000Z:00000001:device-1",
        encryptedValue: btoa("1"),
      }),
    ]);

    // Resurrect with later timestamp (set tombstone back to 0)
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks,
        columnName: "haex_tombstone",
        deviceId: "device-2",
        hlcTimestamp: "2026-03-21T12:00:00.000Z:00000001:device-2",
        encryptedValue: btoa("0"),
      }),
    ]);

    // Pull — tombstone should be 0 (resurrected)
    const pulled = await pullChanges(auth, spaceId);
    const tombstone = pulled.changes.find(
      (c: { rowPks: string; columnName: string }) =>
        c.rowPks === rowPks && c.columnName === "haex_tombstone",
    );

    expect(tombstone).toBeDefined();
    expect(tombstone!.encryptedValue).toBe(btoa("0"));
  });
});
