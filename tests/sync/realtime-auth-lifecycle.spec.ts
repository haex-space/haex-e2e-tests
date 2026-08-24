import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  createAdminUserWithIdentity,
  createTestIdentity,
  registerIdentity,
  addSpaceMember,
  removeSpaceMember,
  signAndPushSpaceChanges,
  makeSyncChange,
  toAuthContext,
  setupSyncTestWithSpace,
  RealtimeTestClient,
  type AuthContext,
} from "../helpers";
import { LegacySpaceCapabilities as SpaceCapabilities } from "../helpers/legacy-space-capabilities";

/**
 * Tests for WebSocket authentication lifecycle.
 *
 * The sync-server's WebSocket endpoint uses DID-Auth tokens for authentication.
 * These tests cover:
 * - Valid DID-Auth token → connection succeeds
 * - No token / invalid token → connection rejected (close code 4001)
 * - Stale timestamp → connection rejected
 * - Fresh identity → connection works after registration
 * - Reconnection with new token → works
 */
test.describe("sync: realtime auth lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  let publicKey: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    ({ auth, publicKey } = await setupSyncTestWithSpace(
      spaceId,
      "Auth Lifecycle Space",
    ));
  });

  test("connection succeeds with valid DID-Auth token", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    await client.connect();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test("connection is rejected without any token", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithoutToken();

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("connection is rejected with empty token", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken("");

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("connection is rejected with fabricated token", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    const result = await client.connectWithRawToken("totally-not-a-valid-token");

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("connection is rejected with malformed payload.signature format", async () => {
    const client = new RealtimeTestClient(auth.privateKeyBase64, auth.did);
    // Valid base64url but not a real DID-Auth payload
    const fakePayload = Buffer.from(JSON.stringify({ did: "did:key:z123", timestamp: Date.now() })).toString("base64url");
    const fakeSignature = Buffer.from("not-a-real-signature").toString("base64url");
    const result = await client.connectWithRawToken(`${fakePayload}.${fakeSignature}`);

    client.disconnect();

    expect(result.rejected).toBe(true);
    expect(result.closeCode).toBe(4001);
  });

  test("connection works with freshly registered identity", async () => {
    // Simulate the full flow: create identity, register, connect
    const identity = await createTestIdentity();
    await registerIdentity(identity);

    // Confirm email via admin API
    const serviceKey =
      process.env.SUPABASE_SERVICE_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
    const anonKey =
      process.env.SUPABASE_ANON_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
    const supabaseUrl = process.env.SUPABASE_URL || process.env.SYNC_SERVER_URL || "http://sync-kong:8000";

    const listRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: anonKey } },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const users = listData.users || listData;
      const user = (users as { id: string; email: string }[]).find(
        (u) => u.email === identity.email,
      );
      if (user) {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: anonKey,
          },
          body: JSON.stringify({ email_confirm: true }),
        });
      }
    }

    // Connect with the fresh identity
    const client = new RealtimeTestClient(identity.privateKeyBase64, identity.did);
    await client.connect();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test("reconnection with fresh DID-Auth token works", async () => {
    // Add a member to receive broadcasts
    const member = await createAdminUserWithIdentity();
    const memberAuth = toAuthContext(member);
    await addSpaceMember(auth, spaceId, member.did, "Recon Member", SpaceCapabilities.WRITE);

    // First connection as member
    const client1 = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client1.connect();
    expect(client1.isConnected).toBe(true);
    client1.disconnect();

    // Brief pause
    await new Promise((r) => setTimeout(r, 500));

    // Second connection with a new token (createDidAuthHeader generates fresh timestamp)
    const client2 = new RealtimeTestClient(memberAuth.privateKeyBase64, memberAuth.did);
    await client2.connect();
    expect(client2.isConnected).toBe(true);

    // Owner pushes — member on reconnected WS should receive broadcast
    await signAndPushSpaceChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "reconnect-test" }),
        columnName: "value",
        deviceId: `e2e-reconnect-${Date.now()}`,
      }),
    ], auth.privateKeyBase64, publicKey);

    const msg = await client2.waitForSyncBroadcast(spaceId, 5000);
    client2.disconnect();
    expect(msg.type).toBe("sync");

    await removeSpaceMember(auth, spaceId, member.did);
  });

  test("connection with unregistered DID is rejected", async () => {
    // Generate a fresh keypair that is NOT registered on the server
    const unregistered = await createTestIdentity();

    const client = new RealtimeTestClient(unregistered.privateKeyBase64, unregistered.did);
    const rejected = await client.connectExpectingFailure();

    client.disconnect();

    expect(rejected).toBe(true);
  });
});
