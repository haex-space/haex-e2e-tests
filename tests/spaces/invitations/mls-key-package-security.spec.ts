// tests/spaces/invitations/mls-key-package-security.spec.ts
//
// API-level security tests for the MLS KeyPackage and message endpoints.
// Every test exercises an actual HTTP call against the sync-server — DB-only
// assertions (plain SELECTs) do not verify that the server gate exists.
//
// Covered gates:
//   1. GET /:spaceId/mls/key-packages/:did requires an `accepted` invite
//      for the target DID (regardless of caller's UCAN capability).
//   2. GET /:spaceId/mls/messages requires the caller's UCAN chain to root
//      in the space owner, which an outsider cannot produce.

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
import { LegacySpaceCapabilities as SpaceCapabilities } from "../../helpers/legacy-space-capabilities";

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
  // Message read gate — the UCAN chain must root in the space owner
  // ==========================================================================

  test("Outsider cannot read MLS messages of a space they are not in", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // fetchMlsMessages builds a self-signed UCAN claiming `space/read`. Its
    // signature verifies — that only proves who issued it, never that they had
    // standing to. The server anchors authority on `spaces.ownerId`: every root
    // of the proof forest must be the owner. The outsider's own DID is the root
    // of their self-signed token, and they cannot obtain an owner-signed
    // delegation, so there is no token shape that gets them in. That is the
    // property under test, and it is why the refusal is not incidental.
    //
    // Asserted on the 403 plus the `Forbidden` prefix that every authorization
    // refusal in the server's capability middleware carries — enough to
    // distinguish an authorization refusal from a 400 validation error or a
    // "not found", without pinning the reason clause, which has already
    // drifted once. The empty-body check is the real intent: nothing leaked.
    const res = await fetchMlsMessages(outsiderAuth, spaceId);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/^forbidden/i);
    expect(body.messages).toBeUndefined();
  });
});
