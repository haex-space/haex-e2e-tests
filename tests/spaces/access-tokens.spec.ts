import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  toAuthContext,
  createSpace,
  deleteSpace,
  createDidAuthHeader,
  DidAuthAction,
  type AuthContext,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

test.describe("spaces: access-tokens", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  const spaceId = crypto.randomUUID();
  const tokenPublicKey = randomBase64(65);
  const tokenLabel = "E2E Access Token";
  const tokenRole = "member";
  let createdTokenId: string;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    auth = toAuthContext(admin);

    // Create space for token tests
    const res = await createSpace(auth, spaceId, "Token Test Space");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(auth, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("create access token returns tokenId and 64-char hex token", async () => {
    const body = JSON.stringify({
      publicKey: tokenPublicKey,
      role: tokenRole,
      label: tokenLabel,
    });
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });

    expect(res.status).toBe(201);
    const resBody = await res.json();

    expect(typeof resBody.tokenId).toBe("string");
    expect(resBody.tokenId.length).toBeGreaterThan(0);
    expect(typeof resBody.token).toBe("string");
    expect(resBody.token).toHaveLength(64);
    expect(resBody.token).toMatch(/^[0-9a-f]{64}$/);

    createdTokenId = resBody.tokenId;
  });

  test("list tokens includes the created token with correct fields", async () => {
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const tokens = await res.json();

    expect(Array.isArray(tokens)).toBe(true);
    const found = tokens.find(
      (t: { id: string }) => t.id === createdTokenId,
    );
    expect(found).toBeDefined();
    expect(found.publicKey).toBe(tokenPublicKey);
    expect(found.role).toBe(tokenRole);
    expect(found.label).toBe(tokenLabel);
    expect(found.revoked).toBe(false);
  });

  test("revoke token returns 200 with success", async () => {
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace);
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/tokens/${createdTokenId}`,
      {
        method: "DELETE",
        headers: { Authorization: authHeader },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("revoked token shows as revoked in list", async () => {
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const tokens = await res.json();

    const found = tokens.find(
      (t: { id: string }) => t.id === createdTokenId,
    );
    expect(found).toBeDefined();
    expect(found.revoked).toBe(true);
  });

  test("creating a token without auth returns 401", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: randomBase64(65),
        role: "reader",
        label: "Unauthorized Token",
      }),
    });

    expect(res.status).toBe(401);
  });
});
