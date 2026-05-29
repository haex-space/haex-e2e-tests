import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  createAdminUserWithIdentity,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  signAndPushSpaceChanges,
  makeSyncChange,
  toAuthContext,
  setupSyncTestWithSpace,
  RealtimeTestClient,
  type AuthContext,
} from "../helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

/**
 * Tests for WebSocket connection lifecycle management.
 *
 * The sync-server uses a simple WebSocket model:
 * - Connect with DID-Auth → server loads memberships
 * - Server broadcasts to all connected members
 * - Disconnect → cleanup
 *
 * These tests cover connect/disconnect/reconnect patterns and
 * ensure no resource leaks or stale state.
 */
test.describe("sync: realtime connection lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  let publicKey: string;
  const spaceId = crypto.randomUUID();
  const deviceId = `e2e-lifecycle-${Date.now()}`;

  test.beforeAll(async () => {
    ({ auth, publicKey } = await setupSyncTestWithSpace(
      spaceId,
      "Lifecycle Test Space",
    ));

    // Permanent member for broadcast tests (owner pushes, member receives).
    // Individual tests create their own per-test member for realtime clients;
    // this call ensures the space always has at least one member in the DB.
    const member = await createAdminUserWithIdentity();
    await addSpaceMember(auth, spaceId, member.did, "Lifecycle Member", SpaceCapabilities.WRITE);
  });

  test("disconnect closes the connection", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  test("reconnect after disconnect works", async () => {
    const client1 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);
    client1.disconnect();

    // Brief delay for server cleanup
    await new Promise((r) => setTimeout(r, 500));

    // New connection with fresh DID-Auth token
    const client2 = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client2.connect();
    expect(client2.isConnected).toBe(true);
    client2.disconnect();
  });

  test("messages only arrive while connected", async () => {
    // Create a member who listens for broadcasts, owner pushes
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(auth, spaceId, member.did, "Lifecycle Member", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    // Member connects to receive broadcasts
    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();

    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "while-connected" }),
        columnName: "value",
        deviceId,
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg = await client.waitForSyncBroadcast(spaceId, 5000);
    expect(msg.type).toBe("sync");
    const connectedCount = client.getMessages().length;
    expect(connectedCount).toBeGreaterThanOrEqual(1);

    // Disconnect
    client.disconnect();

    // Push while disconnected — cannot receive
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "while-disconnected" }),
        columnName: "value",
        deviceId,
      }),
    ], auth.privateKeyBase64, publicKey);

    await new Promise((r) => setTimeout(r, 1500));

    // Reconnect as member and verify new messages arrive
    const client2 = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client2.connect();

    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "after-reconnect" }),
        columnName: "value",
        deviceId,
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg2 = await client2.waitForSyncBroadcast(spaceId, 5000);
    expect(msg2.type).toBe("sync");
    client2.disconnect();

    await removeSpaceMember(auth, spaceId, member.did);
  });

  test("multiple concurrent connections from same DID work independently", async () => {
    // Create two members for two separate spaces
    const spaceId2 = crypto.randomUUID();
    const createRes = await createSpace(auth, spaceId2, "Second Space");
    expect(createRes.status).toBe(201);

    const member = await createAdminUserWithIdentity();
    await addSpaceMember(auth, spaceId, member.did, "Multi1", SpaceCapabilities.WRITE);
    await addSpaceMember(auth, spaceId2, member.did, "Multi2", SpaceCapabilities.WRITE);

    // Member opens two connections (same DID) to receive owner broadcasts
    const mAuth = toAuthContext(member);
    const client1 = new RealtimeTestClient(mAuth.privateKeyBase64, mAuth.did);
    const client2 = new RealtimeTestClient(mAuth.privateKeyBase64, mAuth.did);
    await client1.connect();
    await client2.connect();

    // Member pushes to space 1
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "multi-conn-1" }),
        columnName: "value",
        deviceId,
      }),
    ], auth.privateKeyBase64, publicKey);

    // Both connections should receive the broadcast
    const msg1 = await client1.waitForSyncBroadcast(spaceId, 5000);
    const msg2 = await client2.waitForSyncBroadcast(spaceId, 5000);

    expect(msg1.type).toBe("sync");
    expect(msg2.type).toBe("sync");

    client1.disconnect();
    client2.disconnect();

    await removeSpaceMember(auth, spaceId, member.did);
    await removeSpaceMember(auth, spaceId2, member.did);
  });

  test("multiple disconnect/reconnect cycles work reliably", async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
      await client.connect();
      expect(client.isConnected).toBe(true);
      client.disconnect();
      expect(client.isConnected).toBe(false);

      // Brief pause between cycles
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test("new client works after previous client was cleaned up", async () => {
    // Create member for broadcast testing
    const member = await createAdminUserWithIdentity();
    await addSpaceMember(auth, spaceId, member.did, "Cleanup Member", SpaceCapabilities.WRITE);

    // First client (member receives, owner pushes)
    const mAuth = toAuthContext(member);
    const client1 = new RealtimeTestClient(mAuth.privateKeyBase64, mAuth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);
    client1.disconnect();

    // Second client — should work without interference
    const client2 = new RealtimeTestClient(mAuth.privateKeyBase64, mAuth.did);
    await client2.connect();

    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "new-client-test" }),
        columnName: "value",
        deviceId,
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg = await client2.waitForSyncBroadcast(spaceId, 5000);
    client2.disconnect();
    expect(msg.type).toBe("sync");

    await removeSpaceMember(auth, spaceId, member.did);
  });
});
