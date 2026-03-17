import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

async function createSpace(token: string, spaceId: string, label: string) {
  const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: spaceId,
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
      label,
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
      },
    }),
  });
  return res;
}

test.describe("spaces: access-tokens", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const spaceId = crypto.randomUUID();
  const tokenPublicKey = randomBase64(65);
  const tokenLabel = "E2E Access Token";
  const tokenRole = "member";
  let createdTokenId: string;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;

    // Create space for token tests
    const res = await createSpace(accessToken, spaceId, "Token Test Space");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // Best effort cleanup
    }
  });

  test("create access token returns tokenId and 64-char hex token", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        publicKey: tokenPublicKey,
        role: tokenRole,
        label: tokenLabel,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(typeof body.tokenId).toBe("string");
    expect(body.tokenId.length).toBeGreaterThan(0);
    expect(typeof body.token).toBe("string");
    expect(body.token).toHaveLength(64);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);

    createdTokenId = body.tokenId;
  });

  test("list tokens includes the created token with correct fields", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/tokens/${createdTokenId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("revoked token shows as revoked in list", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
