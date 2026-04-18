// tests/spaces/invitations/invite-decline-safety.spec.ts
//
// Critical safety tests for invitation decline behavior.
//
// BACKGROUND: Declining an invitation previously called removeSpaceFromDbAsync()
// which issued a Drizzle delete on haex_spaces — a CRDT-synced table. This created
// a tombstone that propagated via sync to ALL devices, destroying the sender's
// active space and eventually corrupting the vault (default space tombstoned →
// ensureDefaultSpaceAsync fails → vault won't open).
//
// FIX: Decline now only updates the invite status to 'declined' and sets the
// pending space status to 'declined'. No CRDT delete, no tombstone, no propagation.
//
// These tests verify that declining an invitation is safe and does not affect
// the sender's space, other members' access, or the vault's integrity.

import * as crypto from "crypto";
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
  signAndPushSpaceChanges,
  pullChanges,
  makeSyncChange,
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  acceptServerInvite,
  declineServerInvite,
  getSpaceDetails,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("invitations: decline safety", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  let ownerPublicKey: string;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);
    ownerPublicKey = owner.publicKey;

    const res = await createSpace(authOwner, spaceId, "Decline Safety Test");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(authOwner, spaceId);
    } catch {
      // Best effort — space might already be gone if tests fail
    }
  });

  // =========================================================================
  // Core safety: decline does not destroy sender's space
  // =========================================================================

  test("declining invite does not remove the space from the server", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Create and deliver invite
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;

    // Decline the invite
    const declineRes = await declineServerInvite(inviteeAuth, spaceId, inviteId);
    expect(declineRes.status).toBe(200);

    // CRITICAL: Space must still exist and be accessible by owner
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    expect(detailRes.status).toBe(200);

    const space = await detailRes.json();
    expect(space.members).toBeDefined();
    expect(space.members.length).toBeGreaterThanOrEqual(1);

    // Owner must still be admin
    const admin = space.members.find(
      (m: { capability: string }) => m.capability === SpaceCapabilities.ADMIN,
    );
    expect(admin).toBeDefined();
    expect(admin.did).toBe(authOwner.did);
  });

  test("declining invite does not affect other members", async () => {
    // Add a permanent member directly (addSpaceMember adds to members immediately)
    const permanentMember = await createAdminUserWithIdentity();

    const addRes = await addSpaceMember(
      authOwner,
      spaceId,
      permanentMember.did,
      "Permanent Member",
      SpaceCapabilities.WRITE,
    );
    expect(addRes.status).toBe(201);

    // Now invite someone who will decline
    const decliner = await createAdminUserWithIdentity();
    const declinerAuth = toAuthContext(decliner);

    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      decliner.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const declineInviteId = (await invRes.json()).invite.id;

    // Decline
    const declineRes = await declineServerInvite(declinerAuth, spaceId, declineInviteId);
    expect(declineRes.status).toBe(200);

    // Permanent member must still be in the space
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    const space = await detailRes.json();
    const member = space.members?.find(
      (m: { did: string }) => m.did === permanentMember.did,
    );
    expect(member).toBeDefined();
    expect(member.capability).toBe(SpaceCapabilities.WRITE);
  });

  // =========================================================================
  // Sync safety: decline does not create destructive CRDT changes
  // =========================================================================

  test("after decline, owner can still push sync changes", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Invite and decline
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;
    await declineServerInvite(inviteeAuth, spaceId, inviteId);

    // Owner pushes changes — must succeed (space not destroyed)
    const deviceId = `e2e-decline-safety-${Date.now()}`;
    const change = makeSyncChange({
      tableName: "haex_vault_settings",
      rowPks: JSON.stringify({ id: crypto.randomUUID() }),
      columnName: "value",
      deviceId,
      hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
    });

    const pushResult = await signAndPushSpaceChanges(authOwner, spaceId, [change], authOwner.privateKeyBase64, ownerPublicKey);
    expect(pushResult.count).toBe(1);
    expect(typeof pushResult.serverTimestamp).toBe("string");
  });

  test("after decline, owner can still pull sync changes", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Invite and decline
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;
    await declineServerInvite(inviteeAuth, spaceId, inviteId);

    // Pull should work
    const pullResult = await pullChanges(authOwner, spaceId);
    expect(pullResult).toBeDefined();
    expect(Array.isArray(pullResult.changes)).toBe(true);
  });

  // =========================================================================
  // Multiple declines: no cumulative damage
  // =========================================================================

  test("multiple declined invites do not cause issues", async () => {
    // Create and decline 5 invites in sequence
    for (let i = 0; i < 5; i++) {
      const invitee = await createAdminUserWithIdentity();
      const inviteeAuth = toAuthContext(invitee);

      const invRes = await createServerInvite(
        authOwner,
        spaceId,
        invitee.did,
        SpaceCapabilities.READ,
      );
      expect(invRes.status).toBe(201);
      const inviteId = (await invRes.json()).invite.id;

      const declineRes = await declineServerInvite(inviteeAuth, spaceId, inviteId);
      expect(declineRes.status).toBe(200);
    }

    // Space must still be healthy
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    expect(detailRes.status).toBe(200);
    const space = await detailRes.json();
    expect(space.members.length).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // Re-invite after decline: current UX limitation
  //
  // The unique constraint on (spaceId, inviteeDid) means the declined invite
  // row persists and blocks a second invite with 409. Ideally the admin's
  // re-invite action would either auto-delete the declined row or the
  // server would treat decline as "row no longer blocks re-invite", but the
  // client does neither today. This test pins the current behavior so a
  // future UX improvement doesn't land silently.
  // =========================================================================

  test("re-invite after decline is blocked by unique constraint (UX limitation)", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // First invite — declined
    const inv1 = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(inv1.status).toBe(201);
    const inv1Id = (await inv1.json()).invite.id;
    await declineServerInvite(inviteeAuth, spaceId, inv1Id);

    // Second invite is rejected with 409 because the declined row still
    // occupies the unique (spaceId, inviteeDid) slot.
    const inv2 = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(inv2.status).toBe(409);
  });

  // =========================================================================
  // Decline does not leak information
  // =========================================================================

  test("declined user cannot access space details", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;
    await declineServerInvite(inviteeAuth, spaceId, inviteId);

    // Declined user should not have access to space details
    const detailRes = await getSpaceDetails(inviteeAuth, spaceId);
    // Should be 403 or 404 — not a member
    expect(detailRes.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Decline + sync: no tombstone propagation
  // =========================================================================

  test("owner's sync pull after decline contains no space tombstones", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    // Push a marker change before the decline
    const deviceId = `e2e-tombstone-check-${Date.now()}`;
    const markerChange = makeSyncChange({
      tableName: "haex_vault_settings",
      rowPks: JSON.stringify({ id: "decline-marker" }),
      columnName: "value",
      deviceId,
      hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
    });
    const pushResult = await signAndPushSpaceChanges(authOwner, spaceId, [markerChange], authOwner.privateKeyBase64, ownerPublicKey);
    const beforeDeclineTimestamp = pushResult.serverTimestamp;

    // Invite and decline
    const invRes = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.READ,
    );
    expect(invRes.status).toBe(201);
    const inviteId = (await invRes.json()).invite.id;
    await declineServerInvite(inviteeAuth, spaceId, inviteId);

    // Pull changes since before the decline
    const pullResult = await pullChanges(authOwner, spaceId, {
      afterUpdatedAt: beforeDeclineTimestamp,
    });

    // No changes should include haex_spaces tombstones
    const spaceTombstones = pullResult.changes.filter(
      (c) => c.tableName === "haex_spaces" && c.columnName === "haex_tombstone",
    );
    expect(spaceTombstones.length).toBe(0);
  });
});
