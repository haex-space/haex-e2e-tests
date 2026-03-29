import { test, expect } from "@playwright/test";
import {
  createTestIdentity,
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  pushChanges,
  pullChanges,
  makeSyncChange,
  createDidAuthHeader,
  toAuthContext,
} from "../helpers";
import { DidAuthAction } from "@haex-space/ucan";

test.describe("identity-auth: DID-Auth lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);
  });

  test("DID-Auth header grants access to authenticated endpoints", async () => {
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);

    const authHeader = await createDidAuthHeader(
      auth.privateKeyBase64,
      auth.did,
      DidAuthAction.VaultList,
    );
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.vaults)).toBe(true);
  });

  test("invalid DID-Auth signature returns 401", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: "DID invalidpayload.invalidsignature" },
    });
    expect(res.status).toBe(401);
  });

  test("missing authorization header returns 401", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`);
    expect(res.status).toBe(401);
  });

  test("DID-Auth from unregistered identity returns 401", async () => {
    const identity = await createTestIdentity();
    const authHeader = await createDidAuthHeader(
      identity.privateKeyBase64,
      identity.did,
      DidAuthAction.VaultList,
    );
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: authHeader },
    });
    // Server returns 401 or 404 depending on where the DID lookup fails
    expect([401, 404]).toContain(res.status);
  });

  test("different identities have independent access", async () => {
    const admin1 = await createAdminUser();
    const admin2 = await createAdminUser();
    const auth1 = toAuthContext(admin1);
    const auth2 = toAuthContext(admin2);

    // Both identities can access
    for (const auth of [auth1, auth2]) {
      const authHeader = await createDidAuthHeader(
        auth.privateKeyBase64,
        auth.did,
        DidAuthAction.VaultList,
      );
      const res = await fetch(`${baseUrl}/sync/vaults`, {
        headers: { Authorization: authHeader },
      });
      expect(res.status).toBe(200);
    }
  });

  test("push and pull require valid DID-Auth", async () => {
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);
    const spaceId = crypto.randomUUID();

    // Create vault key first
    await createVaultKey(auth, spaceId);

    // Push with valid DID-Auth succeeds
    const pushRes = await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: crypto.randomUUID() }),
        columnName: "value",
        deviceId: `e2e-auth-test-${Date.now()}`,
      }),
    ]);
    expect(pushRes.count).toBeDefined();

    // Push with invalid auth fails
    const failRes = await fetch(`${baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "DID invalid.signature",
      },
      body: JSON.stringify({
        spaceId,
        changes: [makeSyncChange({ tableName: "test", rowPks: "{}", columnName: "c", deviceId: "d" })],
      }),
    });
    expect(failRes.status).toBe(401);

    // Pull with valid DID-Auth succeeds
    const pullRes = await pullChanges(auth, spaceId);
    expect(pullRes.changes).toBeDefined();

    // Pull with invalid auth fails
    const failPull = await fetch(`${baseUrl}/sync/pull?spaceId=${spaceId}&limit=10`, {
      headers: { Authorization: "DID invalid.signature" },
    });
    expect(failPull.status).toBe(401);
  });
});
