/**
 * Realtime Broadcast Security Tests
 *
 * Adversarial tests that simulate attack scenarios against the
 * WebSocket-based realtime system. These tests ensure that bad actors
 * cannot gain unauthorized access to sync broadcasts.
 *
 * The sync-server uses DID-Auth for WebSocket authentication and
 * server-side membership checks for broadcast authorization.
 */

import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  createTestIdentity,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  signAndPushSpaceChanges,
  makeSyncChange,
  toAuthContext,
  RealtimeTestClient,
  type AuthContext,
} from "../helpers";

// =============================================================================
// Token Manipulation Attacks
// =============================================================================

test.describe("security: token manipulation attacks", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUserWithIdentity();
    auth = toAuthContext(admin);

    const createRes = await createSpace(auth, spaceId, "Security Test Space");
    expect(createRes.status).toBe(201);
  });

  test("completely fabricated token is rejected", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken("totally-fake-token");

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("token with valid format but wrong signature is rejected", async () => {
    // Create a payload that looks right but sign it with a different key
    const otherIdentity = await createTestIdentity();
    const fakePayload = Buffer.from(JSON.stringify({
      did: auth.did, // Claim to be the real user
      action: "ws-connect",
      timestamp: Date.now(),
      bodyHash: Buffer.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(""))),
      ).toString("base64url"),
    })).toString("base64url");
    // Sign with wrong key
    const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");
    const wrongKey = await importUserPrivateKeyAsync(otherIdentity.privateKeyBase64);
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", wrongKey, new TextEncoder().encode(fakePayload)),
    );
    const fakeToken = `${fakePayload}.${Buffer.from(signature).toString("base64url")}`;

    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken(fakeToken);

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("token with wrong action field is rejected", async () => {
    // Create a properly signed token but with action != 'ws-connect'
    const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");
    const privateKey = await importUserPrivateKeyAsync(auth.privateKeyBase64);
    const bodyHash = Buffer.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(""))),
    ).toString("base64url");

    const payload = JSON.stringify({
      did: auth.did,
      action: "wrong-action",
      timestamp: Date.now(),
      bodyHash,
    });
    const payloadEncoded = Buffer.from(payload).toString("base64url");
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payloadEncoded)),
    );
    const token = `${payloadEncoded}.${Buffer.from(signature).toString("base64url")}`;

    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken(token);

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("empty string as token is rejected", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken("");

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("no token at all is rejected", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithoutToken();

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("unregistered DID with valid signature is rejected", async () => {
    // Create a valid Ed25519 keypair but do NOT register the identity
    const unregistered = await createTestIdentity();

    const client = new RealtimeTestClient(unregistered.privateKeyBase64, unregistered.did);
    const rejected = await client.connectExpectingFailure();

    client.disconnect();

    expect(rejected).toBe(true);
  });
});

// =============================================================================
// Race Condition & Session Lifecycle Attacks
// =============================================================================

test.describe("security: race conditions and session lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let ownerPublicKey: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    ownerAuth = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;

    const createRes = await createSpace(ownerAuth, spaceId, "Race Condition Test Space");
    expect(createRes.status).toBe(201);
  });

  test("removed member stops receiving broadcasts on active connection", async () => {
    // Add a member, connect, verify broadcasts, remove, verify no more broadcasts
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(
      ownerAuth, spaceId, member.publicKey, "Soon Removed", "member",
    );
    expect(inviteRes.status).toBe(201);

    // Member connects
    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();

    // Verify member receives broadcasts before removal
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "before-remove" }),
        columnName: "value",
        deviceId: `e2e-race-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    const beforeMsg = await client.waitForSyncBroadcast(spaceId, 5000);
    expect(beforeMsg.type).toBe("sync");

    // Remove the member
    const removeRes = await removeSpaceMember(ownerAuth, spaceId, member.publicKey);
    expect(removeRes.status).toBe(200);

    // Clear and push again — removed member should NOT receive sync broadcasts
    client.clearMessages();

    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "after-remove" }),
        columnName: "value",
        deviceId: `e2e-race-after-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const syncMsgs = client.getMessages().filter((m) => m.type === "sync");
    client.disconnect();

    expect(syncMsgs.length).toBe(0);
  });

  test("removed member cannot reconnect and receive broadcasts", async () => {
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(
      ownerAuth, spaceId, member.publicKey, "Removed Then Reconnect", "member",
    );
    expect(inviteRes.status).toBe(201);

    // Verify initial connection works
    const client1 = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);
    client1.disconnect();

    // Remove the member
    const removeRes = await removeSpaceMember(ownerAuth, spaceId, member.publicKey);
    expect(removeRes.status).toBe(200);

    // Reconnect — the connection itself may succeed (user is still registered),
    // but broadcasts for this space should not arrive
    const client2 = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client2.connect();

    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "after-remove-reconnect" }),
        columnName: "value",
        deviceId: `e2e-reconnect-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const msgs = client2.getSpaceMessages(spaceId);
    client2.disconnect();

    expect(msgs.length).toBe(0);
  });

  test("multiple simultaneous connections from outsider receive no broadcasts", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // Open 3 concurrent connections
    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const client = new RealtimeTestClient(outsiderAuth.privateKeyBase64, outsiderAuth.did);
        await client.connect();
        return client;
      }),
    );

    // Owner pushes — none of the outsider connections should receive
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "multi-outsider" }),
        columnName: "value",
        deviceId: `e2e-multi-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    for (const client of clients) {
      const msgs = client.getSpaceMessages(spaceId);
      client.disconnect();
      expect(msgs.length).toBe(0);
    }
  });
});

// =============================================================================
// Privilege Escalation Attacks
// =============================================================================

test.describe("security: privilege escalation", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let ownerPublicKey: string;
  let outsiderAuth: AuthContext;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, outsider] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    ownerAuth = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;
    outsiderAuth = toAuthContext(outsider);

    const createRes = await createSpace(ownerAuth, spaceId, "Privesc Test Space");
    expect(createRes.status).toBe(201);
  });

  test("outsider with own space does not receive broadcasts from other spaces", async () => {
    // Outsider creates their own space
    const outsiderSpaceId = crypto.randomUUID();
    const createRes = await createSpace(outsiderAuth, outsiderSpaceId, "Outsider Space");
    expect(createRes.status).toBe(201);

    // Outsider connects — valid user with their own space
    const client = new RealtimeTestClient(outsiderAuth.privateKeyBase64, outsiderAuth.did);
    await client.connect();

    // Owner pushes to their space — outsider should NOT receive
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "privesc-test" }),
        columnName: "val",
        deviceId: `e2e-privesc-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const msgs = client.getSpaceMessages(spaceId);
    client.disconnect();

    expect(msgs.length).toBe(0);
  });
});

// =============================================================================
// Enumeration Resistance
// =============================================================================

test.describe("security: enumeration resistance", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let ownerPublicKey: string;
  const realSpaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    ownerAuth = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;

    const createRes = await createSpace(ownerAuth, realSpaceId, "Enum Test Space");
    expect(createRes.status).toBe(201);
  });

  test("outsider cannot determine if a space exists by connecting", async () => {
    // The WS endpoint does not have subscribe/unsubscribe — the connection itself
    // succeeds for any valid user. Space membership is checked server-side during broadcast.
    // An outsider should get the same experience regardless of whether a space exists.
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // Connect (valid user, not a member of either space)
    const client = new RealtimeTestClient(outsiderAuth.privateKeyBase64, outsiderAuth.did);
    await client.connect();

    // Owner pushes to real space
    await signAndPushSpaceChanges(ownerAuth, realSpaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "enum-test" }),
        columnName: "value",
        deviceId: `e2e-enum-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    // Outsider receives nothing — cannot distinguish real space from non-existent
    const realMsgs = client.getSpaceMessages(realSpaceId);
    const fakeMsgs = client.getSpaceMessages(crypto.randomUUID());

    client.disconnect();

    expect(realMsgs.length).toBe(0);
    expect(fakeMsgs.length).toBe(0);
    // Both return the same result — no information leakage
    expect(realMsgs.length).toBe(fakeMsgs.length);
  });
});
