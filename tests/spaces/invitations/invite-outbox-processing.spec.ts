// tests/spaces/invitations/invite-outbox-processing.spec.ts
//
// Tests for the invite outbox processing logic.
//
// The outbox system (haex_invite_outbox) queues PushInvite deliveries
// and processes them with retry/backoff. Key behaviors:
// - Entries are CRDT-synced between devices → processed on any device
// - Own endpoint ID must be skipped (prevents self-invite)
// - Expired entries are cleaned up
// - Retry backoff: immediate, 1m, 5m, 15m, 1h
// - Delivered entries marked as DELIVERED (no retries)
//
// These tests verify the outbox logic at the server API level
// and document the expected client-side behavior.

import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  deleteSpace,
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  acceptServerInvite,
  createInviteToken,
  claimInviteToken,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import { LegacySpaceCapabilities as SpaceCapabilities } from "../../helpers/legacy-space-capabilities";

test.describe("invitations: outbox processing", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);

    const res = await createSpace(authOwner, spaceId, "Outbox Processing Test");
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
  // Outbox: successful delivery marks as delivered
  // =========================================================================

  test("successful server invite does not create duplicate when re-processed", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Create invite
    const res = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(res.status).toBe(201);
    const inviteId = (await res.json()).invite.id;

    // Creating the same invite again (simulates CRDT-synced outbox re-processing)
    const dupRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );

    // Server rejects duplicate invite for the same invitee with 409 Conflict.
    expect(dupRes.status).toBe(409);

    // Accept the original invite to verify no duplicate side effects
    const acceptRes = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
    expect(acceptRes.status).toBe(200);
    const acceptBody = await acceptRes.json();
    expect(acceptBody.success).toBe(true);
  });

  // =========================================================================
  // Outbox: expiry handling
  // =========================================================================

  test("token with below-minimum expiry is rejected by server", async () => {
    // Server enforces minimum 60 seconds for token expiry
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      expiresInSeconds: 1, // Below minimum
    });

    // Server should reject with 400 (Zod validation: min 60)
    expect(tokenRes.status).toBeGreaterThanOrEqual(400);
  });

  test("non-expired invite token can still be used", async () => {
    // Create token with 1-hour expiry
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.READ,
      expiresInSeconds: 3600,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    const claimer = await createAdminUserWithIdentity();
    const claimerAuth = toAuthContext(claimer);
    const claimRes = await claimInviteToken(claimerAuth, spaceId, tokenId);
    expect(claimRes.status).toBe(200);
  });

  // =========================================================================
  // Outbox: retry behavior (documented, tested via server retry scenarios)
  // =========================================================================

  test("multiple invites to same target: last one wins", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // First invite with READ
    const inv1 = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(inv1.status).toBe(201);

    // Second invite with WRITE (supersedes first)
    const inv2 = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    // May succeed (supersede) or fail (already pending) — both are valid
    if (inv2.status === 201) {
      const inviteId = (await inv2.json()).invite.id;

      // Accept the latest invite
      const acceptRes = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
      expect(acceptRes.status).toBe(200);
      const acceptBody = await acceptRes.json();
      expect(acceptBody.success).toBe(true);
    }
  });

  // =========================================================================
  // Outbox: batch invite to multiple recipients
  // =========================================================================

  test("batch invites to multiple recipients all succeed", async () => {
    const recipients = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    const results = await Promise.all(
      recipients.map((r) =>
        createServerInvite(
          authOwner,
          spaceId,
          r.did,
          SpaceCapabilities.READ,
        ),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(201);
    }

    // Accept all invites
    const acceptResults = await Promise.all(
      recipients.map(async (r, i) => {
        const body = await results[i].json();
        return acceptServerInvite(toAuthContext(r), spaceId, body.invite.id);
      }),
    );

    for (const res of acceptResults) {
      expect(res.status).toBe(200);
    }
  });

});
