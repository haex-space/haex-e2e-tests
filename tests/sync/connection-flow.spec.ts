import crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { AuthContext } from "../helpers";
import {
  checkSyncServerHealth,
  createAdminUser,
  pushChanges,
  pullChanges,
  makeSyncChange,
  deleteVault,
  toAuthContext,
  createDidAuthHeader,
  DidAuthAction,
} from "../helpers";
import {
  createRealtimeClient,
  subscribeToBroadcast,
  waitForMessages,
  cleanupClient,
} from "../helpers/realtime-helpers";

/**
 * End-to-end connection flow test.
 *
 * Simulates the full vault-to-server connection lifecycle:
 * 1. Register identity + authenticate
 * 2. Generate spaceId client-side
 * 3. Upload vault key (creates space via server transaction)
 * 4. Subscribe to realtime broadcast
 * 5. Push changes → verify broadcast received
 * 6. Pull changes → verify data roundtrip
 *
 * This test catches issues that individual API tests miss:
 * - Space creation as side-effect of vault-key upload
 * - Realtime subscription on a freshly created space
 * - Push/pull on a space created via vault-key (not via /spaces)
 */
test.describe("sync: full connection flow", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  const spaceId = crypto.randomUUID();
  const deviceId = `e2e-connection-flow-${Date.now()}`;
  const baseUrl = process.env.SYNC_SERVER_DIRECT_URL || "http://sync-server:3002";

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);
  });

  test.afterAll(async () => {
    try {
      await deleteVault(auth, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("register identity and authenticate", async () => {
    const admin = await createAdminUser();
    auth = toAuthContext(admin);
    expect(auth.did).toBeTruthy();
  });

  test("upload vault key creates space implicitly", async () => {
    // This mirrors what the vault client does:
    // POST /sync/vault-key with a client-generated spaceId
    // The server creates the space + vault key in a single transaction
    const bodyObj = {
      spaceId,
      encryptedVaultKey: crypto.randomBytes(32).toString("base64"),
      encryptedVaultName: Buffer.from("E2E Connection Flow Test").toString("base64"),
      vaultKeySalt: crypto.randomBytes(16).toString("base64"),
      ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
      vaultKeyNonce: crypto.randomBytes(12).toString("base64"),
      vaultNameNonce: crypto.randomBytes(12).toString("base64"),
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${baseUrl}/sync/vault-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultKeyUpload, bodyStr),
      },
      body: bodyStr,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.vaultKey.spaceId).toBe(spaceId);
  });

  test("vault key can be retrieved for the new space", async () => {
    const res = await fetch(`${baseUrl}/sync/vault-key/${spaceId}`, {
      headers: {
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultKeyGet),
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.vaultKey).toBeTruthy();
    expect(data.vaultKey.spaceId).toBe(spaceId);
  });

  test("realtime subscription works on freshly created space", async () => {
    const client = createRealtimeClient(auth.accessToken);
    const collector = await subscribeToBroadcast(client, `sync:${spaceId}`);

    expect(collector.channel).toBeTruthy();

    await client.removeChannel(collector.channel);
    await cleanupClient(client);
  });

  test("push changes to the new space", async () => {
    const result = await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "connection-flow-test-1" }),
        columnName: "value",
        deviceId,
      }),
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "connection-flow-test-2" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    expect(result.count).toBe(2);
    expect(result.serverTimestamp).toBeTruthy();
  });

  test("pull changes returns pushed data", async () => {
    const result = await pullChanges(auth, spaceId);

    expect(result.changes.length).toBe(2);
    expect(result.hasMore).toBe(false);

    const rowIds = result.changes.map((c) => c.rowPks).sort();
    expect(rowIds).toEqual([
      JSON.stringify({ id: "connection-flow-test-1" }),
      JSON.stringify({ id: "connection-flow-test-2" }),
    ]);
  });

  test("push triggers realtime broadcast to subscriber", async () => {
    const client = createRealtimeClient(auth.accessToken);
    const collector = await subscribeToBroadcast(client, `sync:${spaceId}`);

    // Push a new change while subscribed
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "broadcast-trigger-test" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("second user cannot access the vault space", async () => {
    const otherAdmin = await createAdminUser();
    const otherAuth = toAuthContext(otherAdmin);

    // Pull should return empty (RLS blocks access)
    const result = await pullChanges(otherAuth, spaceId);
    expect(result.changes.length).toBe(0);

    // Push should be rejected (403)
    await expect(
      pushChanges(otherAuth, spaceId, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: "unauthorized-push" }),
          columnName: "value",
          deviceId: "attacker-device",
        }),
      ]),
    ).rejects.toThrow(/403/);
  });

  test("duplicate vault key upload returns 409", async () => {
    const bodyObj = {
      spaceId,
      encryptedVaultKey: crypto.randomBytes(32).toString("base64"),
      encryptedVaultName: Buffer.from("Duplicate").toString("base64"),
      vaultKeySalt: crypto.randomBytes(16).toString("base64"),
      ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
      vaultKeyNonce: crypto.randomBytes(12).toString("base64"),
      vaultNameNonce: crypto.randomBytes(12).toString("base64"),
    };
    const bodyStr = JSON.stringify(bodyObj);

    const res = await fetch(`${baseUrl}/sync/vault-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultKeyUpload, bodyStr),
      },
      body: bodyStr,
    });

    expect(res.status).toBe(409);
  });
});
