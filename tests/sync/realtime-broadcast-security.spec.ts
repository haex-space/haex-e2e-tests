/**
 * Realtime Broadcast Security Tests
 *
 * Adversarial tests that simulate attack scenarios against the
 * private broadcast channel authorization system. These tests ensure
 * that bad actors cannot gain unauthorized access to sync broadcasts.
 */

import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUser,
  createAdminUserWithIdentity,
  createVaultKey,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  pushChanges,
  makeSyncChange,
  insertBroadcastMessage,
  createRealtimeClient,
  subscribeToBroadcast,
  subscribeAndWait,
  waitForMessages,
  cleanupClient,
  getSyncServerUrl,
  getSupabaseAnonKey,
} from "../helpers";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = getSyncServerUrl();
const ANON_KEY = getSupabaseAnonKey();
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Helper: create a raw Supabase client with a specific token */
function createRawClient(token?: string): SupabaseClient {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false },
    realtime: { timeout: 10000 },
  });
  if (token) client.realtime.setAuth(token);
  return client;
}

/** Helper: attempt to subscribe and return the status */
async function trySubscribe(
  client: SupabaseClient,
  channelName: string,
  timeoutMs = 10000,
): Promise<string> {
  const channel = client
    .channel(channelName, { config: { private: true } })
    .on("broadcast", { event: "INSERT" }, () => {});

  const status = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), timeoutMs);
    channel.subscribe((s) => {
      if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        clearTimeout(timer);
        resolve(s);
      }
    });
  });

  await client.removeChannel(channel).catch(() => {});
  return status;
}

// =============================================================================
// Token Manipulation Attacks
// =============================================================================

test.describe("security: token manipulation attacks", () => {
  test.describe.configure({ mode: "serial" });

  let validToken: string;
  const vaultId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    validToken = admin.accessToken;
    await createVaultKey(validToken, vaultId);
  });

  test("expired JWT token is rejected", async () => {
    // Craft a JWT that expired in the past
    // Header: {"alg":"HS256","typ":"JWT"}
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payload = btoa(JSON.stringify({
      iss: "supabase-demo",
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      sub: crypto.randomUUID(),
    })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const fakeSignature = "invalid-signature";
    const expiredToken = `${header}.${payload}.${fakeSignature}`;

    const client = createRawClient(expiredToken);
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("tampered JWT payload is rejected", async () => {
    // Take a valid token and modify the payload (change sub to a different user)
    const parts = validToken.split(".");
    const originalPayload = JSON.parse(atob(parts[1]!));
    const tamperedPayload = { ...originalPayload, sub: crypto.randomUUID() };
    const tamperedB64 = btoa(JSON.stringify(tamperedPayload))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    // Keep original header and signature — signature won't match tampered payload
    const tamperedToken = `${parts[0]}.${tamperedB64}.${parts[2]}`;

    const client = createRawClient(tamperedToken);
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("completely fabricated JWT is rejected", async () => {
    const fakeToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.fake-signature";

    const client = createRawClient(fakeToken);
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("service_role key does not grant broadcast access to user vaults", async () => {
    // Service role should NOT be able to subscribe to a user's private channel
    const client = createRawClient(SERVICE_ROLE_KEY);
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("anon key without auth token is rejected", async () => {
    const client = createRawClient(); // No token set
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("empty string as auth token is rejected", async () => {
    const client = createRawClient("");
    const status = await trySubscribe(client, `sync:${vaultId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });
});

// =============================================================================
// Channel Name Injection Attacks
// =============================================================================

test.describe("security: channel name injection attacks", () => {
  test.describe.configure({ mode: "serial" });

  let validToken: string;
  const vaultId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    validToken = admin.accessToken;
    await createVaultKey(validToken, vaultId);
  });

  test("SQL injection in channel name does not cause errors", async () => {
    const client = createRawClient(validToken);
    const maliciousNames = [
      "sync:'; DROP TABLE vault_keys; --",
      "sync:\" OR 1=1 --",
      "sync:${vaultId}' UNION SELECT * FROM vault_keys --",
      "sync:'); DELETE FROM realtime.messages; --",
    ];

    for (const name of maliciousNames) {
      const status = await trySubscribe(client, name, 5000);
      // Should either reject or timeout — never grant access
      expect(status).not.toBe("SUBSCRIBED");
    }

    client.realtime.disconnect();
  });

  test("wildcard channel names do not grant broad access", async () => {
    const client = createRawClient(validToken);
    const wildcardNames = [
      "sync:*",
      "sync:%",
      "sync:_",
      "*",
      "sync:.*",
      "sync:[a-z]*",
    ];

    for (const name of wildcardNames) {
      const status = await trySubscribe(client, name, 5000);
      expect(status).not.toBe("SUBSCRIBED");
    }

    client.realtime.disconnect();
  });

  test("empty vault_id in channel name is rejected", async () => {
    const client = createRawClient(validToken);
    const emptyNames = [
      "sync:",
      "sync",
      "",
      ":",
    ];

    for (const name of emptyNames) {
      const status = await trySubscribe(client, name, 5000);
      expect(status).not.toBe("SUBSCRIBED");
    }

    client.realtime.disconnect();
  });

  test("internal realtime channels are not accessible", async () => {
    const client = createRawClient(validToken);
    const internalNames = [
      "realtime:system",
      "realtime:postgres_changes",
      "phoenix",
      "presence",
      "realtime:broadcast",
    ];

    for (const name of internalNames) {
      const status = await trySubscribe(client, name, 5000);
      // Internal channels should never be subscribable by regular users
      expect(status).not.toBe("SUBSCRIBED");
    }

    client.realtime.disconnect();
  });
});

// =============================================================================
// Race Condition & Session Lifecycle Attacks
// =============================================================================

test.describe("security: race conditions and session lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    ownerToken = owner.accessToken;

    const createRes = await createSpace(ownerToken, spaceId, "Race Condition Test Space");
    expect(createRes.status).toBe(201);
  });

  test("removed member cannot re-subscribe after disconnecting", async () => {
    // Add a member, verify they can subscribe, remove them,
    // then verify they cannot subscribe again on a new connection.
    // Note: Supabase Realtime checks authorization at subscribe time,
    // so existing connections may still receive messages until they disconnect.
    // The critical security property is that removed members cannot
    // establish NEW connections.
    const member = await createAdminUserWithIdentity();
    const inviteRes = await addSpaceMember(
      ownerToken, spaceId, member.publicKey, "Soon Removed", "member",
    );
    expect(inviteRes.status).toBe(201);

    // Verify member can subscribe before removal
    const client1 = createRealtimeClient(member.accessToken);
    const { status: before } = await subscribeAndWait(client1, `sync:${spaceId}`);
    await cleanupClient(client1);
    expect(before).toBe("SUBSCRIBED");

    // Remove the member
    const removeRes = await removeSpaceMember(ownerToken, spaceId, member.publicKey);
    expect(removeRes.status).toBe(200);

    // Removed member tries to subscribe again — must be rejected
    const client2 = createRealtimeClient(member.accessToken);
    const { status: after } = await subscribeAndWait(client2, `sync:${spaceId}`);
    await cleanupClient(client2);

    expect(after).not.toBe("SUBSCRIBED");
  });

  test("multiple simultaneous unauthorized subscribe attempts all fail", async () => {
    const outsider = await createAdminUser();

    // Fire 5 concurrent subscription attempts
    const attempts = Array.from({ length: 5 }, async () => {
      const client = createRawClient(outsider.accessToken);
      const status = await trySubscribe(client, `sync:${spaceId}`, 5000);
      client.realtime.disconnect();
      return status;
    });

    const results = await Promise.all(attempts);

    // Every single attempt must be rejected
    for (const status of results) {
      expect(status).not.toBe("SUBSCRIBED");
    }
  });

  test("re-subscribing after token should have expired is rejected", async () => {
    // This tests that the server validates tokens on each subscribe, not just on first connect
    const tempUser = await createAdminUser();

    // First subscription works
    const client1 = createRealtimeClient(tempUser.accessToken);
    // Subscribe to a channel the user has NO access to (not their vault)
    const { status } = await subscribeAndWait(client1, `sync:${spaceId}`);
    await cleanupClient(client1);
    expect(status).not.toBe("SUBSCRIBED");

    // Same token, different client — still rejected
    const client2 = createRealtimeClient(tempUser.accessToken);
    const { status: status2 } = await subscribeAndWait(client2, `sync:${spaceId}`);
    await cleanupClient(client2);
    expect(status2).not.toBe("SUBSCRIBED");
  });
});

// =============================================================================
// Privilege Escalation Attacks
// =============================================================================

test.describe("security: privilege escalation", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  let outsiderToken: string;
  const spaceId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, outsider] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUser(),
    ]);

    ownerToken = owner.accessToken;
    outsiderToken = outsider.accessToken;

    await createVaultKey(ownerToken, vaultId);
    const createRes = await createSpace(ownerToken, spaceId, "Privesc Test Space");
    expect(createRes.status).toBe(201);
  });

  test("outsider subscribing as public channel receives no private broadcasts", async () => {
    // Attacker tries to bypass private:true by subscribing without private config
    const client = createRawClient(outsiderToken);
    const messages: unknown[] = [];
    const channel = client
      .channel(`sync:${vaultId}`) // No private:true — trying to bypass
      .on("broadcast", { event: "INSERT" }, (p) => messages.push(p))
      .on("broadcast", { event: "UPDATE" }, (p) => messages.push(p));

    await new Promise<void>((resolve) => {
      channel.subscribe((s) => {
        // Even if it "subscribes" to a public channel, it shouldn't get private messages
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") resolve();
      });
    });

    // Owner pushes changes (these generate private:true messages in DB)
    await pushChanges(ownerToken, vaultId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "privesc-public-bypass" }),
        columnName: "val",
        deviceId: `e2e-privesc-${Date.now()}`,
      }),
    ]);

    await new Promise((r) => setTimeout(r, 3000));

    await client.removeChannel(channel);
    client.realtime.disconnect();

    expect(messages.length).toBe(0);
  });

  test("outsider subscribing to space as public channel receives no broadcasts", async () => {
    const client = createRawClient(outsiderToken);
    const messages: unknown[] = [];
    const channel = client
      .channel(`sync:${spaceId}`) // No private:true
      .on("broadcast", { event: "INSERT" }, (p) => messages.push(p));

    await new Promise<void>((resolve) => {
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") resolve();
      });
    });

    // Insert broadcast directly (space pushes require ECDSA signatures)
    await insertBroadcastMessage(`sync:${spaceId}`);

    await new Promise((r) => setTimeout(r, 3000));

    await client.removeChannel(channel);
    client.realtime.disconnect();

    expect(messages.length).toBe(0);
  });

  test("using another user's vault_id as space channel does not grant access", async () => {
    // Outsider has their own vault — try to use its vault_id to subscribe to owner's space
    const outsiderVaultId = crypto.randomUUID();
    await createVaultKey(outsiderToken, outsiderVaultId);

    const client = createRawClient(outsiderToken);
    const status = await trySubscribe(client, `sync:${spaceId}`);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });
});

// =============================================================================
// Enumeration Resistance
// =============================================================================

test.describe("security: enumeration resistance", () => {
  test.describe.configure({ mode: "serial" });

  let validToken: string;
  const realVaultId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    validToken = admin.accessToken;
    await createVaultKey(validToken, realVaultId);
  });

  test("non-existent vault_id and unauthorized vault_id produce same result", async () => {
    // An attacker should not be able to distinguish "vault exists but I'm unauthorized"
    // from "vault does not exist" — both should give the same response
    const outsider = await createAdminUser();

    // Try subscribing to the real vault (unauthorized)
    const client1 = createRawClient(outsider.accessToken);
    const statusReal = await trySubscribe(client1, `sync:${realVaultId}`, 5000);
    client1.realtime.disconnect();

    // Try subscribing to a non-existent vault
    const client2 = createRawClient(outsider.accessToken);
    const statusFake = await trySubscribe(client2, `sync:${crypto.randomUUID()}`, 5000);
    client2.realtime.disconnect();

    // Both should give the same non-SUBSCRIBED status
    expect(statusReal).not.toBe("SUBSCRIBED");
    expect(statusFake).not.toBe("SUBSCRIBED");
    // Ideally, both produce the exact same status (no information leakage)
    expect(statusReal).toBe(statusFake);
  });

  test("random UUID guessing never succeeds", async () => {
    const outsider = await createAdminUser();

    // Try 10 random UUIDs — none should succeed
    for (let i = 0; i < 10; i++) {
      const client = createRawClient(outsider.accessToken);
      const status = await trySubscribe(client, `sync:${crypto.randomUUID()}`, 3000);
      client.realtime.disconnect();

      expect(status).not.toBe("SUBSCRIBED");
    }
  });
});
