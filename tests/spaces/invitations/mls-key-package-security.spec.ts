// tests/spaces/invitations/mls-key-package-security.spec.ts
//
// API-level security tests for the MLS KeyPackage and message endpoints.
// Every test exercises an actual HTTP call against the sync-server — DB-only
// assertions (plain SELECTs) do not verify that the server gate exists.
//
// Covered gates:
//   1. GET /:spaceId/mls/key-packages/:did requires an `accepted` invite
//      for the target DID (regardless of caller's UCAN capability).
//   2. GET /:spaceId/mls/messages requires the caller to be a member of
//      the space (UCAN root-issuer check).

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
  declineServerInvite,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import {
  fetchKeyPackage,
  fetchMlsMessages,
} from "../../helpers/mls-helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

test.describe("invitations: MLS security (API-level)", () => {
  test.describe.configure({ mode: "serial" });

  let authOwner: AuthContext;
  const spaceId = generateSpaceId();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const owner = await createAdminUserWithIdentity();
    authOwner = toAuthContext(owner);

    const res = await createSpace(authOwner, spaceId, "MLS Security Test");
    expect(res.status).toBe(201);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(authOwner, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  // ==========================================================================
  // KeyPackage retrieval gate — accepted-invite check
  // ==========================================================================

  test("KeyPackage fetch is rejected when invitee has no invite", async () => {
    const stranger = await createAdminUserWithIdentity();

    const res = await fetchKeyPackage(authOwner, spaceId, stranger.did);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/no accepted invite/i);
  });

  test("KeyPackage fetch is rejected while invite is still pending", async () => {
    const invitee = await createAdminUserWithIdentity();

    const create = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(create.status).toBe(201);

    const res = await fetchKeyPackage(authOwner, spaceId, invitee.did);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/no accepted invite/i);
  });

  test("KeyPackage fetch is rejected after invite was declined", async () => {
    const invitee = await createAdminUserWithIdentity();
    const inviteeAuth = toAuthContext(invitee);

    const create = await createServerInvite(
      authOwner,
      spaceId,
      invitee.did,
      SpaceCapabilities.WRITE,
    );
    expect(create.status).toBe(201);
    const inviteId = (await create.json()).invite.id;

    const decline = await declineServerInvite(inviteeAuth, spaceId, inviteId);
    expect(decline.status).toBe(200);

    const res = await fetchKeyPackage(authOwner, spaceId, invitee.did);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/no accepted invite/i);
  });

  // ==========================================================================
  // Message read gate — UCAN root-issuer must be a space member
  // ==========================================================================

  test("Outsider cannot read MLS messages of a space they are not in", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // fetchMlsMessages builds a self-signed UCAN claiming `space/read`.
    // The server verifies the UCAN signature (valid) but then checks whether
    // the root issuer is a member of the space — the outsider is not, so the
    // request is rejected with 403.
    const res = await fetchMlsMessages(outsiderAuth, spaceId);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not a member/i);
  });
});
