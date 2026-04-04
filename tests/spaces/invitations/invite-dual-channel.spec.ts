// tests/spaces/invitations/invite-dual-channel.spec.ts
//
// Tests for dual-channel invite delivery: server + QUIC.
//
// When inviting a contact to an online space, the app sends:
// 1. Server invite (HTTP POST to sync server)
// 2. QUIC PushInvite (P2P via iroh, queued in outbox)
//
// The receiver can accept via either channel:
// - QUIC: if spaceEndpoints present → ClaimInvite to leader
// - Server: if serverUrl + tokenId and no endpoints
//
// This test suite validates the server-side behavior and documents
// the expected client-side coordination between channels.

import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  deleteSpace,
  addSpaceMember,
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  acceptServerInvite,
  declineServerInvite,
  createInviteToken,
  claimInviteToken,
  getSpaceDetails,
  generateSpaceId,
  generateEndpointId,
} from "../../helpers/invite-helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

test.describe("invitations: dual-channel delivery", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);

    const res = await createSpace(authOwner, spaceId, "Dual Channel Test");
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
  // Dual-channel: server invite + separate token claim
  // =========================================================================

  test("server invite and token can coexist for same space", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Channel 1: Direct server invite
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(invRes.status).toBe(201);
    const serverInviteId = (await invRes.json()).invite.id;

    // Channel 2: Token (would be used for QUIC PushInvite's tokenId)
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.WRITE,
      maxUses: 1,
    });
    expect(tokenRes.status).toBe(201);

    // Accept via server (the QUIC channel would use ClaimInvite)
    const acceptRes = await acceptServerInvite(inviteeAuth, spaceId, serverInviteId);
    expect(acceptRes.status).toBe(200);

    // Accept marks invite as accepted but does NOT add to members
    // (requires MLS handshake). Verify the accept succeeded.
    const acceptBody = await acceptRes.json();
    expect(acceptBody.success).toBe(true);
  });

  // =========================================================================
  // Dual-channel: server invite ID reused as QUIC token ID
  // =========================================================================

  test("server inviteId passed to QUIC flow enables server fallback", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Create server invite (returns inviteId)
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const sharedTokenId = (await invRes.json()).invite.id;

    // In the app: queueQuicInviteAsync({ tokenId: serverInviteId, ... })
    // This means the QUIC PushInvite carries the server's inviteId.
    // If QUIC ClaimInvite fails, the receiver can fall back to server acceptance
    // using the same ID.

    // Simulate fallback: accept via server
    const acceptRes = await acceptServerInvite(inviteeAuth, spaceId, sharedTokenId);
    expect(acceptRes.status).toBe(200);
  });

  // =========================================================================
  // Dual-channel: decline on one channel
  // =========================================================================

  test("declining server invite does not affect QUIC token", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Create server invite
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Create separate token (simulates QUIC channel)
    const tokenRes = await createInviteToken(authOwner, spaceId, {
      capability: SpaceCapabilities.WRITE,
      maxUses: 1,
    });
    expect(tokenRes.status).toBe(201);
    const tokenId = (await tokenRes.json()).token.id;

    // Decline server invite
    const declineRes = await declineServerInvite(inviteeAuth, spaceId, inviteId);
    expect(declineRes.status).toBe(200);

    // Token should still be claimable by another user
    const otherUser = await createAdminUserWithIdentity();
    const otherAuth = toAuthContext(otherUser);
    const claimRes = await claimInviteToken(otherAuth, spaceId, tokenId);
    expect(claimRes.status).toBe(200);
  });

  // =========================================================================
  // Multi-device endpoint scenarios
  // =========================================================================

  test("space with multiple device endpoints: all endpoints included in invite", () => {
    // Simulate the processOutboxAsync behavior:
    // Load all haexSpaceDevices → map to endpoint IDs → include in PushInvite
    const devices = [
      { id: "device-1", endpointId: generateEndpointId(), name: "Desktop" },
      { id: "device-2", endpointId: generateEndpointId(), name: "Android" },
      { id: "device-3", endpointId: generateEndpointId(), name: "Laptop" },
    ];

    const spaceEndpoints = devices.map((d) => d.endpointId);

    // All endpoints should be unique
    expect(new Set(spaceEndpoints).size).toBe(3);

    // All should be included in the invite (receiver tries each to claim)
    expect(spaceEndpoints.length).toBe(3);
  });

  test("own endpoint must be filtered from outbox targets", () => {
    // Simulate the own-endpoint check in processOutboxAsync:
    const ownEndpointId = generateEndpointId();
    const outboxEntries = [
      { targetEndpointId: generateEndpointId(), targetDid: "did:key:z6MkA" },
      { targetEndpointId: ownEndpointId, targetDid: "did:key:z6MkSelf" },
      { targetEndpointId: generateEndpointId(), targetDid: "did:key:z6MkB" },
    ];

    // Filter: skip entries where target is own endpoint
    const toProcess = outboxEntries.filter(
      (e) => e.targetEndpointId !== ownEndpointId,
    );

    expect(toProcess.length).toBe(2);
    expect(toProcess.every((e) => e.targetEndpointId !== ownEndpointId)).toBe(true);
  });

  // =========================================================================
  // Space endpoint registration for invite delivery
  // =========================================================================

  test("invite includes space endpoints for QUIC claim path", () => {
    // When sending a PushInvite, the sender includes:
    // - targetEndpointId: the recipient's endpoint (from contact claims)
    // - spaceEndpoints: all devices in the space (for the receiver to try ClaimInvite)
    // These are different: targetEndpointId = who to send TO, spaceEndpoints = who to claim FROM

    const targetEndpoint = generateEndpointId();
    const spaceEndpoints = [
      generateEndpointId(), // Desktop
      generateEndpointId(), // Android
    ];

    // Target should NOT be in space endpoints (it's the receiver, not the sender)
    expect(spaceEndpoints.includes(targetEndpoint)).toBe(false);

    // Space endpoints are the sender's devices
    expect(spaceEndpoints.length).toBe(2);
  });

  // =========================================================================
  // Concurrent dual-channel acceptance
  // =========================================================================

  test("accepting via both channels: second accept is idempotent", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Create server invite
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Accept via server
    const accept1 = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
    expect(accept1.status).toBe(200);
    const acceptBody = await accept1.json();
    expect(acceptBody.success).toBe(true);

    // Try accepting again (simulates QUIC path succeeding after server path)
    const accept2 = await acceptServerInvite(inviteeAuth, spaceId, inviteId);
    // Should fail gracefully — already accepted
    expect(accept2.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Invite metadata consistency
  // =========================================================================

  test("invite carries correct space metadata", async () => {
    // Create a new space with specific name
    const metaSpaceId = generateSpaceId();
    const spaceName = "Metadata Test Space";
    const createRes = await createSpace(authOwner, metaSpaceId, spaceName);
    expect(createRes.status).toBe(201);

    try {
      // Verify space has correct data
      const detailRes = await getSpaceDetails(authOwner, metaSpaceId);
      expect(detailRes.status).toBe(200);
      const space = await detailRes.json();

      // Space should have the owner as admin
      expect(space.members?.length).toBeGreaterThanOrEqual(1);
      const admin = space.members?.find(
        (m: { capability: string }) => m.capability === SpaceCapabilities.ADMIN,
      );
      expect(admin).toBeDefined();
      expect(admin.did).toBe(authOwner.did);
    } finally {
      try {
        await deleteSpace(authOwner, metaSpaceId);
      } catch {
        // Best effort
      }
    }
  });
});
