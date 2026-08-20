// tests/helpers/invite-helpers.ts
//
// Shared helpers for space invitation E2E tests.
// Adapted to the actual sync server API (v0.11+).
//
// Key differences from a naive implementation:
// - createServerInvite requires a UCAN token (not just capability string)
// - acceptServerInvite requires MLS KeyPackages
// - The owner authenticates with DID-Auth; a delegated member must use a UCAN,
//   because the server accepts DID-Auth only from the space owner

import * as crypto from "crypto";
import {
  getSyncServerUrl,
  createDidAuthHeader,
  DidAuthAction,
  type AuthContext,
} from "./sync-server-helpers";
import {
  buildSignedUcan,
  buildUcanAuthHeader,
  type DelegatedSpaceAuth,
  type SpaceAuth,
} from "./mls-helpers";
import {
  createUcan,
  createWebCryptoSigner,
  spaceCapabilitySetFromEntries,
  spaceResource,
  type SpaceCap,
} from "@haex-space/ucan";

const SYNC_SERVER_URL = getSyncServerUrl();

function isDelegated(auth: SpaceAuth): auth is DelegatedSpaceAuth {
  return "owner" in auth;
}

/** The DID that will present the request, whichever auth scheme is used. */
function callerOf(auth: SpaceAuth): AuthContext {
  return isDelegated(auth) ? auth.member : auth;
}

// =============================================================================
// Server Invite API Helpers
// =============================================================================

/**
 * Create a server-side invite for a specific DID.
 * The server requires a UCAN delegation token signed by the inviter.
 *
 * A plain {@link AuthContext} authenticates with DID-Auth, which the server
 * honours only for the space owner. A {@link DelegatedSpaceAuth} member
 * authenticates with its owner-rooted UCAN instead — the same scheme the real
 * client uses for this route (`fetchWithUcanAuth` in
 * haex-vault/src/stores/spaces/invites.ts).
 */
export async function createServerInvite(
  auth: SpaceAuth,
  spaceId: string,
  inviteeDid: string,
  capability: string,
  includeHistory = false,
): Promise<Response> {
  const ucan = await buildSignedUcanForInvite(auth, inviteeDid, spaceId, capability);

  const bodyObj = {
    inviteeDid,
    ucan,
    includeHistory,
  };
  const bodyStr = JSON.stringify(bodyObj);

  const caller = callerOf(auth);
  const authorization = isDelegated(auth)
    ? await buildUcanAuthHeader(auth, spaceId, "invite")
    : await createDidAuthHeader(
        caller.privateKeyBase64,
        caller.did,
        DidAuthAction.CreateSpace,
        bodyStr,
      );

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: bodyStr,
  });
}

/**
 * Accept a server-side invite.
 * Requires MLS KeyPackages (we send a dummy for E2E since MLS isn't tested here).
 */
export async function acceptServerInvite(
  auth: AuthContext,
  spaceId: string,
  inviteId: string,
): Promise<Response> {
  const bodyObj = {
    keyPackages: [crypto.randomBytes(64).toString("base64")],
    pops: [crypto.randomBytes(64).toString("base64")],
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/invites/${inviteId}/accept`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(
          auth.privateKeyBase64,
          auth.did,
          DidAuthAction.AcceptInvite,
          bodyStr,
        ),
      },
      body: bodyStr,
    },
  );
}

/**
 * Decline a server-side invite.
 */
export async function declineServerInvite(
  auth: AuthContext,
  spaceId: string,
  inviteId: string,
): Promise<Response> {
  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/invites/${inviteId}/decline`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(
          auth.privateKeyBase64,
          auth.did,
          DidAuthAction.DeclineInvite,
        ),
      },
    },
  );
}

/**
 * List invites for a space.
 */
export async function listPendingInvites(
  auth: AuthContext,
  spaceId: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
    headers: {
      Authorization: await createDidAuthHeader(
        auth.privateKeyBase64,
        auth.did,
        DidAuthAction.ListSpaces,
      ),
    },
  });
}

// =============================================================================
// Invite Token API Helpers (link/QR-based invites)
// =============================================================================

/**
 * Create an invite token (link-based, no specific target DID).
 */
export async function createInviteToken(
  auth: AuthContext,
  spaceId: string,
  options: {
    capability: string;
    maxUses?: number;
    expiresInSeconds?: number;
    label?: string;
  },
): Promise<Response> {
  const bodyObj = {
    capability: options.capability,
    maxUses: options.maxUses ?? 1,
    expiresInSeconds: options.expiresInSeconds ?? 7 * 24 * 3600,
    label: options.label,
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createDidAuthHeader(
        auth.privateKeyBase64,
        auth.did,
        DidAuthAction.CreateSpace,
        bodyStr,
      ),
    },
    body: bodyStr,
  });
}

/**
 * Claim an invite token (join a space via token).
 */
export async function claimInviteToken(
  auth: AuthContext,
  spaceId: string,
  tokenId: string,
  label?: string,
): Promise<Response> {
  const bodyObj = {
    label: label ?? "E2E Claimer",
    keyPackages: [crypto.randomBytes(64).toString("base64")],
    pops: [crypto.randomBytes(64).toString("base64")],
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${tokenId}/claim`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(
          auth.privateKeyBase64,
          auth.did,
          DidAuthAction.AcceptInvite,
          bodyStr,
        ),
      },
      body: bodyStr,
    },
  );
}

/**
 * Revoke an invite token.
 */
export async function revokeInviteToken(
  auth: AuthContext,
  spaceId: string,
  tokenId: string,
): Promise<Response> {
  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens/${tokenId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: await createDidAuthHeader(
          auth.privateKeyBase64,
          auth.did,
          DidAuthAction.CreateSpace,
        ),
      },
    },
  );
}

/**
 * List invite tokens for a space.
 */
export async function listInviteTokens(
  auth: AuthContext,
  spaceId: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invite-tokens`, {
    headers: {
      Authorization: await createDidAuthHeader(
        auth.privateKeyBase64,
        auth.did,
        DidAuthAction.ListSpaces,
      ),
    },
  });
}

// =============================================================================
// UCAN Retrieval Helper
// =============================================================================

/**
 * Retrieve the UCAN token from an accepted invite.
 */
export async function getInviteUcan(
  auth: AuthContext,
  spaceId: string,
  inviteId: string,
): Promise<Response> {
  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/invites/${inviteId}/ucan`,
    {
      headers: {
        Authorization: await createDidAuthHeader(
          auth.privateKeyBase64,
          auth.did,
          DidAuthAction.ListSpaces,
        ),
      },
    },
  );
}

// =============================================================================
// Space Detail Helper
// =============================================================================

/**
 * Get space details including members.
 */
export async function getSpaceDetails(
  auth: AuthContext,
  spaceId: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
    headers: {
      Authorization: await createDidAuthHeader(
        auth.privateKeyBase64,
        auth.did,
        DidAuthAction.ListSpaces,
      ),
    },
  });
}

// =============================================================================
// Test Data Generators
// =============================================================================

/**
 * Generate a unique space ID for tests.
 */
export function generateSpaceId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a realistic endpoint ID (iroh format: 64 hex chars).
 */
export function generateEndpointId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Build the UCAN delegation token an invite carries for its invitee.
 *
 * This is the token the invitee will later present to the server, so it must
 * root in the space owner just like the inviter's own token does. For the
 * owner that is automatic — they sign the root themselves. For a delegated
 * member-inviter the delegation has to be chained under the member's own
 * owner-rooted token (`proofs: [parent]`), matching `delegateUcanAsync` in
 * haex-vault/src/utils/auth/ucanStore.ts. A self-signed member delegation
 * would hand the invitee a token whose forest root is the member, which the
 * server refuses with 403 — the invite would look created but be unusable.
 */
async function buildSignedUcanForInvite(
  auth: SpaceAuth,
  audienceDid: string,
  spaceId: string,
  capability: string,
): Promise<string> {
  const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");
  const inviter = callerOf(auth);
  const privateKey = await importUserPrivateKeyAsync(inviter.privateKeyBase64);
  const sign = createWebCryptoSigner(privateKey);

  // A delegated inviter chains under the token it holds. `buildSignedUcan`
  // mints that parent (owner root → owner-signed leaf for this member); the
  // capability argument is ignored on the delegated path.
  const parent = isDelegated(auth)
    ? await buildSignedUcan(auth, spaceId, "invite")
    : undefined;

  return createUcan(
    {
      issuer: inviter.did,
      audience: audienceDid,
      capabilities: {
        [spaceResource(spaceId)]: spaceCapabilitySetFromEntries([
          { cap: capability.replace("space/", "") as SpaceCap, delegatable: true },
        ]),
      },
      proofs: parent ? [parent] : undefined,
      expiration: Math.floor(Date.now() / 1000) + 86400 * 365,
    },
    sign,
  );
}

/**
 * Build a local invite link (same format as the app).
 */
export function buildLocalInviteLink(params: {
  spaceId: string;
  tokenId: string;
  spaceEndpoints: string[];
}): string {
  const query = new URLSearchParams({
    space: params.spaceId,
    token: params.tokenId,
    endpoints: params.spaceEndpoints.join(","),
  });
  return `haexvault://local-invite?${query}`;
}

/**
 * Build a server invite link (same format as the app).
 */
export function buildServerInviteLink(params: {
  serverUrl: string;
  spaceId: string;
  tokenId: string;
}): string {
  const query = new URLSearchParams({
    server: params.serverUrl,
    space: params.spaceId,
    token: params.tokenId,
  });
  return `haexvault://invite?${query}`;
}
