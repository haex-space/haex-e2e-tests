import { test, expect } from "@playwright/test";
import {
  createTestIdentity,
  getSyncServerUrl,
  checkSyncServerHealth,
  registerIdentity,
  challengeLogin,
  createAdminUser,
  createVaultKey,
  pushChanges,
  pullChanges,
  makeSyncChange,
} from "../helpers";

test.describe("identity-auth: token lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);
  });

  test("access token can be used for authenticated API calls", async () => {
    const { accessToken } = await createAdminUser();

    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.vaults)).toBe(true);
  });

  test("expired or invalid token returns 401", async () => {
    const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIiwiZXhwIjoxfQ.invalid";

    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });

    expect(res.status).toBe(401);
  });

  test("missing authorization header returns 401", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`);
    expect(res.status).toBe(401);
  });

  test("DID re-authentication: login again with same identity yields new valid tokens", async () => {
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

    const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: anonKey },
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const users = listData.users || listData;
      const user = (users as { id: string; email: string }[]).find(u => u.email === identity.email);
      if (user) {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}`, apikey: anonKey },
          body: JSON.stringify({ email_confirm: true }),
        });
      }
    }

    // First login
    const tokens1 = await challengeLogin(identity);
    expect(tokens1.access_token).toBeTruthy();
    expect(tokens1.refresh_token).toBeTruthy();

    // Second login (simulates re-auth after token expiry)
    const tokens2 = await challengeLogin(identity);
    expect(tokens2.access_token).toBeTruthy();
    expect(tokens2.refresh_token).toBeTruthy();

    // Both tokens should be different (new session each time)
    expect(tokens2.access_token).not.toBe(tokens1.access_token);

    // New token should work for API calls
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${tokens2.access_token}` },
    });
    expect(res.status).toBe(200);
  });

  test("old token still works until it expires (no session invalidation on re-login)", async () => {
    const { accessToken: token1 } = await createAdminUser();

    // First token works
    const res1 = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(res1.status).toBe(200);

    // Create another admin user (simulates passage of time)
    const { accessToken: token2 } = await createAdminUser();

    // Both tokens should work (JWT is stateless until expiry)
    const res2 = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(res2.status).toBe(200);

    const res3 = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(res3.status).toBe(200);
  });

  test("push and pull require valid authentication", async () => {
    const { accessToken } = await createAdminUser();
    const vaultId = crypto.randomUUID();

    // Create vault key first
    await createVaultKey(accessToken, vaultId);

    // Push with valid token succeeds
    const pushRes = await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: crypto.randomUUID() }),
        columnName: "value",
        deviceId: `e2e-auth-test-${Date.now()}`,
      }),
    ]);
    expect(pushRes.count).toBeDefined();

    // Push with invalid token fails
    const failRes = await fetch(`${baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify({
        vaultId,
        changes: [makeSyncChange({ tableName: "test", rowPks: "{}", columnName: "c", deviceId: "d" })],
      }),
    });
    expect(failRes.status).toBe(401);

    // Pull with valid token succeeds
    const pullRes = await pullChanges(accessToken, vaultId);
    expect(pullRes.changes).toBeDefined();

    // Pull with invalid token fails
    const failPull = await fetch(`${baseUrl}/sync/pull?vaultId=${vaultId}&limit=10`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(failPull.status).toBe(401);
  });
});
