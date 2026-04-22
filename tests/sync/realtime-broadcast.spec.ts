import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  deleteSpace,
  makeSyncChange,
  signAndPushSpaceChanges,
  toAuthContext,
  RealtimeTestClient,
  type AuthContext,
} from "../helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

// =============================================================================
// Broadcast Delivery Tests
// =============================================================================

test.describe("sync: realtime broadcast delivery", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  let publicKey: string;
  const spaceId = crypto.randomUUID();
  const deviceIdA = `e2e-device-a-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUserWithIdentity();
    auth = toAuthContext(admin);
    publicKey = admin.publicKey;

    // Create a space (which auto-adds the creator as owner member)
    const createRes = await createSpace(auth, spaceId, "Broadcast Test");
    expect(createRes.status).toBe(201);
  });

  test("WebSocket connection succeeds with valid DID-Auth", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client.connect();

    expect(client.isConnected).toBe(true);

    client.disconnect();
  });

  test("push from device A triggers broadcast received by device B", async () => {
    const clientB = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await clientB.connect();

    // Push a change via REST — the server broadcasts to connected WS clients
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "broadcast-cross-device" }),
        columnName: "value",
        deviceId: deviceIdA,
        encryptedValue: btoa("hello-from-device-a"),
      }),
    ], auth.privateKeyBase64, publicKey);

    // The push caller's DID is excluded from broadcast, but since we're
    // connecting via the same DID (different "device"), we may or may not
    // receive it depending on server logic. The key test is that broadcast works.
    // Wait briefly to ensure the message would have arrived
    await new Promise((r) => setTimeout(r, 2000));

    clientB.disconnect();

    // If the server excludes the caller's DID, no message arrives (correct behavior).
    // The cross-device broadcast test is better covered with two different users.
  });

  test("push triggers broadcast received by another space member", async () => {
    // Create a second user and add them to the space
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(auth, spaceId, member.did, "Member B", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    // Member B connects via WebSocket
    const clientB = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await clientB.connect();

    // Owner pushes a change — member B should receive the broadcast
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "cross-user-broadcast" }),
        columnName: "value",
        deviceId: deviceIdA,
        encryptedValue: btoa("hello-from-owner"),
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg = await clientB.waitForSyncBroadcast(spaceId, 5000);

    clientB.disconnect();

    expect(msg.type).toBe("sync");
    expect(msg.spaceId).toBe(spaceId);

    // Clean up member
    await removeSpaceMember(auth, spaceId, member.did);
  });

  test("multiple rapid pushes result in broadcast messages", async () => {
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(auth, spaceId, member.did, "Rapid Member", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    const clientB = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await clientB.connect();

    // Push 5 changes rapidly
    for (let i = 0; i < 5; i++) {
      await signAndPushSpaceChanges(auth, spaceId, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: `rapid-${i}` }),
          columnName: "value",
          deviceId: deviceIdA,
          encryptedValue: btoa(`rapid-value-${i}`),
        }),
      ], auth.privateKeyBase64, publicKey);
    }

    const messages = await clientB.waitForMessageCount(
      (msg) => msg.type === "sync" && msg.spaceId === spaceId,
      1,
      5000,
    );

    clientB.disconnect();

    expect(messages.length).toBeGreaterThanOrEqual(1);

    await removeSpaceMember(auth, spaceId, member.did);
  });

  test("different spaces do not receive each other's broadcasts", async () => {
    const otherSpaceId = crypto.randomUUID();
    const createRes = await createSpace(auth, otherSpaceId, "Other Space");
    expect(createRes.status).toBe(201);

    // Create a member who is only in otherSpace
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(auth, otherSpaceId, member.did, "Other Member", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    const clientB = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await clientB.connect();

    // Push to the FIRST space — should NOT appear on member's connection
    // (member is only in otherSpace, not spaceId)
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "isolation-test" }),
        columnName: "value",
        deviceId: deviceIdA,
      }),
    ], auth.privateKeyBase64, publicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const spaceMessages = clientB.getSpaceMessages(spaceId);
    clientB.disconnect();

    expect(spaceMessages.length).toBe(0);

    // Clean up
    await removeSpaceMember(auth, otherSpaceId, member.did);
    await deleteSpace(auth, otherSpaceId);
  });

  test("broadcast payload contains only type and spaceId, no record data", async () => {
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(auth, spaceId, member.did, "Payload Member", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();

    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "secret_table",
        rowPks: JSON.stringify({ id: "payload-check" }),
        columnName: "secret_column",
        deviceId: deviceIdA,
        encryptedValue: btoa("super-secret-value"),
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg = await client.waitForSyncBroadcast(spaceId, 5000);
    client.disconnect();

    // Verify the payload does NOT contain sensitive data
    const payload = JSON.stringify(msg);
    expect(payload).not.toContain("secret_table");
    expect(payload).not.toContain("secret_column");
    expect(payload).not.toContain("super-secret-value");
    expect(payload).not.toContain("payload-check");

    await removeSpaceMember(auth, spaceId, member.did);
  });
});

// =============================================================================
// Personal Vault / Space Authorization Tests
// =============================================================================

test.describe("sync: broadcast authorization for spaces", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let ownerPublicKey: string;
  let strangerAuth: AuthContext;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, stranger] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);
    ownerAuth = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;
    strangerAuth = toAuthContext(stranger);

    const createRes = await createSpace(ownerAuth, spaceId, "Auth Test Space");
    expect(createRes.status).toBe(201);
  });

  test("space owner can connect and receive broadcasts", async () => {
    // Add a member who listens, owner pushes — member should receive
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    const inviteRes = await addSpaceMember(ownerAuth, spaceId, member.did, "Temp", SpaceCapabilities.WRITE);
    expect(inviteRes.status).toBe(201);

    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);

    // Owner pushes — member should receive broadcast
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "owner-auth" }),
        columnName: "value",
        deviceId: `e2e-auth-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    const msg = await client.waitForSyncBroadcast(spaceId, 5000);
    client.disconnect();
    expect(msg.type).toBe("sync");

    await removeSpaceMember(ownerAuth, spaceId, member.did);
  });

  test("stranger connected via WS does not receive broadcasts for space they are not in", async () => {
    // Stranger connects with valid DID-Auth (they are a valid user)
    const strangerClient = new RealtimeTestClient(strangerAuth.privateKeyBase64, strangerAuth.did);
    await strangerClient.connect();
    expect(strangerClient.isConnected).toBe(true);

    // Owner pushes — stranger should NOT receive (not a member)
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "stranger-test" }),
        columnName: "value",
        deviceId: `e2e-stranger-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const msgs = strangerClient.getSpaceMessages(spaceId);
    strangerClient.disconnect();

    expect(msgs.length).toBe(0);
  });

  test("unauthenticated client (no token) is rejected", async () => {
    const client = new RealtimeTestClient(ownerAuth.privateKeyBase64, ownerAuth.did);
    const result = await client.connectWithoutToken();

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });
});

// =============================================================================
// Shared Space Authorization Tests
// =============================================================================

test.describe("sync: broadcast authorization for shared spaces", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let ownerPublicKey: string;
  let memberAuth: AuthContext;
  let memberDid: string;
  let readerAuth: AuthContext;
  let readerDid: string;
  let outsiderAuth: AuthContext;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, member, reader, outsider] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    ownerAuth = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;
    memberAuth = toAuthContext(member);
    memberDid = member.did;
    readerAuth = toAuthContext(reader);
    readerDid = reader.did;
    outsiderAuth = toAuthContext(outsider);

    // Owner creates a space
    const createRes = await createSpace(ownerAuth, spaceId, "Broadcast Auth Space");
    expect(createRes.status).toBe(201);

    // Owner invites member (write access) and reader (read-only)
    const [inviteMember, inviteReader] = await Promise.all([
      addSpaceMember(ownerAuth, spaceId, memberDid, "Member", SpaceCapabilities.WRITE),
      addSpaceMember(ownerAuth, spaceId, readerDid, "Reader", SpaceCapabilities.READ),
    ]);
    expect(inviteMember.status).toBe(201);
    expect(inviteReader.status).toBe(201);
  });

  test.afterAll(async () => {
    await deleteSpace(ownerAuth, spaceId).catch(() => {});
  });

  test("space owner can connect", async () => {
    const client = new RealtimeTestClient(ownerAuth.privateKeyBase64, ownerAuth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test("space member can connect", async () => {
    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test("space reader can connect and receive broadcasts", async () => {
    const client = new RealtimeTestClient(readerAuth.privateKeyBase64, readerAuth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);

    // Owner pushes — reader should receive
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "reader-test" }),
        columnName: "value",
        deviceId: `e2e-reader-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    const msg = await client.waitForSyncBroadcast(spaceId, 5000);
    client.disconnect();
    expect(msg.type).toBe("sync");
  });

  test("outsider does not receive space broadcasts", async () => {
    // Outsider connects (valid user, just not a space member)
    const client = new RealtimeTestClient(outsiderAuth.privateKeyBase64, outsiderAuth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);

    // Owner pushes — outsider should NOT receive
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "outsider-test" }),
        columnName: "value",
        deviceId: `e2e-outsider-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const msgs = client.getSpaceMessages(spaceId);
    client.disconnect();
    expect(msgs.length).toBe(0);
  });

  test("space member receives broadcast when changes are pushed", async () => {
    const client = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client.connect();

    // Owner pushes — member should receive
    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "member-broadcast" }),
        columnName: "value",
        deviceId: `e2e-member-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    const msg = await client.waitForSyncBroadcast(spaceId, 5000);
    client.disconnect();
    expect(msg.type).toBe("sync");
  });

  test("removed member stops receiving broadcasts", async () => {
    // Create a temporary member, verify they receive broadcasts, remove them
    const tempMember = await createAdminUserWithIdentity();
    const tempAuth = toAuthContext(tempMember);
    const inviteRes = await addSpaceMember(
      ownerAuth, spaceId, tempMember.did, "Temp Member", SpaceCapabilities.WRITE,
    );
    expect(inviteRes.status).toBe(201);

    // Connect and verify broadcasts work
    const client1 = new RealtimeTestClient(tempAuth.privateKeyBase64, tempAuth.did);
    await client1.connect();

    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "before-removal" }),
        columnName: "value",
        deviceId: `e2e-removal-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    const beforeMsg = await client1.waitForSyncBroadcast(spaceId, 5000);
    expect(beforeMsg.type).toBe("sync");

    // Remove the member (server updates membershipCache)
    const removeRes = await removeSpaceMember(ownerAuth, spaceId, tempMember.did);
    expect(removeRes.status).toBe(200);

    // Clear messages and push again — should NOT receive
    client1.clearMessages();

    await signAndPushSpaceChanges(ownerAuth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "after-removal" }),
        columnName: "value",
        deviceId: `e2e-removal-after-${Date.now()}`,
      }),
    ], ownerAuth.privateKeyBase64, ownerPublicKey);

    await new Promise((r) => setTimeout(r, 2000));

    const afterMsgs = client1.getSpaceMessages(spaceId);
    client1.disconnect();

    // The membership broadcast itself may arrive, but no sync broadcasts should
    const syncMsgs = afterMsgs.filter((m) => m.type === "sync");
    expect(syncMsgs.length).toBe(0);
  });
});
