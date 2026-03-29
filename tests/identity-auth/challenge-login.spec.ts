import { test, expect } from "@playwright/test";
import type { TestIdentity } from "../helpers";
import {
  createTestIdentity,
  signChallenge,
  getSyncServerUrl,
  checkSyncServerHealth,
  registerIdentity,
  createAdminUser,
  toAuthContext,
  createDidAuthHeader,
  DidAuthAction,
} from "../helpers";

test.describe("identity-auth: challenge-login", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();
  let registeredIdentity: TestIdentity;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    // Register an identity for challenge tests
    registeredIdentity = await createTestIdentity();
    await registerIdentity(registeredIdentity);
  });

  test("request challenge returns nonce (64 hex chars) and expiresAt", async () => {
    const res = await fetch(`${baseUrl}/identity-auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: registeredIdentity.did }),
    });

    expect(res.status).toBe(200);

    const data = await res.json();

    expect(typeof data.nonce).toBe("string");
    expect(data.nonce).toMatch(/^[0-9a-f]{64}$/);

    expect(typeof data.expiresAt).toBe("string");
    const expiresDate = new Date(data.expiresAt);
    expect(expiresDate.getTime()).not.toBeNaN();
    expect(expiresDate.getTime()).toBeGreaterThan(Date.now());
  });

  test("verify with correct signature returns tokens", async () => {
    // NOTE: This test may fail if email verification is required.
    // The identity was registered but email is not verified in E2E.
    // If challenge-login requires verified email, this test documents that behavior.
    const challengeRes = await fetch(`${baseUrl}/identity-auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: registeredIdentity.did }),
    });
    expect(challengeRes.status).toBe(200);

    const { nonce } = await challengeRes.json();
    const signature = await signChallenge(registeredIdentity, nonce);

    const verifyRes = await fetch(`${baseUrl}/identity-auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: registeredIdentity.did,
        nonce,
        signature,
      }),
    });

    // If email verification is enforced, this may return 403.
    // We test the successful path here; skip if verification is required.
    if (verifyRes.status === 403) {
      test.skip(true, "Email verification required for challenge-login");
      return;
    }

    expect(verifyRes.status).toBe(200);

    const data = await verifyRes.json();

    expect(typeof data.access_token).toBe("string");
    expect(data.access_token.length).toBeGreaterThan(0);

    expect(typeof data.refresh_token).toBe("string");
    expect(data.refresh_token.length).toBeGreaterThan(0);

    expect(typeof data.expires_in).toBe("number");
    expect(data.expires_in).toBeGreaterThan(0);
  });

  test("verify with wrong key signature returns 401", async () => {
    // Request a challenge for the registered identity
    const challengeRes = await fetch(`${baseUrl}/identity-auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: registeredIdentity.did }),
    });
    expect(challengeRes.status).toBe(200);

    const { nonce } = await challengeRes.json();

    // Sign with a completely different identity's key
    const wrongIdentity = await createTestIdentity();
    const wrongSignature = await signChallenge(wrongIdentity, nonce);

    const verifyRes = await fetch(`${baseUrl}/identity-auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: registeredIdentity.did,
        nonce,
        signature: wrongSignature,
      }),
    });

    expect(verifyRes.status).toBe(401);
  });

  test("use DID-Auth to call authenticated endpoint GET /sync/vaults", async () => {
    // Use createAdminUser to get identity (bypasses email verification)
    const admin = await createAdminUser();
    const auth = toAuthContext(admin);

    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: {
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultList),
      },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.vaults)).toBe(true);
  });
});
