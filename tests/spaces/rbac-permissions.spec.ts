import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  createSpace,
  addSpaceMember,
  makeSyncChange,
  signAndPushSpaceChanges,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

test.describe("spaces: RBAC permissions", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  let memberToken: string;
  let memberPublicKey: string;
  let memberPrivateKey: string;
  let readerToken: string;
  let readerPublicKey: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    // Create users with real ECDSA identities (needed for signed push)
    const [owner, member, reader] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    ownerToken = owner.accessToken;
    memberToken = member.accessToken;
    memberPublicKey = member.publicKey;
    memberPrivateKey = member.privateKeyBase64;
    readerToken = reader.accessToken;
    readerPublicKey = reader.publicKey;

    // Create space as owner
    const createRes = await createSpace(ownerToken, spaceId, "RBAC Test Space");
    expect(createRes.status).toBe(201);

    // Add members with different roles
    const addMemberRes = await addSpaceMember(ownerToken, spaceId, memberPublicKey, "Member User", "member");
    expect(addMemberRes.status).toBe(201);

    const addReaderRes = await addSpaceMember(ownerToken, spaceId, readerPublicKey, "Reader User", "reader");
    expect(addReaderRes.status).toBe(201);
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

  test("owner can invite new members", async () => {
    const newMemberKey = randomBase64(65);
    const res = await addSpaceMember(ownerToken, spaceId, newMemberKey, "Another Invite", "member");
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

  test("reader cannot invite new members", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({
        publicKey: randomBase64(65),
        label: "Unauthorized Reader Invite",
        role: "reader",
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

  test("reader cannot delete space", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Data Access Permissions
  // =====================================================================

  test("non-member cannot access space details", async () => {
    const outsider = await createAdminUserWithIdentity();

    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: `Bearer ${outsider.accessToken}` },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("owner can list their spaces", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const spaces = await res.json();
    const found = spaces.find((s: { id: string }) => s.id === spaceId);
    expect(found).toBeDefined();
  });

  // =====================================================================
  // Member Management
  // =====================================================================

  test("owner can remove a member", async () => {
    const tempKey = randomBase64(65);
    const addRes = await addSpaceMember(ownerToken, spaceId, tempKey, "Temp Member", "member");
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

  test("member cannot remove other members", async () => {
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(readerPublicKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${memberToken}` },
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot remove other members", async () => {
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberPublicKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${readerToken}` },
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Space Name Update Permissions
  // =====================================================================

  test("member cannot update space name", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memberToken}`,
      },
      body: JSON.stringify({
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot update space name", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Access Token Permissions
  // =====================================================================

  test("owner can create access tokens", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        publicKey: memberPublicKey,
        role: "member",
        label: "Test Token",
      }),
    });
    expect(res.status).toBe(201);
  });

  test("member cannot create access tokens", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memberToken}`,
      },
      body: JSON.stringify({
        publicKey: memberPublicKey,
        role: "member",
        label: "Unauthorized Token",
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot create access tokens", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({
        publicKey: readerPublicKey,
        role: "reader",
        label: "Unauthorized Reader Token",
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("member cannot list access tokens", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot list access tokens", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Admin Transfer Permissions
  // =====================================================================

  test("member cannot transfer admin role", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memberToken}`,
      },
      body: JSON.stringify({ targetPublicKey: readerPublicKey }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot transfer admin role", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({ targetPublicKey: memberPublicKey }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Sync Push Permissions
  // =====================================================================

  test("reader cannot push changes to space", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({
        vaultId: spaceId,
        changes: [{
          tableName: "test_data",
          rowPks: JSON.stringify({ id: "reader-push-attempt" }),
          columnName: "value",
          hlcTimestamp: new Date().toISOString(),
          deviceId: "e2e-reader-device",
          encryptedValue: randomBase64(16),
          nonce: randomBase64(12),
          signature: randomBase64(64),
          signedBy: readerPublicKey,
        }],
      }),
    });
    // Should be rejected — reader has no write access
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("member can push signed changes to space", async () => {
    const result = await signAndPushSpaceChanges(
      memberToken,
      spaceId,
      [
        makeSyncChange({
          tableName: "shared_notes",
          rowPks: JSON.stringify({ id: "member-push-test" }),
          columnName: "content",
          deviceId: `e2e-member-${Date.now()}`,
        }),
      ],
      memberPrivateKey,
      memberPublicKey,
    );
    expect(result.count).toBe(1);
  });
});
