// tests/spaces/invitations/server-invite-api.spec.ts
//
// Server-side invite API: CRUD operations, DID-based invites,
// acceptance, decline, and authorization checks.

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
  getSpaceDetails,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import { LegacySpaceCapabilities as SpaceCapabilities } from "../../helpers/legacy-space-capabilities";

const SYNC_SERVER_URL = getSyncServerUrl();

test.describe("invitations: server invite API", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  let authInvitee: AuthContext;
  let inviteeDid: string;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, invitee] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);
    authOwner = toAuthContext(owner);
    authInvitee = toAuthContext(invitee);
    inviteeDid = invitee.did;

    const res = await createSpace(authOwner, spaceId, "Invite API Test Space");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(authOwner, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  // =========================================================================
  // Create invite
  // =========================================================================

  let inviteId: string;

  test("create invite for known DID returns 201 with inviteId", async () => {
    const res = await createServerInvite(
      authOwner,
      spaceId,
      inviteeDid,
      SpaceCapabilities.WRITE,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.invite.id).toBe("string");
    expect(body.invite.id.length).toBeGreaterThan(0);
    inviteId = body.invite.id;
  });

  test("create invite with read capability returns 201", async () => {
    const otherInvitee = await createAdminUserWithIdentity();
    const res = await createServerInvite(
      authOwner,
      spaceId,
      otherInvitee.did,
      SpaceCapabilities.READ,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("create invite with includeHistory flag returns 201", async () => {
    const otherInvitee = await createAdminUserWithIdentity();
    const res = await createServerInvite(
      authOwner,
      spaceId,
      otherInvitee.did,
      SpaceCapabilities.WRITE,
      true, // includeHistory
    );

    expect(res.status).toBe(201);
  });

  // =========================================================================
  // Authorization checks
  // =========================================================================

  test("non-admin cannot create invites", async () => {
    const nonAdmin = await createAdminUserWithIdentity();
    const nonAdminAuth = toAuthContext(nonAdmin);

    const res = await createServerInvite(
      nonAdminAuth,
      spaceId,
      "did:key:z6MkRandomTarget",
      SpaceCapabilities.READ,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("unauthenticated request is rejected", async () => {
    const bodyStr = JSON.stringify({
      did: inviteeDid,
      capability: SpaceCapabilities.READ,
    });

    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("invite to non-existent space returns error", async () => {
    const fakeSpaceId = crypto.randomUUID();
    const res = await createServerInvite(
      authOwner,
      fakeSpaceId,
      inviteeDid,
      SpaceCapabilities.READ,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Accept invite
  // =========================================================================

  test("invitee can accept the invite", async () => {
    const res = await acceptServerInvite(authInvitee, spaceId, inviteId);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("after acceptance, invite status is updated", async () => {
    // acceptServerInvite marks the invite as accepted but does NOT add
    // the user to space members (that requires the MLS handshake).
    // Verify the invite list reflects the status change.
    const res = await listPendingInvites(authOwner, spaceId);
    expect(res.status).toBe(200);

    const body = await res.json();
    const invites = body.invites ?? body;
    const accepted = invites.find(
      (i: { id: string; status?: string }) => i.id === inviteId,
    );
    expect(accepted).toBeDefined();
    expect(accepted.status).toBe("accepted");
  });

  test("accepting already-accepted invite returns error", async () => {
    const res = await acceptServerInvite(authInvitee, spaceId, inviteId);

    // Already accepted — should return error (4xx)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Decline invite
  // =========================================================================

  test("decline flow: create + decline invite", async () => {
    const newInvitee = await createAdminUserWithIdentity();
    const newInviteeAuth = toAuthContext(newInvitee);

    // Create invite
    const createRes = await createServerInvite(
      authOwner,
      spaceId,
      newInvitee.did,
      SpaceCapabilities.READ,
    );
    expect(createRes.status).toBe(201);
    const declineInviteId = (await createRes.json()).invite.id;

    // Decline
    const declineRes = await declineServerInvite(
      newInviteeAuth,
      spaceId,
      declineInviteId,
    );
    expect(declineRes.status).toBe(200);

    // Verify invitee is NOT in members
    const detailRes = await getSpaceDetails(authOwner, spaceId);
    const space = await detailRes.json();
    const member = space.members?.find(
      (m: { did: string }) => m.did === newInvitee.did,
    );
    expect(member).toBeUndefined();
  });

  test("declining already-declined invite returns error", async () => {
    const newInvitee = await createAdminUserWithIdentity();
    const newInviteeAuth = toAuthContext(newInvitee);

    const createRes = await createServerInvite(
      authOwner,
      spaceId,
      newInvitee.did,
      SpaceCapabilities.READ,
    );
    expect(createRes.status).toBe(201);
    const decId = (await createRes.json()).invite.id;

    // First decline
    const firstDecline = await declineServerInvite(newInviteeAuth, spaceId, decId);
    expect(firstDecline.status).toBe(200);

    // Second decline — should fail
    const secondDecline = await declineServerInvite(newInviteeAuth, spaceId, decId);
    expect(secondDecline.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Wrong-user scenarios
  // =========================================================================

  test("third party cannot accept another user's invite", async () => {
    const target = await createAdminUserWithIdentity();
    const thirdParty = await createAdminUserWithIdentity();
    const thirdPartyAuth = toAuthContext(thirdParty);

    const createRes = await createServerInvite(
      authOwner,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(createRes.status).toBe(201);
    const targetInviteId = (await createRes.json()).invite.id;

    // Third party tries to accept
    const res = await acceptServerInvite(thirdPartyAuth, spaceId, targetInviteId);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("third party cannot decline another user's invite", async () => {
    const target = await createAdminUserWithIdentity();
    const thirdParty = await createAdminUserWithIdentity();
    const thirdPartyAuth = toAuthContext(thirdParty);

    const createRes = await createServerInvite(
      authOwner,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(createRes.status).toBe(201);
    const targetInviteId = (await createRes.json()).invite.id;

    const res = await declineServerInvite(thirdPartyAuth, spaceId, targetInviteId);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Invite with invalid data
  // =========================================================================

  test("invite with empty capability is rejected", async () => {
    const bodyStr = JSON.stringify({
      did: inviteeDid,
      capability: "",
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

  test("invite with invalid DID format is accepted (server stores as-is)", async () => {
    // The server accepts any non-empty string as inviteeDid.
    // DID format validation is the client's responsibility.
    const res = await createServerInvite(
      authOwner,
      spaceId,
      "not-a-valid-did",
      SpaceCapabilities.READ,
    );

    expect(res.status).toBe(201);
  });

  test("accept non-existent invite ID returns error", async () => {
    const fakeInviteId = crypto.randomUUID();
    const res = await acceptServerInvite(authInvitee, spaceId, fakeInviteId);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
