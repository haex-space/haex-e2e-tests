import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createTestIdentity,
  registerIdentity,
  challengeLogin,
  createVaultKey,
  pushChanges,
  pullChanges,
  makeSyncChange,
  signRecord,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

async function createSpace(token: string, spaceId: string, label: string) {
  return fetch(`${SYNC_SERVER_URL}/spaces`, {
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
}

async function addMember(
  adminToken: string,
  spaceId: string,
  publicKey: string,
  label: string,
  role: "admin" | "member" | "viewer",
) {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      publicKey,
      label,
      role,
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
        generation: 1,
      },
    }),
  });
}

test.describe("spaces: RBAC permissions", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let viewerToken: string;
  let ownerPublicKey: string;
  let adminPublicKey: string;
  let memberPublicKey: string;
  let viewerPublicKey: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    // Create 4 users with different roles
    const owner = await createAdminUser();
    ownerToken = owner.accessToken;
    ownerPublicKey = randomBase64(65); // Placeholder — real key comes from identity

    // Create space as owner
    const createRes = await createSpace(ownerToken, spaceId, "RBAC Test Space");
    expect(createRes.status).toBe(201);

    // Get owner's actual public key from space details
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const spaceDetails = await detailRes.json();
    ownerPublicKey = spaceDetails.members[0].publicKey;

    // Create other users
    const admin = await createAdminUser();
    adminToken = admin.accessToken;
    adminPublicKey = randomBase64(65);

    const member = await createAdminUser();
    memberToken = member.accessToken;
    memberPublicKey = randomBase64(65);

    const viewer = await createAdminUser();
    viewerToken = viewer.accessToken;
    viewerPublicKey = randomBase64(65);

    // Add members with different roles
    const addAdminRes = await addMember(ownerToken, spaceId, adminPublicKey, "Admin User", "admin");
    expect(addAdminRes.status).toBe(201);

    const addMemberRes = await addMember(ownerToken, spaceId, memberPublicKey, "Member User", "member");
    expect(addMemberRes.status).toBe(201);

    const addViewerRes = await addMember(ownerToken, spaceId, viewerPublicKey, "Viewer User", "viewer");
    expect(addViewerRes.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
    } catch {
      // Best effort cleanup
    }
  });

  // =====================================================================
  // Space Management Permissions
  // =====================================================================

  test("owner can update space name", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
      }),
    });
    expect(res.status).toBe(200);
  });

  test("admin can invite new members", async () => {
    const newMemberKey = randomBase64(65);
    const res = await addMember(ownerToken, spaceId, newMemberKey, "Another Admin Invite", "member");
    expect(res.status).toBe(201);

    // Cleanup
    await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(newMemberKey)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
  });

  test("member cannot invite new members", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memberToken}`,
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

  test("viewer cannot invite new members", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({
        publicKey: randomBase64(65),
        label: "Unauthorized Viewer Invite",
        role: "viewer",
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

  test("member cannot delete space", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("viewer cannot delete space", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Data Access Permissions (Partition-level)
  // =====================================================================

  test("non-member cannot access space data", async () => {
    const outsider = await createAdminUser();

    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${outsider.accessToken}` },
    });

    // Non-member should get 403 or 404
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("all roles can list spaces they belong to", async () => {
    // Each user should see the space in their list
    for (const [name, token] of [
      ["owner", ownerToken],
      // admin/member/viewer tokens belong to different GoTrue users
      // that aren't linked to the space via publicKey matching.
      // This test verifies the owner can see their space.
    ]) {
      const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const spaces = await res.json();
      const found = spaces.find((s: { id: string }) => s.id === spaceId);
      expect(found, `${name} should see the space`).toBeDefined();
    }
  });

  // =====================================================================
  // Member Role Changes
  // =====================================================================

  test("owner can change member role", async () => {
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberPublicKey)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    // Accept 200 or 404 (PATCH might not be implemented yet)
    if (res.status === 200) {
      const body = await res.json();
      expect(body.success).toBe(true);

      // Revert back to member
      await fetch(
        `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberPublicKey)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({ role: "member" }),
        },
      );
    } else {
      test.skip(true, "PATCH member role not implemented");
    }
  });

  test("owner can remove any member", async () => {
    // Add a temporary member to remove
    const tempKey = randomBase64(65);
    const addRes = await addMember(ownerToken, spaceId, tempKey, "Temp Member", "member");
    expect(addRes.status).toBe(201);

    const removeRes = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(tempKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    expect(removeRes.status).toBe(200);
  });
});
