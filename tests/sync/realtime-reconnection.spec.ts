import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  signAndPushSpaceChanges,
  makeSyncChange,
  toAuthContext,
  RealtimeTestClient,
  type AuthContext,
} from "../helpers";

/**
 * Tests for WebSocket reconnection behavior.
 *
 * With the plain WebSocket model, each connection uses a fresh DID-Auth token.
 * Reconnection means creating a new WebSocket connection (the server loads
 * memberships fresh on each connect). These tests ensure:
 * - Disconnect → reconnect with new token works
 * - Messages are receivable after reconnection
 * - Multiple disconnect/reconnect cycles are reliable
 */
test.describe("sync: realtime reconnection", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  const spaceId = crypto.randomUUID();
  const deviceId = `e2e-reconnect-${Date.now()}`;

  // Member identity for triggering broadcasts
  let memberAuth: AuthContext;
  let memberPublicKey: string;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUserWithIdentity();
    auth = toAuthContext(admin);

    const createRes = await createSpace(auth, spaceId, "Reconnection Test Space");
    expect(createRes.status).toBe(201);

    // Create a permanent member to push changes (so owner receives broadcasts)
    const member = await createAdminUserWithIdentity();
    memberAuth = toAuthContext(member);
    memberPublicKey = member.publicKey;
    const inviteRes = await addSpaceMember(auth, spaceId, memberPublicKey, "Recon Member", "member");
    expect(inviteRes.status).toBe(201);
  });

  test.afterAll(async () => {
    await removeSpaceMember(auth, spaceId, memberPublicKey).catch(() => {});
  });

  test("can reconnect after explicit disconnect", async () => {
    // First connection
    const client1 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);

    // Disconnect
    client1.disconnect();
    expect(client1.isConnected).toBe(false);

    // Wait for server-side cleanup
    await new Promise((r) => setTimeout(r, 500));

    // Reconnect with fresh DID-Auth token
    const client2 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client2.connect();
    expect(client2.isConnected).toBe(true);

    client2.disconnect();
  });

  test("receives messages after reconnection", async () => {
    // Connect, then disconnect
    const client1 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client1.connect();
    client1.disconnect();

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 500));

    // Reconnect
    const client2 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client2.connect();

    // Push a change — should arrive via the reconnected client
    await signAndPushSpaceChanges(memberAuth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "after-reconnect" }),
        columnName: "value",
        deviceId,
        encryptedValue: btoa("reconnected-value"),
      }),
    ], memberAuth.privateKeyBase64, memberPublicKey);

    const msg = await client2.waitForSyncBroadcast(spaceId, 5000);
    client2.disconnect();

    expect(msg.type).toBe("sync");
    expect(msg.spaceId).toBe(spaceId);
  });

  test("multiple disconnect/reconnect cycles work reliably", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
      await client.connect();
      expect(client.isConnected).toBe(true);

      // Verify message delivery on each cycle
      await signAndPushSpaceChanges(memberAuth, spaceId, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: `cycle-${cycle}` }),
          columnName: "value",
          deviceId,
        }),
      ], memberAuth.privateKeyBase64, memberPublicKey);

      const msg = await client.waitForSyncBroadcast(spaceId, 5000);
      expect(msg.type).toBe("sync");

      client.disconnect();
      expect(client.isConnected).toBe(false);

      // Brief pause between cycles
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test("new client works after previous client was cleaned up", async () => {
    // First client
    const client1 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);
    client1.disconnect();

    // Second client — completely independent instance
    const client2 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client2.connect();

    await signAndPushSpaceChanges(memberAuth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "new-client-test" }),
        columnName: "value",
        deviceId,
      }),
    ], memberAuth.privateKeyBase64, memberPublicKey);

    const msg = await client2.waitForSyncBroadcast(spaceId, 5000);
    client2.disconnect();

    expect(msg.type).toBe("sync");
  });

  test("messages pushed during disconnect are not delivered (no queuing)", async () => {
    // Connect and verify
    const client1 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client1.connect();
    client1.disconnect();

    // Push while disconnected
    await signAndPushSpaceChanges(memberAuth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "during-disconnect" }),
        columnName: "value",
        deviceId,
      }),
    ], memberAuth.privateKeyBase64, memberPublicKey);

    await new Promise((r) => setTimeout(r, 500));

    // Reconnect — should NOT receive the message from while disconnected
    const client2 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client2.connect();

    // Wait briefly to see if any stale messages arrive
    await new Promise((r) => setTimeout(r, 1500));

    const msgs = client2.getSpaceMessages(spaceId);
    client2.disconnect();

    // No messages should have been queued and delivered
    expect(msgs.length).toBe(0);
  });
});
