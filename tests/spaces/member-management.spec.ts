import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  deleteSpace,
  createDidAuthHeader,
  DidAuthAction,
  type AuthContext,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("spaces: member-management", () => {
  test.describe.configure({ mode: "serial" });

  let authA: AuthContext;
  let authB: AuthContext;
  let memberBDid: string;
  const spaceId = crypto.randomUUID();
  const memberLabel = "User B Member";

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [adminA, adminB] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);
    authA = toAuthContext(adminA);
    authB = toAuthContext(adminB);
    memberBDid = adminB.did;

    // Create space as user A
    const res = await createSpace(authA, spaceId, "Member Mgmt Test Space");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(authA, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("invite user B as member returns 201", async () => {
    const res = await addSpaceMember(authA, spaceId, memberBDid, memberLabel, "member");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("list members shows both users with correct roles", async () => {
    const authHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const space = await res.json();

    expect(Array.isArray(space.members)).toBe(true);
    expect(space.members.length).toBeGreaterThanOrEqual(2);

    const admin = space.members.find(
      (m: { role: string }) => m.role === "admin",
    );
    expect(admin).toBeDefined();
    expect(typeof admin.did).toBe("string");

    const member = space.members.find(
      (m: { did: string }) => m.did === memberBDid,
    );
    expect(member).toBeDefined();
    expect(member.role).toBe("member");
    expect(member.label).toBe(memberLabel);
    expect(typeof member.joinedAt).toBe("string");
  });

  test("non-admin cannot invite members", async () => {
    const body = JSON.stringify({
      did: "did:key:z6MkUnauthorized",
      label: "Unauthorized Invite",
      role: "member",
    });
    const authHeader = await createDidAuthHeader(authB.privateKeyBase64, authB.did, DidAuthAction.CreateSpace, body);
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

  test("remove member returns 200 and member no longer in list", async () => {
    const deleteRes = await removeSpaceMember(authA, spaceId, memberBDid);

    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify member is no longer in list
    const detailAuthHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, DidAuthAction.ListSpaces);
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: detailAuthHeader },
    });

    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const removedMember = space.members.find(
      (m: { did: string }) => m.did === memberBDid,
    );
    expect(removedMember).toBeUndefined();
  });

  test("re-invite removed member succeeds", async () => {
    const res = await addSpaceMember(authA, spaceId, memberBDid, memberLabel, "member");

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify member is back in list
    const detailAuthHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, DidAuthAction.ListSpaces);
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: detailAuthHeader },
    });

    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const member = space.members.find(
      (m: { did: string }) => m.did === memberBDid,
    );
    expect(member).toBeDefined();
    expect(member.role).toBe("member");
  });
});
