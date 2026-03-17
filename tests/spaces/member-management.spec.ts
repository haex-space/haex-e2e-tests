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

test.describe("spaces: member-management", () => {
  test.describe.configure({ mode: "serial" });

  let tokenA: string;
  let tokenB: string;
  const spaceId = crypto.randomUUID();
  const memberPublicKey = randomBase64(65);
  const memberLabel = "User B Member";

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [adminA, adminB] = await Promise.all([
      createAdminUser(),
      createAdminUser(),
    ]);
    tokenA = adminA.accessToken;
    tokenB = adminB.accessToken;

    // Create space as user A
    const res = await createSpace(tokenA, spaceId, "Member Mgmt Test Space");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
    } catch {
      // Best effort cleanup
    }
  });

  test("invite user B as member returns 201", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        publicKey: memberPublicKey,
        label: memberLabel,
        role: "member",
        keyGrant: {
          encryptedSpaceKey: randomBase64(32),
          keyNonce: randomBase64(12),
          ephemeralPublicKey: randomBase64(65),
          generation: 1,
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("list members shows both users with correct roles", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(res.status).toBe(200);
    const space = await res.json();

    expect(Array.isArray(space.members)).toBe(true);
    expect(space.members.length).toBeGreaterThanOrEqual(2);

    const admin = space.members.find(
      (m: { role: string }) => m.role === "admin",
    );
    expect(admin).toBeDefined();
    expect(typeof admin.publicKey).toBe("string");

    const member = space.members.find(
      (m: { publicKey: string }) => m.publicKey === memberPublicKey,
    );
    expect(member).toBeDefined();
    expect(member.role).toBe("member");
    expect(member.label).toBe(memberLabel);
    expect(typeof member.joinedAt).toBe("string");
  });

  test("non-admin cannot invite members", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({
        publicKey: randomBase64(65),
        label: "Unauthorized Invite",
        role: "member",
        keyGrant: {
          encryptedSpaceKey: randomBase64(32),
          keyNonce: randomBase64(12),
          ephemeralPublicKey: randomBase64(65),
          generation: 1,
        },
      }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("remove member returns 200 and member no longer in list", async () => {
    const encodedKey = encodeURIComponent(memberPublicKey);
    const deleteRes = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodedKey}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenA}` },
      },
    );

    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify member is no longer in list
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const removedMember = space.members.find(
      (m: { publicKey: string }) => m.publicKey === memberPublicKey,
    );
    expect(removedMember).toBeUndefined();
  });

  test("re-invite removed member succeeds", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        publicKey: memberPublicKey,
        label: memberLabel,
        role: "member",
        keyGrant: {
          encryptedSpaceKey: randomBase64(32),
          keyNonce: randomBase64(12),
          ephemeralPublicKey: randomBase64(65),
          generation: 1,
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify member is back in list
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const member = space.members.find(
      (m: { publicKey: string }) => m.publicKey === memberPublicKey,
    );
    expect(member).toBeDefined();
    expect(member.role).toBe("member");
  });
});
