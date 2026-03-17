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

test.describe("spaces: create-space", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const spaceId = crypto.randomUUID();
  const spaceLabel = "E2E Test Space";

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
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

  test("create space returns 201 with success", async () => {
    const res = await createSpace(accessToken, spaceId, spaceLabel);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("list spaces includes the created space with admin role", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const spaces = await res.json();

    expect(Array.isArray(spaces)).toBe(true);
    const found = spaces.find((s: { id: string }) => s.id === spaceId);
    expect(found).toBeDefined();
    expect(found.role).toBe("admin");
    expect(typeof found.ownerId).toBe("string");
    expect(typeof found.encryptedName).toBe("string");
    expect(typeof found.nameNonce).toBe("string");
    expect(typeof found.currentKeyGeneration).toBe("number");
    expect(typeof found.joinedAt).toBe("string");
  });

  test("get space details returns members array with creator", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);
    const space = await res.json();

    expect(space.id).toBe(spaceId);
    expect(typeof space.ownerId).toBe("string");
    expect(typeof space.encryptedName).toBe("string");
    expect(Array.isArray(space.members)).toBe(true);
    expect(space.members.length).toBeGreaterThanOrEqual(1);

    const creator = space.members.find(
      (m: { role: string }) => m.role === "admin",
    );
    expect(creator).toBeDefined();
    expect(typeof creator.publicKey).toBe("string");
    expect(typeof creator.label).toBe("string");
    expect(typeof creator.joinedAt).toBe("string");
  });

  test("update space name returns 200 with success", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("delete space returns 200 and space no longer in list", async () => {
    const deleteRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify space is no longer in list
    const listRes = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(listRes.status).toBe(200);
    const spaces = await listRes.json();
    const found = spaces.find((s: { id: string }) => s.id === spaceId);
    expect(found).toBeUndefined();
  });

  test("creating a space without auth returns 401", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
        label: "Unauthorized Space",
        keyGrant: {
          encryptedSpaceKey: randomBase64(32),
          keyNonce: randomBase64(12),
          ephemeralPublicKey: randomBase64(65),
        },
      }),
    });

    expect(res.status).toBe(401);
  });
});
