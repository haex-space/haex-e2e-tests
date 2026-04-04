// tests/helpers/invite-helpers.ts
//
// Shared helpers for space invitation E2E tests.
// Adapted to the actual sync server API (v0.11+).
//
// Key differences from a naive implementation:
// - createServerInvite requires a UCAN token (not just capability string)
// - acceptServerInvite requires MLS KeyPackages
// - Both use DID-Auth headers

import * as crypto from "crypto";
import {
  getSyncServerUrl,
  createDidAuthHeader,
  DidAuthAction,
  type AuthContext,
} from "./sync-server-helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

// =============================================================================
// Server Invite API Helpers
// =============================================================================

/**
 * Create a server-side invite for a specific DID.
 * The server requires a UCAN delegation token. For tests we pass a dummy UCAN
 * since the server validates structure but the E2E flow doesn't verify crypto.
 */
export async function createServerInvite(
  auth: AuthContext,
  spaceId: string,
  inviteeDid: string,
  capability: string,
  includeHistory = false,
): Promise<Response> {
  // Build a minimal test UCAN (the server stores it, doesn't fully validate crypto in dev)
  const dummyUcan = buildTestUcan(auth.did, inviteeDid, spaceId, capability);

  const bodyObj = {
    inviteeDid,
    ucan: dummyUcan,
    includeHistory,
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/invites`, {
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
          DidAuthAction.CreateSpace,
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
          DidAuthAction.CreateSpace,
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
          DidAuthAction.CreateSpace,
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
 * Build a minimal UCAN token for testing.
 * The server stores this as-is; it doesn't fully verify crypto in development mode.
 */
function buildTestUcan(
  issuerDid: string,
  audienceDid: string,
  spaceId: string,
  capability: string,
): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const payload = {
    iss: issuerDid,
    aud: audienceDid,
    att: [{ with: `space:${spaceId}`, can: capability }],
    exp: Math.floor(Date.now() / 1000) + 86400 * 365,
    iat: Math.floor(Date.now() / 1000),
  };

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.randomBytes(64).toString("base64url");

  return `${encode(header)}.${encode(payload)}.${sig}`;
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
