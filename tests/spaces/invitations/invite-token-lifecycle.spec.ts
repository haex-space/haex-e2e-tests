// tests/spaces/invitations/invite-token-lifecycle.spec.ts
//
// Invite token lifecycle: create, list, claim, revoke, expiry,
// max-uses enforcement, and multi-use token scenarios.

import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  deleteSpace,
  getSyncServerUrl,
  type AuthContext,
} from "../../helpers";
import {
  createInviteToken,
  claimInviteToken,
  revokeInviteToken,
  listInviteTokens,
  getSpaceDetails,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import {
  buildUcanRequestHeaders,
  delegatedSpaceAuth,
} from "../../helpers/mls-helpers";
import {
  LegacySpaceCapabilities as SpaceCapabilities,
  presetForLegacyCapability,
} from "../../helpers/legacy-space-capabilities";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("invitations: invite token lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);

    const res = await createSpace(authOwner, spaceId, "Token Lifecycle Test");
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
  // Token creation
  // =========================================================================

  let tokenId: string;

  test("create invite token with default settings returns 201", async () => {
    const res = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.token.id).toBe("string");
    expect(body.token.id.length).toBeGreaterThan(0);
    tokenId = body.token.id;
  });

  test("create token with custom maxUses and expiry", async () => {
    const res = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.WRITE,
      maxUses: 5,
      expiresInSeconds: 3600,
      label: "Team Invite",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.token.id).toBe("string");
    expect(typeof body.token.expiresAt).toBe("string");
  });

  test("create token with write capability", async () => {
    const res = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.WRITE,
    });

    expect(res.status).toBe(201);
  });

  // =========================================================================
  // Token listing
  // =========================================================================

  test("list tokens returns all created tokens", async () => {
    const res = await listInviteTokens(authOwner, spaceId);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tokens ?? body)).toBe(true);

    const tokens = body.tokens ?? body;
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });

  // Repaired from a vacuous shape (plan §B.1). The previous body called
  // listInviteTokens with an outsider AuthContext, which uses DID-Auth. The
  // server refuses DID-Auth from any non-owner with "Non-owners must provide a
  // UCAN" before its capability is consulted, so the assertion passed for
  // every non-owner regardless of tier and did not discriminate a member from
  // a non-member. The honest gate is the UCAN `invite` capability on this
  // route; test it with an owner-rooted delegation at a lower tier, and pair
  // with a positive control at INVITE to prove the guard isn't rejecting all.
  test("member without invite capability cannot list tokens", async () => {
    const writer = await createAdminUserWithIdentity();
    const writerUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(writer),
      presetForLegacyCapability(SpaceCapabilities.WRITE),
    );
    const listUrl = `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens`;
    const writerRes = await fetch(listUrl, {
      headers: await buildUcanRequestHeaders(writerUcan, spaceId, "read", {
        method: "GET",
        url: listUrl,
      }),
    });
    expect(writerRes.status).toBe(403);
    expect((await writerRes.json()).error).toMatch(/requires invite$/);

    // Positive control: same request as an inviter succeeds.
    const inviter = await createAdminUserWithIdentity();
    const inviterUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(inviter),
      presetForLegacyCapability(SpaceCapabilities.INVITE),
    );
    const inviterRes = await fetch(listUrl, {
      headers: await buildUcanRequestHeaders(inviterUcan, spaceId, "invite", {
        method: "GET",
        url: listUrl,
      }),
    });
    expect(inviterRes.status).toBe(200);
  });

  // =========================================================================
  // Token claiming
  // =========================================================================

  test("claim token adds user as space member", async () => {
    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);

    const res = await claimInviteToken(claimerAuth, spaceId, tokenId, "Token Claimer");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify membership
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    const member = space.members?.find(
      (m: { did: string }) => m.did === claimer.did,
    );
    expect(member).toBeDefined();
  });

  test("claim same single-use token twice fails", async () => {
    // Create a single-use token
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 1,
    });
    expect(createRes.status).toBe(201);
    const singleUseTokenId = (await createRes.json()).token.id;

    // First claim
    const claimer1 = await createAdminUserWithIdentity();
    const claimer1Auth = toAuthContext(claimer1);
    const firstClaim = await claimInviteToken(
      claimer1Auth,
      spaceId,
      singleUseTokenId,
    );
    expect(firstClaim.status).toBe(200);

    // Second claim — should fail (max uses exhausted)
    const claimer2 = await createAdminUserWithIdentity();
    const claimer2Auth = toAuthContext(claimer2);
    const secondClaim = await claimInviteToken(
      claimer2Auth,
      spaceId,
      singleUseTokenId,
    );
    expect(secondClaim.status).toBeGreaterThanOrEqual(400);
  });

  test("multi-use token can be claimed multiple times", async () => {
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 3,
    });
    expect(createRes.status).toBe(201);
    const multiUseTokenId = (await createRes.json()).token.id;

    // Claim 3 times
    for (let i = 0; i < 3; i++) {
      const claimer = await createAdminUserWithIdentity();
      const claimerAuth = toAuthContext(claimer);
      const res = await claimInviteToken(claimerAuth, spaceId, multiUseTokenId);
      expect(res.status).toBe(200);
    }

    // 4th claim should fail
    const extraClaimer = await createAdminUserWithIdentity();
    const extraAuth = toAuthContext(extraClaimer);
    const res = await claimInviteToken(extraAuth, spaceId, multiUseTokenId);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("claim non-existent token returns error", async () => {
    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);
    const fakeTokenId = crypto.randomUUID();

    const res = await claimInviteToken(claimerAuth, spaceId, fakeTokenId);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("same user claiming token twice is handled idempotently", async () => {
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 5,
    });
    expect(createRes.status).toBe(201);
    const dupTokenId = (await createRes.json()).token.id;

    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);

    const firstClaim = await claimInviteToken(claimerAuth, spaceId, dupTokenId);
    expect(firstClaim.status).toBe(200);

    // Same user claims again — server handles idempotently (no error, no duplicate)
    const secondClaim = await claimInviteToken(claimerAuth, spaceId, dupTokenId);
    expect(secondClaim.status).toBeLessThan(500); // No server error
  });

  // =========================================================================
  // Token revocation
  // =========================================================================

  test("revoke token prevents future claims", async () => {
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 10,
    });
    expect(createRes.status).toBe(201);
    const revokeTokenId = (await createRes.json()).token.id;

    // Revoke
    const revokeRes = await revokeInviteToken(authOwner, spaceId, revokeTokenId);
    expect(revokeRes.status).toBe(200);

    // Try to claim — should fail
    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);
    const claimRes = await claimInviteToken(claimerAuth, spaceId, revokeTokenId);
    expect(claimRes.status).toBeGreaterThanOrEqual(400);
  });

  test("revoke non-existent token returns error", async () => {
    const res = await revokeInviteToken(authOwner, spaceId, crypto.randomUUID());
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // Repaired from a vacuous shape (plan §B.1). Same class as the list-tokens
  // test above: revokeInviteToken used DID-Auth and refused for every
  // non-owner identically. Two orthogonal gates apply to DELETE:
  //   (a) capability: the caller's UCAN must grant `invite`
  //   (b) creator scope: the caller must be the token creator
  // CI probing established that (b) IS enforced today (an INVITE-tier
  // non-creator gets 403). Pin both refusals; the owner (creator) is the
  // positive control. See invite-attack-scenarios.spec.ts for the mirrored
  // shape in the attack-scenarios suite.
  test("member without invite capability cannot revoke tokens", async () => {
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
    });
    expect(createRes.status).toBe(201);
    const targetTokenId = (await createRes.json()).token.id;

    // (a) capability gate: writer has no `invite` — stable `requires invite`
    // fragment from `enforceDelegatable`.
    const writer = await createAdminUserWithIdentity();
    const writerUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(writer),
      presetForLegacyCapability(SpaceCapabilities.WRITE),
    );
    const delUrl = `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${targetTokenId}`;
    const writerRes = await fetch(delUrl, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(writerUcan, spaceId, "read", {
        method: "DELETE",
        url: delUrl,
      }),
    });
    expect(writerRes.status).toBe(403);
    expect((await writerRes.json()).error).toMatch(/requires invite$/);

    // (b) creator-scope gate: inviter has `invite` but is not the token
    // creator. Still 403 — proves (a) is not the only gate.
    const inviter = await createAdminUserWithIdentity();
    const inviterUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(inviter),
      presetForLegacyCapability(SpaceCapabilities.INVITE),
    );
    const inviterRes = await fetch(delUrl, {
      method: "DELETE",
      headers: await buildUcanRequestHeaders(inviterUcan, spaceId, "invite", {
        method: "DELETE",
        url: delUrl,
      }),
    });
    expect(inviterRes.status).toBe(403);

    // Positive control: the creator (owner) can revoke — proves both
    // refusals above are specific gates, not a blanket rejection.
    const ownerRes = await revokeInviteToken(authOwner, spaceId, targetTokenId);
    expect(ownerRes.status).toBe(200);
  });

  // =========================================================================
  // Token expiry
  // =========================================================================

  test("token with below-minimum expiry is rejected by server", async () => {
    // Server enforces minimum 60 seconds for token expiry (Zod validation)
    const createRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      expiresInSeconds: 1,
    });

    expect(createRes.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Capability enforcement on claimed member
  // =========================================================================

  test("claimed member has correct capability from token", async () => {
    const readTokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
    });
    expect(readTokenRes.status).toBe(201);
    const readTokenId = (await readTokenRes.json()).token.id;

    const readClaimer = await createAdminUserWithIdentity();
    const readClaimerAuth = toAuthContext(readClaimer);
    const claimRes = await claimInviteToken(readClaimerAuth, spaceId, readTokenId);
    expect(claimRes.status).toBe(200);

    // Verify capability
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    const space = await detailRes.json();
    const member = space.members?.find(
      (m: { did: string }) => m.did === readClaimer.did,
    );
    expect(member).toBeDefined();
    expect(member.capability).toBe(SpaceCapabilities.READ);
  });
});
