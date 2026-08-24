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
  makeSyncChange,
  signAndPushSpaceChanges,
  type AuthContext,
} from "../helpers";
import {
  buildUcanRequestHeaders,
  delegatedSpaceAuth,
  type DelegatedSpaceAuth,
} from "../helpers/mls-helpers";
import {
  LegacySpaceCapabilities as SpaceCapabilities,
  presetForLegacyCapability,
} from "../helpers/legacy-space-capabilities";

const SYNC_SERVER_URL = getSyncServerUrl();

/**
 * Why every non-owner request here carries a UCAN and not a DID-Auth header.
 *
 * The sync-server resolves a caller's space authority two ways: a UCAN caller
 * is trusted for the caps its token declares (once every root of the proof
 * forest is `spaces.ownerId`), while a DID-Auth caller is accepted ONLY as the
 * space owner. So a DID-Auth request from any non-owner — member, reader,
 * outsider alike — is refused with `Forbidden - Non-owners must provide a
 * UCAN` before its capability is ever looked at.
 *
 * A capability test built on DID-Auth therefore passes no matter which tier
 * the principal holds, and no matter whether it is a member at all. Every
 * assertion below pins the server's reason string so the test fails if it ever
 * starts being refused for a different reason than the one it is named after.
 */

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

/**
 * Assert a refusal that is specifically about the capability the route
 * demanded, not merely "some 4xx happened".
 *
 * `requires <cap>` is the tail of the server's message from
 * `requireCapabilityWithAuthority`. Pinning it is what stops these tests from
 * degrading into a status-code smoke test the moment the principal or the
 * auth scheme changes underneath them.
 */
async function expectCapabilityRefusal(
  res: Response,
  requiredCap: "read" | "write" | "invite" | "admin",
): Promise<void> {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toMatch(new RegExp(`requires ${requiredCap}$`));
}

test.describe("spaces: capability-based permissions", () => {
  test.describe.configure({ mode: "serial" });

  let ownerAuth: AuthContext;
  let memberAuth: AuthContext;
  let memberUcan: DelegatedSpaceAuth;
  let memberDid: string;
  let memberPublicKey: string;
  let memberPrivateKey: string;
  let readerAuth: AuthContext;
  let readerUcan: DelegatedSpaceAuth;
  let readerDid: string;
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
    memberDid = member.did;
    memberPublicKey = member.publicKey;
    memberPrivateKey = member.privateKeyBase64;
    readerAuth = toAuthContext(reader);
    readerDid = reader.did;
    readerPublicKey = reader.publicKey;

    // Create space as owner
    const createRes = await createSpace(ownerAuth, spaceId, "RBAC Test Space");
    expect(createRes.status).toBe(201);

    // Add members with different roles
    const addMemberRes = await addSpaceMember(ownerAuth, spaceId, memberDid, "Member User", SpaceCapabilities.WRITE);
    expect(addMemberRes.status).toBe(201);

    const addReaderRes = await addSpaceMember(ownerAuth, spaceId, readerDid, "Reader User", SpaceCapabilities.READ);
    expect(addReaderRes.status).toBe(201);

    // Owner-rooted delegations carrying exactly the set the server grants at
    // each tier, so a refusal below is a refusal about the capability and not
    // about the shape of the chain.
    memberUcan = delegatedSpaceAuth(
      ownerAuth,
      memberAuth,
      presetForLegacyCapability(SpaceCapabilities.WRITE),
    );
    readerUcan = delegatedSpaceAuth(
      ownerAuth,
      readerAuth,
      presetForLegacyCapability(SpaceCapabilities.READ),
    );
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
    const authHeader = await createDidAuthHeader(ownerAuth.privateKeyBase64, ownerAuth.did, {
      method: "PATCH", url: `${SYNC_SERVER_URL}/spaces/${spaceId}`, body,
    });
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
    const tempUser = await createAdminUserWithIdentity();
    const res = await addSpaceMember(ownerAuth, spaceId, tempUser.did, "Another Invite", SpaceCapabilities.WRITE);
    expect(res.status).toBe(201);

    // Cleanup
    await removeSpaceMember(ownerAuth, spaceId, tempUser.did);
  });

  test("member cannot invite new members", async () => {
    const body = JSON.stringify({
      did: "did:key:z6MkUnauthorizedMember",
      label: "Unauthorized Invite",
      capability: SpaceCapabilities.WRITE,
    });
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/members`;
    const res = await fetch(url, {
      method: "POST",
      headers: await buildUcanRequestHeaders(memberUcan, spaceId, "invite", {
        method: "POST",
        url,
        body,
        extra: { "Content-Type": "application/json" },
      }),
      body,
    });
    await expectCapabilityRefusal(res, "invite");
  });

  test("reader cannot invite new members", async () => {
    const body = JSON.stringify({
      did: "did:key:z6MkUnauthorizedReader",
      label: "Unauthorized Reader Invite",
      capability: SpaceCapabilities.READ,
    });
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/members`;
    const res = await fetch(url, {
      method: "POST",
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "invite", {
        method: "POST",
        url,
        body,
        extra: { "Content-Type": "application/json" },
      }),
      body,
    });
    await expectCapabilityRefusal(res, "invite");
  });

  // The capability tests above and below all present UCANs. This one keeps the
  // complementary property covered: DID-Auth carries no delegation, so the
  // server accepts it from the owner only — a full member is refused too.
  test("DID-Auth from a member is refused — non-owners must present a UCAN", async () => {
    const body = JSON.stringify({
      did: "did:key:z6MkUnauthorizedDidAuth",
      label: "DID-Auth Invite",
      capability: SpaceCapabilities.WRITE,
    });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, {
      method: "POST", url: `${SYNC_SERVER_URL}/spaces/${spaceId}/members`, body,
    });
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/must provide a ucan/i);
  });

  test("member cannot delete space", async () => {
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(memberUcan, spaceId, "admin", {
        method: "DELETE",
        url,
      }),
    });
    await expectCapabilityRefusal(res, "admin");
  });

  test("reader cannot delete space", async () => {
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "admin", {
        method: "DELETE",
        url,
      }),
    });
    await expectCapabilityRefusal(res, "admin");
  });

  // =====================================================================
  // Data Access Permissions
  // =====================================================================

  // Positive control for the pair below: the `read` gate lets a reader through,
  // so a refusal in the next test is about the outsider's chain and not about
  // the route being closed to everyone but the owner.
  test("reader can access space details", async () => {
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "read", {
        method: "GET",
        url,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(spaceId);
  });

  test("non-member cannot access space details", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // An outsider's only option is a self-signed token: nobody delegated to
    // them, so the forest root is their own DID rather than the space owner.
    // That is what closes the route to them — the server has no separate
    // membership lookup for UCAN callers.
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      headers: await buildUcanRequestHeaders(outsiderAuth, spaceId, "read", {
        method: "GET",
        url,
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/^forbidden/i);
    expect(body.members).toBeUndefined();
  });

  test("owner can list their spaces", async () => {
    const authHeader = await createDidAuthHeader(ownerAuth.privateKeyBase64, ownerAuth.did, { url: `${SYNC_SERVER_URL}/spaces` });
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
    const tempUser = await createAdminUserWithIdentity();
    const addRes = await addSpaceMember(ownerAuth, spaceId, tempUser.did, "Temp Member", SpaceCapabilities.WRITE);
    expect(addRes.status).toBe(201);

    const removeRes = await removeSpaceMember(ownerAuth, spaceId, tempUser.did);
    expect(removeRes.status).toBe(200);
  });

  test("member cannot remove other members", async () => {
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(readerDid)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(memberUcan, spaceId, "admin", {
        method: "DELETE",
        url,
      }),
    });
    await expectCapabilityRefusal(res, "admin");
  });

  test("reader cannot remove other members", async () => {
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberDid)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "admin", {
        method: "DELETE",
        url,
      }),
    });
    await expectCapabilityRefusal(res, "admin");
  });

  // =====================================================================
  // Space Name Update Permissions
  // =====================================================================

  test("member cannot update space name", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: await buildUcanRequestHeaders(memberUcan, spaceId, "admin", {
        method: "PATCH",
        url,
        body,
        extra: { "Content-Type": "application/json" },
      }),
      body,
    });
    await expectCapabilityRefusal(res, "admin");
  });

  test("reader cannot update space name", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const url = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "admin", {
        method: "PATCH",
        url,
        body,
        extra: { "Content-Type": "application/json" },
      }),
      body,
    });
    await expectCapabilityRefusal(res, "admin");
  });

  // =====================================================================
  // Ownership Transfer Permissions
  //
  // The route is POST /:spaceId/transfer-ownership. These two tests used to
  // post to /transfer-ownership's non-existent sibling `/transfer-admin` and
  // passed on the resulting 404 — which the space owner gets as well, so they
  // asserted nothing about authorization.
  //
  // The route is deliberately DID-Auth-only (a delegated admin holds
  // `admin: {delegatable: false}` precisely so it cannot mint further admins,
  // and could otherwise replay the owner's own delegation past the admin
  // gate), so DID-Auth is the correct scheme here — unlike everywhere else in
  // this file. That reduces the route to the owner, which is the property
  // under test.
  // =====================================================================

  test("member cannot transfer ownership", async () => {
    const body = JSON.stringify({ targetDid: readerDid });
    const authHeader = await createDidAuthHeader(memberAuth.privateKeyBase64, memberAuth.did, {
      method: "POST", url: `${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-ownership`, body,
    });
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-ownership`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^forbidden/i);

    // The refusal has to be the reason nothing changed, not a coincidence.
    const detailUrl = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const detail = await fetch(detailUrl, {
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "read", {
        method: "GET",
        url: detailUrl,
      }),
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).ownerId).toBe(ownerAuth.did);
  });

  test("reader cannot transfer ownership", async () => {
    const body = JSON.stringify({ targetDid: memberDid });
    const authHeader = await createDidAuthHeader(readerAuth.privateKeyBase64, readerAuth.did, {
      method: "POST", url: `${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-ownership`, body,
    });
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/transfer-ownership`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^forbidden/i);

    const detailUrl = `${SYNC_SERVER_URL}/spaces/${spaceId}`;
    const detail = await fetch(detailUrl, {
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "read", {
        method: "GET",
        url: detailUrl,
      }),
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).ownerId).toBe(ownerAuth.did);
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
    const url = `${SYNC_SERVER_URL}/sync/push`;
    const res = await fetch(url, {
      method: "POST",
      headers: await buildUcanRequestHeaders(readerUcan, spaceId, "write", {
        method: "POST",
        url,
        body,
        extra: { "Content-Type": "application/json" },
      }),
      body,
    });
    // Rejected for the reason the test is named after: the reader's delegation
    // carries `read` only, and the shared-space push gate demands `write`.
    await expectCapabilityRefusal(res, "write");
  });

  test.skip("member can push signed changes to space (requires UCAN delegation)", async () => {
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
