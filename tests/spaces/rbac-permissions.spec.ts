import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  addSpaceMember,
  deleteSpace,
  removeSpaceMember,
  createDidAuthHeader,
  DidAuthAction,
  makeSyncChange,
  signAndPushSpaceChanges,
  type AuthContext,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

test.describe("spaces: RBAC permissions", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let memberAuth: AuthContext;
  let memberPublicKey: string;
  let memberPrivateKey: string;
  let readerAuth: AuthContext;
  let readerPublicKey: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    // Create users with real Ed25519 identities (needed for signed push)
    const [owner, member, reader] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    ownerAuth = toAuthContext(owner);
    memberAuth = toAuthContext(member);
    memberPublicKey = member.publicKey;
    memberPrivateKey = member.privateKeyBase64;
    readerAuth = toAuthContext(reader);
    readerPublicKey = reader.publicKey;

    // Create space as owner
    const createRes = await createSpace(ownerAuth, spaceId, "RBAC Test Space");
    expect(createRes.status).toBe(201);

    // Add members with different roles
    const addMemberRes = await addSpaceMember(ownerAuth, spaceId, memberPublicKey, "Member User", "member");
    expect(addMemberRes.status).toBe(201);

    const addReaderRes = await addSpaceMember(ownerAuth, spaceId, readerPublicKey, "Reader User", "reader");
    expect(addReaderRes.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(ownerAuth, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  // =====================================================================
  // Space Management Permissions
  // =====================================================================

  test("owner can update space name", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const authHeader = await createDidAuthHeader(ownerAuth.privateKeyBase64, ownerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("owner can invite new members", async () => {
    const newMemberKey = randomBase64(65);
    const res = await addSpaceMember(ownerAuth, spaceId, newMemberKey, "Another Invite", "member");
    expect(res.status).toBe(201);

    // Cleanup
    await removeSpaceMember(ownerAuth, spaceId, newMemberKey);
  });

  test("member cannot invite new members", async () => {
    const body = JSON.stringify({
      publicKey: randomBase64(65),
      label: "Unauthorized Invite",
      role: "member",
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
        generation: 1,
      },
    });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot invite new members", async () => {
    const body = JSON.stringify({
      publicKey: randomBase64(65),
      label: "Unauthorized Reader Invite",
      role: "reader",
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
        generation: 1,
      },
    });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("member cannot delete space", async () => {
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot delete space", async () => {
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Data Access Permissions
  // =====================================================================

  test("non-member cannot access space details", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    const authHeader = await createDidAuthHeader(outsiderAuth.privateKeyBase64, outsiderAuth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("owner can list their spaces", async () => {
    const authHeader = await createDidAuthHeader(ownerAuth.privateKeyBase64, ownerAuth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: authHeader },
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
    const addRes = await addSpaceMember(ownerAuth, spaceId, tempKey, "Temp Member", "member");
    expect(addRes.status).toBe(201);

    const removeRes = await removeSpaceMember(ownerAuth, spaceId, tempKey);
    expect(removeRes.status).toBe(200);
  });

  test("member cannot remove other members", async () => {
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace);
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(readerPublicKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: authHeader },
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot remove other members", async () => {
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace);
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberPublicKey)}`,
      {
        method: "DELETE",
        headers: { Authorization: authHeader },
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Space Name Update Permissions
  // =====================================================================

  test("member cannot update space name", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot update space name", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Access Token Permissions
  // =====================================================================

  test("owner can create access tokens", async () => {
    const body = JSON.stringify({
      publicKey: memberPublicKey,
      role: "member",
      label: "Test Token",
    });
    const authHeader = await createDidAuthHeader(ownerAuth.privateKeyBase64, ownerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBe(201);
  });

  test("member cannot create access tokens", async () => {
    const body = JSON.stringify({
      publicKey: memberPublicKey,
      role: "member",
      label: "Unauthorized Token",
    });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot create access tokens", async () => {
    const body = JSON.stringify({
      publicKey: readerPublicKey,
      role: "reader",
      label: "Unauthorized Reader Token",
    });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("member cannot list access tokens", async () => {
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot list access tokens", async () => {
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/tokens`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Admin Transfer Permissions
  // =====================================================================

  test("member cannot transfer admin role", async () => {
    const body = JSON.stringify({ targetPublicKey: readerPublicKey });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("reader cannot transfer admin role", async () => {
    const body = JSON.stringify({ targetPublicKey: memberPublicKey });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // =====================================================================
  // Sync Push Permissions
  // =====================================================================

  test("reader cannot push changes to space", async () => {
    const body = JSON.stringify({
      spaceId: spaceId,
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
    });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, DidAuthAction.SyncPush, body);
    const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    // Should be rejected — reader has no write access
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("member can push signed changes to space", async () => {
    const result = await signAndPushSpaceChanges(
      memberAuth,
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
