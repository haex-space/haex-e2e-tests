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
  type AuthContext,
} from "../helpers";
import {
  createServerInvite,
} from "../helpers/invite-helpers";
import {
  delegatedSpaceAuth,
} from "../helpers/mls-helpers";
import {
  LegacySpaceCapabilities as SpaceCapabilities,
  presetForLegacyCapability,
} from "../helpers/legacy-space-capabilities";

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
    const res = await addSpaceMember(authA, spaceId, memberBDid, memberLabel, SpaceCapabilities.WRITE);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("list members shows both users with correct roles", async () => {
    const authHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, { url: `${SYNC_SERVER_URL}/spaces/${spaceId}` });
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const space = await res.json();

    expect(Array.isArray(space.members)).toBe(true);
    expect(space.members.length).toBeGreaterThanOrEqual(2);

    const admin = space.members.find(
      (m: { capability: string }) => m.capability === SpaceCapabilities.ADMIN,
    );
    expect(admin).toBeDefined();
    expect(typeof admin.did).toBe("string");

    const member = space.members.find(
      (m: { did: string }) => m.did === memberBDid,
    );
    expect(member).toBeDefined();
    expect(member.capability).toBe(SpaceCapabilities.WRITE);
    expect(member.label).toBe(memberLabel);
    expect(typeof member.joinedAt).toBe("string");
  });

  // Repaired from a vacuous shape (plan §B.1): the previous body sent DID-Auth
  // from a non-owner, so the server refused with "Non-owners must provide a
  // UCAN" before its capability was consulted — every non-owner regardless of
  // tier failed the same way. The honest gate is `requireCapability(…,'invite')`
  // on the UCAN path, verified via a member with a WRITE-tier owner-rooted
  // delegation. A positive control at INVITE tier proves the guard is not
  // rejecting everything.
  test("non-invite member cannot create an invite", async () => {
    const writer = await createAdminUserWithIdentity();
    const writerUcan = delegatedSpaceAuth(
      authA,
      toAuthContext(writer),
      presetForLegacyCapability(SpaceCapabilities.WRITE),
    );
    const target = await createAdminUserWithIdentity();

    // Discriminating property: the specific "requires invite" capability gate,
    // not the DID-Auth non-owner refusal. The message fragment is stable
    // (matches `error` from `enforceDelegatable`); avoid pinning the full
    // sentence — it already drifted once during PR #4.
    const writerRes = await createServerInvite(
      writerUcan,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(writerRes.status).toBe(403);
    expect((await writerRes.json()).error).toMatch(/requires invite$/);

    // Positive control: same request with INVITE-tier delegation succeeds.
    // Widening the writer's granted set to INVITE would flip this test — the
    // refusal above is genuinely about the missing invite cap, not blanket
    // rejection.
    const inviter = await createAdminUserWithIdentity();
    const inviterUcan = delegatedSpaceAuth(
      authA,
      toAuthContext(inviter),
      presetForLegacyCapability(SpaceCapabilities.INVITE),
    );
    const inviterTarget = await createAdminUserWithIdentity();
    const inviterRes = await createServerInvite(
      inviterUcan,
      spaceId,
      inviterTarget.did,
      SpaceCapabilities.READ,
    );
    expect(inviterRes.status).toBe(201);
  });

  test("remove member returns 200 and member no longer in list", async () => {
    const deleteRes = await removeSpaceMember(authA, spaceId, memberBDid);

    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify member is no longer in list
    const detailAuthHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, { url: `${SYNC_SERVER_URL}/spaces/${spaceId}` });
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
    const res = await addSpaceMember(authA, spaceId, memberBDid, memberLabel, SpaceCapabilities.WRITE);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify member is back in list
    const detailAuthHeader = await createDidAuthHeader(authA.privateKeyBase64, authA.did, { url: `${SYNC_SERVER_URL}/spaces/${spaceId}` });
    const detailRes = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: detailAuthHeader },
    });

    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const member = space.members.find(
      (m: { did: string }) => m.did === memberBDid,
    );
    expect(member).toBeDefined();
    expect(member.capability).toBe(SpaceCapabilities.WRITE);
  });
});
