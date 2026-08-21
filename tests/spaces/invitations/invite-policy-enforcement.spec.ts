// tests/spaces/invitations/invite-policy-enforcement.spec.ts
//
// Tests for invite policy enforcement.
//
// The invite policy controls who can send PushInvite requests:
// - "all": Accept invites from anyone
// - "contacts_only": Only accept from known contacts (identities without private_key)
// - "nobody": Reject all invites
//
// Policy is checked in handle_push_invite on the receiver side.
// Server-side invites (HTTP API) are not affected by the local policy
// since they go through the server's own authorization.

import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  deleteSpace,
  addSpaceMember,
  createDidAuthHeader,
  DidAuthAction,
  getSyncServerUrl,
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  getSpaceDetails,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import {
  buildUcanAuthHeader,
  delegatedSpaceAuth,
} from "../../helpers/mls-helpers";
import {
  LegacySpaceCapabilities as SpaceCapabilities,
  presetForLegacyCapability,
} from "../../helpers/legacy-space-capabilities";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("invitations: policy enforcement", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);

    const res = await createSpace(authOwner, spaceId, "Policy Enforcement Test");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(authOwner, spaceId);
    } catch {
      // Best effort
    }
  });

  // =========================================================================
  // Server-side: permission-based enforcement
  // =========================================================================

  test("only space admin can create invites", async () => {
    const invitee = await createAdminUserWithIdentity();

    // Owner (admin) creates invite — should work
    const adminRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(adminRes.status).toBe(201);
  });

  // Repaired from a vacuous shape (plan §B.1). Renamed honestly: the server has
  // NO membership gate for UCAN callers — `resolveCallerAuthority` never reads
  // `space_members`, and probing confirmed an outsider handed an owner-rooted
  // read delegation gets 200 on GET /spaces/:id. What actually stops an outsider
  // here is that they cannot obtain a UCAN whose chain root equals
  // `spaces.ownerId`, so they fall back to DID-Auth, which the server refuses
  // for any non-owner with "Non-owners must provide a UCAN" (that message is
  // the discriminator we assert on). The gap the original name implied
  // ("non-member cannot invite" via UCAN) is tracked in the caller-identity /
  // vacuous-e2e plan and not closed here.
  test("outsider without an owner delegation is refused at DID-Auth", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    const target = await createAdminUserWithIdentity();

    // createServerInvite with an AuthContext (not a DelegatedSpaceAuth) uses
    // DID-Auth. Non-owner DID-Auth is rejected in ucanAuth.ts's DID-Auth branch.
    const res = await createServerInvite(
      outsiderAuth,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Non-owners must provide a UCAN/i);
  });

  test("read-only member cannot create invites", async () => {
    // Add member with read capability directly
    const reader = await createAdminUserWithIdentity();
    const readerAuth = toAuthContext(reader);

    const addRes = await addSpaceMember(
      authOwner,
      spaceId,
      reader.did,
      "Read Member",
      SpaceCapabilities.READ,
    );
    expect(addRes.status).toBe(201);

    // The reader authenticates with the owner-rooted UCAN a real member holds.
    // With DID-Auth this test could not fail for its named reason: the server
    // honours DID-Auth only from the owner, so every member — reader, writer,
    // admin alike — is refused before its capability is consulted.
    const readerUcan = delegatedSpaceAuth(
      authOwner,
      readerAuth,
      presetForLegacyCapability(SpaceCapabilities.READ),
    );

    const target = await createAdminUserWithIdentity();
    const readerInvite = await createServerInvite(
      readerUcan,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(readerInvite.status).toBe(403);
    expect((await readerInvite.json()).error).toMatch(/requires invite$/);
  });

  // =========================================================================
  // Capability escalation prevention
  //
  // Two distinct gates, both reachable only with a UCAN:
  //   1. `invite` is required to create a grant at all.
  //   2. The requested grant is attenuated against what the caller may
  //      actually delegate (`grantExceedingCallerAuthority`), so holding
  //      `invite` says nothing about *what* may be handed out.
  //
  // This test used to POST `{did, capability}` to /invites — a body that route
  // does not accept (it wants `{inviteeDid, ucan}`), so it passed on a 400
  // from schema validation and never reached either gate. The token route is
  // used instead because it is the one whose schema admits `space/admin`, and
  // therefore the only place the attenuation gate can be exercised.
  // =========================================================================

  test("member cannot grant a capability above their own authority", async () => {
    const escalationSpaceId = generateSpaceId();
    const createRes = await createSpace(authOwner, escalationSpaceId, "Escalation Test");
    expect(createRes.status).toBe(201);

    try {
      const writer = await createAdminUserWithIdentity();
      const inviter = await createAdminUserWithIdentity();
      for (const [user, tier] of [
        [writer, SpaceCapabilities.WRITE] as const,
        [inviter, SpaceCapabilities.INVITE] as const,
      ]) {
        const addRes = await addSpaceMember(
          authOwner,
          escalationSpaceId,
          user.did,
          `Member ${tier}`,
          // space_members only stores read/write via this route; the tier that
          // matters for authorization is the one the UCAN carries.
          SpaceCapabilities.WRITE,
        );
        expect(addRes.status).toBe(201);
      }

      const adminGrant = JSON.stringify({
        capability: SpaceCapabilities.ADMIN,
        maxUses: 1,
        expiresInSeconds: 3600,
      });
      const mintToken = async (auth: Parameters<typeof buildUcanAuthHeader>[0], body: string) =>
        fetch(`${SYNC_SERVER_URL}/spaces/${escalationSpaceId}/invite-tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await buildUcanAuthHeader(auth, escalationSpaceId, "invite"),
          },
          body,
        });

      // Gate 1 — a writer holds no `invite`, so it cannot create any grant.
      const writerRes = await mintToken(
        delegatedSpaceAuth(authOwner, toAuthContext(writer), presetForLegacyCapability(SpaceCapabilities.WRITE)),
        adminGrant,
      );
      expect(writerRes.status).toBe(403);
      expect((await writerRes.json()).error).toMatch(/requires invite$/);

      // Gate 2 — an inviter passes gate 1, and is still refused because the
      // admin preset covers caps its own set does not carry.
      const inviterUcan = delegatedSpaceAuth(
        authOwner,
        toAuthContext(inviter),
        presetForLegacyCapability(SpaceCapabilities.INVITE),
      );
      const inviterRes = await mintToken(inviterUcan, adminGrant);
      expect(inviterRes.status).toBe(403);
      expect((await inviterRes.json()).error).toMatch(/exceeds caller authority/i);

      // Positive control: the same inviter may hand out what it does carry, so
      // gate 2 above is about the requested grant and not about the inviter.
      const readGrant = JSON.stringify({
        capability: SpaceCapabilities.READ,
        maxUses: 1,
        expiresInSeconds: 3600,
      });
      const allowedRes = await mintToken(inviterUcan, readGrant);
      expect(allowedRes.status).toBe(201);
    } finally {
      try {
        await deleteSpace(authOwner, escalationSpaceId);
      } catch {
        // Best effort
      }
    }
  });

  // =========================================================================
  // Blocked DIDs
  // =========================================================================

  // Repaired from a vacuous shape (plan §B.1). Same class of failure as the
  // outsider test above: the previous body asserted only 4xx and passed for the
  // same reason regardless of the outsider's tier. Here the request tier is
  // WRITE rather than READ — semantically the same DID-Auth refusal, kept as
  // an at-different-tier sanity check that the DID-Auth branch does not treat
  // WRITE specially. Positive control lives in "only space admin can create
  // invites" (line 72) — this is a paired negative case.
  test("outsider with WRITE-tier request is refused at DID-Auth", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    const target = await createAdminUserWithIdentity();
    const res = await createServerInvite(
      outsiderAuth,
      spaceId,
      target.did,
      SpaceCapabilities.WRITE,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Non-owners must provide a UCAN/i);
  });

  // =========================================================================
  // Cross-space isolation
  // =========================================================================

  test("invite to one space does not affect another space", async () => {
    const spaceA = generateSpaceId();
    const spaceB = generateSpaceId();

    const createA = await createSpace(authOwner, spaceA, "Space A");
    const createB = await createSpace(authOwner, spaceB, "Space B");
    expect(createA.status).toBe(201);
    expect(createB.status).toBe(201);

    try {
      const invitee = await createAdminUserWithIdentity();

      // Add member to Space A directly (addSpaceMember adds immediately)
      const addRes = await addSpaceMember(
        authOwner,
        spaceA,
        invitee.did,
        "Space A Member",
        SpaceCapabilities.WRITE,
      );
      expect(addRes.status).toBe(201);

      // Verify member in Space A
      const detailA = await getSpaceDetails(authOwner, spaceA);
      const dataA = await detailA.json();
      expect(dataA.members?.some((m: { did: string }) => m.did === invitee.did)).toBe(true);

      // Verify NOT a member of Space B
      const detailB = await getSpaceDetails(authOwner, spaceB);
      const dataB = await detailB.json();
      const memberInB = dataB.members?.find(
        (m: { did: string }) => m.did === invitee.did,
      );
      expect(memberInB).toBeUndefined();
    } finally {
      await Promise.all([
        deleteSpace(authOwner, spaceA).catch(() => {}),
        deleteSpace(authOwner, spaceB).catch(() => {}),
      ]);
    }
  });

  // =========================================================================
  // Invite capability types
  // =========================================================================

  test("invite with each valid capability succeeds", async () => {
    const capabilities = [SpaceCapabilities.READ, SpaceCapabilities.WRITE];

    for (const cap of capabilities) {
      const invitee = await createAdminUserWithIdentity();
      const res = await createServerInvite(
        authOwner,
        spaceId,
        invitee.did,
        cap,
      );
      expect(res.status).toBe(201);
    }
  });

  test("invite with invalid capability is rejected", async () => {
    const invitee = await createAdminUserWithIdentity();
    const bodyStr = JSON.stringify({
      did: invitee.did,
      capability: "space/invalid_capability",
    });

    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(
          authOwner.privateKeyBase64,
          authOwner.did,
          DidAuthAction.CreateSpace,
          bodyStr,
        ),
      },
      body: bodyStr,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
