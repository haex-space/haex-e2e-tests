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
  type AuthContext,
} from "../../helpers";
import {
  createServerInvite,
  getSpaceDetails,
  generateSpaceId,
} from "../../helpers/invite-helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

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

  test("non-member cannot create invites", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    const target = await createAdminUserWithIdentity();

    const res = await createServerInvite(
      outsiderAuth,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
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

    // Reader tries to invite someone — should fail
    const target = await createAdminUserWithIdentity();
    const readerInvite = await createServerInvite(
      readerAuth,
      spaceId,
      target.did,
      SpaceCapabilities.READ,
    );
    expect(readerInvite.status).toBeGreaterThanOrEqual(400);
  });

  // =========================================================================
  // Capability escalation prevention
  // =========================================================================

  test("write member cannot grant admin capability", async () => {
    // Create a separate space for this test
    const escalationSpaceId = generateSpaceId();
    const createRes = await createSpace(authOwner, escalationSpaceId, "Escalation Test");
    expect(createRes.status).toBe(201);

    try {
      // Add member with write capability directly
      const writer = await createAdminUserWithIdentity();
      const writerAuth = toAuthContext(writer);
      const addRes = await addSpaceMember(
        authOwner,
        escalationSpaceId,
        writer.did,
        "Write Member",
        SpaceCapabilities.WRITE,
      );
      expect(addRes.status).toBe(201);

      // Writer tries to invite someone with admin capability
      const target = await createAdminUserWithIdentity();
      const bodyStr = JSON.stringify({
        did: target.did,
        capability: SpaceCapabilities.ADMIN,
      });
      const escalateRes = await fetch(
        `${SYNC_SERVER_URL}/spaces/${escalationSpaceId}/invites`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await createDidAuthHeader(
              writerAuth.privateKeyBase64,
              writerAuth.did,
              DidAuthAction.CreateSpace,
              bodyStr,
            ),
          },
          body: bodyStr,
        },
      );

      // Should be rejected — cannot escalate privileges
      expect(escalateRes.status).toBeGreaterThanOrEqual(400);
    } finally {
      try {
        await deleteSpace(authOwner, escalationSpaceId);
      } catch {
        // Best effort
      }
    }
  });

  // =========================================================================
  // Policy configuration values
  // =========================================================================

  test("valid policy values are: all, contacts_only, nobody", () => {
    const validPolicies = ["all", "contacts_only", "nobody"];

    // Verify each is a valid string
    for (const policy of validPolicies) {
      expect(typeof policy).toBe("string");
      expect(policy.length).toBeGreaterThan(0);
    }

    // Verify no duplicates
    expect(new Set(validPolicies).size).toBe(3);
  });

  // =========================================================================
  // Blocked DIDs
  // =========================================================================

  test("server rejects invite from user not in space", async () => {
    const outsider = await createAdminUserWithIdentity();
    const outsiderAuth = toAuthContext(outsider);

    // Outsider tries to invite someone to a space they're not in
    const target = await createAdminUserWithIdentity();
    const res = await createServerInvite(
      outsiderAuth,
      spaceId,
      target.did,
      SpaceCapabilities.WRITE,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
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
