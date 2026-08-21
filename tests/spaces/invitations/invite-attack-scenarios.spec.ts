// tests/spaces/invitations/invite-attack-scenarios.spec.ts
//
// Security and attack scenario tests for the invitation system.
// Tests manipulation attempts, replay attacks, privilege escalation,
// cross-space isolation, and multi-user concurrent invite scenarios.

import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  deleteSpace,
  createDidAuthHeader,
  DidAuthAction,
  getSyncServerUrl,
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  acceptServerInvite,
  declineServerInvite,
  listPendingInvites,
  createInviteToken,
  claimInviteToken,
  revokeInviteToken,
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

test.describe("invitations: attack scenarios & multi-user", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);
    const res = await createSpace(authOwner, spaceId, "Attack Scenario Test");
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
  // Replay attacks
  // =========================================================================

  test("accepting the same invite ID twice fails on second attempt", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    const invRes = await createServerInvite(authOwner, spaceId, invitee.did, SpaceCapabilities.READ);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // First accept
    const accept1 = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
    expect(accept1.status).toBe(200);

    // Replay: same invite ID, same user
    const accept2 = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
    expect(accept2.status).toBeGreaterThanOrEqual(400);
  });

  test("declining the same invite ID twice fails on second attempt", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    const invRes = await createServerInvite(authOwner, spaceId, invitee.did, SpaceCapabilities.READ);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    const decline1 = await declineServerInvite(inviteeAuth, spaceId, inviteId);
    expect(decline1.status).toBe(200);

    const decline2 = await declineServerInvite(inviteeAuth, spaceId, inviteId);
    expect(decline2.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Identity impersonation
  // =========================================================================

  test("user A cannot accept invite addressed to user B", async () => {
    const userB = await createAdminUserWithIdentity();
    const attacker = await createAdminUserWithIdentity();
    const attackerAuth = toAuthContext(attacker);

    const invRes = await createServerInvite(authOwner, spaceId, userB.did, SpaceCapabilities.WRITE);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Attacker tries to accept B's invite
    const acceptRes = await acceptServerInvite(attackerAuth, spaceId, inviteId);
    expect(acceptRes.status).toBeGreaterThanOrEqual(400);
  });

  test("user A cannot decline invite addressed to user B", async () => {
    const userB = await createAdminUserWithIdentity();
    const attacker = await createAdminUserWithIdentity();
    const attackerAuth = toAuthContext(attacker);

    const invRes = await createServerInvite(authOwner, spaceId, userB.did, SpaceCapabilities.READ);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    const declineRes = await declineServerInvite(attackerAuth, spaceId, inviteId);
    expect(declineRes.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Cross-space token reuse
  // =========================================================================

  test("token from space A cannot be used in space B", async () => {
    const spaceB = generateSpaceId();
    const createB = await createSpace(authOwner, spaceB, "Space B");
    expect(createB.status).toBe(201);

    try {
      // Create token for space A
      const tokenRes = await createInviteToken(authOwner, spaceId, {
        capability: SpaceCapabilities.READ,
      });
      expect(tokenRes.status).toBe(201);
      const tokenId = (await tokenRes.json()).token.id;

      // Try claiming in space B
      const claimer = await createAdminUserWithIdentity();
      const claimerAuth = toAuthContext(claimer);
      const claimRes = await claimInviteToken(claimerAuth, spaceB, tokenId);
      expect(claimRes.status).toBeGreaterThanOrEqual(400);
    } finally {
      await deleteSpace(authOwner, spaceB).catch(() => {});
    }
  });

  test("invite ID from space A cannot be accepted in space B", async () => {
    const spaceB = generateSpaceId();
    const createB = await createSpace(authOwner, spaceB, "Space B Cross");
    expect(createB.status).toBe(201);

    try {
      const invitee = await createAdminUserWithIdentity();
      const inviteeAuth = toAuthContext(invitee);

      // Create invite in space A
      const invRes = await createServerInvite(authOwner, spaceId, invitee.did, SpaceCapabilities.READ);
      expect(invRes.status).toBe(201);
      const inviteId = (await invRes.json()).invite.id;

      // Try accepting in space B
      const acceptRes = await acceptServerInvite(inviteeAuth, spaceB, inviteId);
      expect(acceptRes.status).toBeGreaterThanOrEqual(400);
    } finally {
      await deleteSpace(authOwner, spaceB).catch(() => {});
    }
  });

  // =========================================================================
  // Revoked token abuse
  // =========================================================================

  test("revoked token cannot be claimed even with valid credentials", async () => {
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.WRITE,
      maxUses: 10,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    // Revoke
    const revokeRes = await revokeInviteToken(authOwner, spaceId, tokenId);
    expect(revokeRes.status).toBe(200);

    // Attempt claim after revocation
    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);
    const claimRes = await claimInviteToken(claimerAuth, spaceId, tokenId);
    expect(claimRes.status).toBeGreaterThanOrEqual(400);
  });

  // Repaired from a vacuous shape (plan §B.1 + §B.3.5). The previous body
  // asserted 4xx from an outsider using DID-Auth, which refuses every
  // non-owner with "Non-owners must provide a UCAN" before any capability
  // check — so the "did not create" half was untested. The DELETE route on
  // /invite-tokens/:id has NO per-creator check today (`src/routes/mls.ts`
  // gates only on the `invite` capability). Renaming honestly: this is the
  // capability-gate test, not a creator-scoping test. The creator-scoping
  // gap is filed in the plan (`caller-identity-and-vacuous-e2e-plan`) and is
  // in-scope for a follow-up sync-server PR — do NOT paper over it here.
  test("member without invite cap cannot revoke tokens (creator scope not enforced)", async () => {
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    const writer = await createAdminUserWithIdentity();
    const writerUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(writer),
      presetForLegacyCapability(SpaceCapabilities.WRITE),
    );
    const writerHdr = await buildUcanAuthHeader(writerUcan, spaceId, "read");
    const writerRes = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${tokenId}`,
      { method: "DELETE", headers: { Authorization: writerHdr } },
    );
    expect(writerRes.status).toBe(403);
    expect((await writerRes.json()).error).toMatch(/requires invite$/);

    // Positive control: an inviter (not the creator of the token) still
    // succeeds — this is the gap. Any `invite`-capable member can revoke any
    // token in the space, not only ones they minted themselves. Kept explicit
    // so the property is documented and a future per-creator gate would flip
    // this expected 200 to a 403 — the natural regression test for that fix.
    const inviter = await createAdminUserWithIdentity();
    const inviterUcan = delegatedSpaceAuth(
      authOwner,
      toAuthContext(inviter),
      presetForLegacyCapability(SpaceCapabilities.INVITE),
    );
    const inviterHdr = await buildUcanAuthHeader(inviterUcan, spaceId, "invite");
    const inviterRes = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${tokenId}`,
      { method: "DELETE", headers: { Authorization: inviterHdr } },
    );
    expect(inviterRes.status).toBe(200);
  });

  // =========================================================================
  // Exhausted token
  // =========================================================================

  test("single-use token is exhausted after one claim", async () => {
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 1,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    // First claim succeeds
    const user1 = await createAdminUserWithIdentity();
    const claim1 = await claimInviteToken(toAuthContext(user1), spaceId, tokenId);
    expect(claim1.status).toBe(200);

    // Second claim by different user fails
    const user2 = await createAdminUserWithIdentity();
    const claim2 = await claimInviteToken(toAuthContext(user2), spaceId, tokenId);
    expect(claim2.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Multi-user concurrent invites
  // =========================================================================

  test("5 users invited simultaneously, all receive unique invites", async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, () => createAdminUserWithIdentity()),
    );

    const inviteResults = await Promise.all(
      users.map((u) => createServerInvite(authOwner, spaceId, u.did, SpaceCapabilities.READ)),
    );

    // All should succeed
    for (const res of inviteResults) {
      expect(res.status).toBe(201);
    }

    // All invite IDs should be unique
    const ids = await Promise.all(inviteResults.map(async (r) => (await r.json()).invite.id));
    expect(new Set(ids).size).toBe(5);
  });

  test("multiple users accept invites concurrently", async () => {
    const freshSpace = generateSpaceId();
    await createSpace(authOwner, freshSpace, "Concurrent Accept Space");

    try {
      const users = await Promise.all(
        Array.from({ length: 3 }, () => createAdminUserWithIdentity()),
      );

      // Create invites
      const inviteIds: string[] = [];
      for (const u of users) {
        const res = await createServerInvite(authOwner, freshSpace, u.did, SpaceCapabilities.WRITE);
        expect(res.status).toBe(201);
        inviteIds.push((await res.json()).invite.id);
      }

      // Accept all concurrently
      const acceptResults = await Promise.all(
        users.map((u, i) => acceptServerInvite(toAuthContext(u), freshSpace, inviteIds[i])),
      );

      for (const res of acceptResults) {
        expect(res.status).toBe(200);
      }

      // Verify all accepted via invite list
      const listRes = await listPendingInvites(authOwner, freshSpace);
      expect(listRes.status).toBe(200);
      const { invites } = await listRes.json();
      const acceptedCount = invites.filter((inv: { status: string }) => inv.status === "accepted").length;
      expect(acceptedCount).toBe(3);
    } finally {
      await deleteSpace(authOwner, freshSpace).catch(() => {});
    }
  });

  test("some users accept while others decline from the same space", async () => {
    const freshSpace = generateSpaceId();
    await createSpace(authOwner, freshSpace, "Mixed Response Space");

    try {
      const acceptors = await Promise.all(
        Array.from({ length: 2 }, () => createAdminUserWithIdentity()),
      );
      const decliners = await Promise.all(
        Array.from({ length: 2 }, () => createAdminUserWithIdentity()),
      );

      // Create invites for all
      const allUsers = [...acceptors, ...decliners];
      const inviteIds: string[] = [];
      for (const u of allUsers) {
        const res = await createServerInvite(authOwner, freshSpace, u.did, SpaceCapabilities.READ);
        expect(res.status).toBe(201);
        inviteIds.push((await res.json()).invite.id);
      }

      // Acceptors accept
      for (let i = 0; i < acceptors.length; i++) {
        const res = await acceptServerInvite(toAuthContext(acceptors[i]), freshSpace, inviteIds[i]);
        expect(res.status).toBe(200);
      }

      // Decliners decline
      for (let i = 0; i < decliners.length; i++) {
        const idx = acceptors.length + i;
        const res = await declineServerInvite(toAuthContext(decliners[i]), freshSpace, inviteIds[idx]);
        expect(res.status).toBe(200);
      }

      // Verify mixed statuses
      const listRes = await listPendingInvites(authOwner, freshSpace);
      const { invites } = await listRes.json();
      const accepted = invites.filter((inv: { status: string }) => inv.status === "accepted");
      const declined = invites.filter((inv: { status: string }) => inv.status === "declined");
      expect(accepted.length).toBe(2);
      expect(declined.length).toBe(2);
    } finally {
      await deleteSpace(authOwner, freshSpace).catch(() => {});
    }
  });

  // =========================================================================
  // Token sharing between multiple claimers
  // =========================================================================

  test("multi-use token: 3 users claim successfully, 4th is rejected", async () => {
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      maxUses: 3,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    // 3 successful claims
    for (let i = 0; i < 3; i++) {
      const user = await createAdminUserWithIdentity();
      const res = await claimInviteToken(toAuthContext(user), spaceId, tokenId);
      expect(res.status).toBe(200);
    }

    // 4th claim fails
    const extraUser = await createAdminUserWithIdentity();
    const extraClaim = await claimInviteToken(toAuthContext(extraUser), spaceId, tokenId);
    expect(extraClaim.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Invite manipulation via raw HTTP
  // =========================================================================

  test("forged invite accept without auth header is rejected", async () => {
    const invitee = await createAdminUserWithIdentity();
    const invRes = await createServerInvite(authOwner, spaceId, invitee.did, SpaceCapabilities.READ);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Raw request without Authorization header
    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/invites/${inviteId}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyPackages: [crypto.randomBytes(64).toString("base64")] }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("forged token claim without auth header is rejected", async () => {
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    const res = await fetch(
      `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${tokenId}/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Hacker", keyPackages: [crypto.randomBytes(64).toString("base64")] }),
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("invite creation with empty body is rejected", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(
          authOwner.privateKeyBase64,
          authOwner.did,
          DidAuthAction.CreateSpace,
          "{}",
        ),
      },
      body: "{}",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Space deletion with pending invites
  // =========================================================================

  test("deleting space invalidates all pending invites", async () => {
    const tempSpace = generateSpaceId();
    const createRes = await createSpace(authOwner, tempSpace, "Temp Space");
    expect(createRes.status).toBe(201);

    // Create invites
    const invitee = await createAdminUserWithIdentity();
    const invRes = await createServerInvite(authOwner, tempSpace, invitee.did, SpaceCapabilities.READ);
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Delete space
    const delRes = await deleteSpace(authOwner, tempSpace);
    expect(delRes.status).toBe(200);

    // Invite should no longer be acceptable
    const inviteeAuth = toAuthContext(invitee);
    const acceptRes = await acceptServerInvite(inviteeAuth, tempSpace, inviteId);
    expect(acceptRes.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Invite listing isolation
  // =========================================================================

  // Repaired from a vacuous shape (plan §B.1). The previous body asserted
  // 4xx from an outsider via DID-Auth, and probing confirmed the server has
  // NO UCAN-based membership gate on the invite listing: an outsider handed
  // an owner-rooted `read` delegation gets 200 on this route. The name
  // "non-member cannot list invites" therefore described a gate that does
  // not exist. Renaming honestly: the actual refusal is the DID-Auth
  // non-owner branch. The UCAN-membership gap is tracked in the
  // caller-identity plan and is not closed here.
  test("outsider using DID-Auth cannot list invites", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    const listRes = await listPendingInvites(outsiderAuth, spaceId);
    expect(listRes.status).toBe(403);
    expect((await listRes.json()).error).toMatch(/Non-owners must provide a UCAN/i);
    // Positive control lives in `admin can see all invites for their space`
    // below (line ~460) — DID-Auth from the owner succeeds on this route.
  });

  test("admin can see all invites for their space", async () => {
    const freshSpace = generateSpaceId();
    await createSpace(authOwner, freshSpace, "List All Invites Space");

    try {
      const userA = await createAdminUserWithIdentity();
      const userB = await createAdminUserWithIdentity();

      await createServerInvite(authOwner, freshSpace, userA.did, SpaceCapabilities.READ);
      await createServerInvite(authOwner, freshSpace, userB.did, SpaceCapabilities.WRITE);

      const listRes = await listPendingInvites(authOwner, freshSpace);
      expect(listRes.status).toBe(200);
      const { invites } = await listRes.json();
      expect(invites.length).toBe(2);

      const dids = invites.map((inv: { inviteeDid: string }) => inv.inviteeDid);
      expect(dids).toContain(userA.did);
      expect(dids).toContain(userB.did);
    } finally {
      await deleteSpace(authOwner, freshSpace).catch(() => {});
    }
  });
});
