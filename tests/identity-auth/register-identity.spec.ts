import { test, expect } from "@playwright/test";
import {
  createTestIdentity,
  signPresentation,
  getSyncServerUrl,
  checkSyncServerHealth,
  registerIdentity,
} from "../helpers";

test.describe("identity-auth: register-identity", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);
  });

  test("GET /identity-auth/requirements returns valid structure", async () => {
    const res = await fetch(`${baseUrl}/identity-auth/requirements`);
    expect(res.status).toBe(200);

    const data = await res.json();

    expect(typeof data.serverName).toBe("string");
    expect(data.serverName.length).toBeGreaterThan(0);

    // claims is an array of objects: { type, required, label }
    expect(Array.isArray(data.claims)).toBe(true);
    const claimTypes = data.claims.map((c: { type: string }) => c.type);
    expect(claimTypes).toContain("email");

    expect(Array.isArray(data.didMethods)).toBe(true);
    expect(data.didMethods).toContain("did:key");

    expect(typeof data.serverTime).toBe("string");
    // serverTime should be a valid ISO date
    const serverDate = new Date(data.serverTime);
    expect(serverDate.getTime()).not.toBeNaN();
  });

  test("register new identity returns 201 with verification_pending", async () => {
    const identity = await createTestIdentity();
    const result = await registerIdentity(identity);

    expect(typeof result.identityId).toBe("string");
    expect(result.identityId.length).toBeGreaterThan(0);
    expect(result.did).toBe(identity.did);
    expect(result.status).toBe("verification_pending");
  });

  test("reject duplicate DID with 409", async () => {
    const identity = await createTestIdentity();

    // First registration succeeds
    await registerIdentity(identity);

    // Second registration with same identity should fail
    const presentation = await signPresentation(identity);
    const res = await fetch(`${baseUrl}/identity-auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presentation }),
    });

    expect(res.status).toBe(409);
  });

  test("reject registration with missing signature", async () => {
    const identity = await createTestIdentity();

    const res = await fetch(`${baseUrl}/identity-auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        presentation: {
          did: identity.did,
          publicKey: identity.publicKeyBase64,
          claims: { email: identity.email },
          // signature intentionally omitted
          timestamp: new Date().toISOString(),
        },
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reject registration with invalid signature", async () => {
    const identity = await createTestIdentity();
    const otherIdentity = await createTestIdentity();

    // Sign with a different key than the one in the presentation
    const presentation = await signPresentation(otherIdentity);
    presentation.did = identity.did;
    presentation.publicKey = identity.publicKeyBase64;

    const res = await fetch(`${baseUrl}/identity-auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presentation }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
