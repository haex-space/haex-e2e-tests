import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  createTestIdentity,
  registerIdentity,
  challengeLogin,
  pushChanges,
  makeSyncChange,
  createRealtimeClient,
  subscribeToBroadcast,
  subscribeAndWait,
  waitForMessages,
  cleanupClient,
  getSupabaseUrl,
  getSupabaseAnonKey,
} from "../helpers";
import { createClient } from "@supabase/supabase-js";

/**
 * Tests for Realtime authentication lifecycle.
 *
 * These cover scenarios where authentication state affects Realtime:
 * - Valid token → subscription works
 * - No token / invalid token → subscription fails
 * - Token set after client creation → subscription works
 * - Token refresh during active subscription → stays connected
 */
test.describe("sync: realtime auth lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-auth-lifecycle-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, vaultId);
  });

  test("subscription succeeds with valid auth token", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    const { status, channel } = await subscribeAndWait(client, channelName);
    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });

  test("subscription fails without auth token", async () => {
    // Create client WITHOUT setting auth token
    const client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, detectSessionInUrl: false },
      realtime: { timeout: 5000 },
    });
    // Deliberately NOT calling client.realtime.setAuth()

    const channelName = `sync:${vaultId}`;

    const { status, channel } = await subscribeAndWait(client, channelName, undefined, 5000);

    await client.removeChannel(channel).catch(() => {});
    await cleanupClient(client);

    // Without auth, the channel should fail (private broadcast channels require auth)
    expect(status).not.toBe("SUBSCRIBED");
  });

  test("subscription works when token is set after client creation", async () => {
    // This simulates haex-vault's flow: client created first, token obtained via DID re-auth later
    const client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, detectSessionInUrl: false },
      realtime: { timeout: 10000, heartbeatIntervalMs: 5000 },
    });

    // Token set AFTER client creation (matches DID re-auth flow)
    client.realtime.setAuth(accessToken);

    const channelName = `sync:${vaultId}`;
    const { status, channel } = await subscribeAndWait(client, channelName);

    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });

  test("subscription works with freshly obtained token", async () => {
    // Simulates the scenario where a new DID challenge-login produces a fresh token
    const identity = await createTestIdentity();
    await registerIdentity(identity);

    // Confirm email via admin API
    const serviceKey =
      process.env.SUPABASE_SERVICE_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
    const anonKey = getSupabaseAnonKey();

    const listRes = await fetch(
      `${getSupabaseUrl()}/auth/v1/admin/users?page=1&per_page=50`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: anonKey } },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const users = listData.users || listData;
      const user = (users as { id: string; email: string }[]).find(
        (u) => u.email === identity.email,
      );
      if (user) {
        await fetch(`${getSupabaseUrl()}/auth/v1/admin/users/${user.id}`, {
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

    // Get a fresh token via challenge-login
    const tokens = await challengeLogin(identity);
    const freshVaultId = crypto.randomUUID();
    await createVaultKey(tokens.access_token, freshVaultId);

    // Subscribe with the fresh token
    const client = createRealtimeClient(tokens.access_token);
    const { status, channel } = await subscribeAndWait(client, `sync:${freshVaultId}`);

    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });

  test("active subscription survives token update via setAuth", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // Subscribe
    const collector = await subscribeToBroadcast(client, channelName);

    // Update the auth token while subscribed (simulates TOKEN_REFRESHED event)
    // In production, this happens when the JWT is refreshed
    client.realtime.setAuth(accessToken);

    // Push a change — subscription should still receive it
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "token-refresh-test" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
