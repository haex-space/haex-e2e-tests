// tests/helpers/mls-helpers.ts
//
// MLS delivery helpers for E2E tests.
// Wraps the sync-server MLS API endpoints for Key Packages, Messages, Welcomes, and Rejoin.

import * as crypto from "crypto";
import {
  getSyncServerUrl,
  type AuthContext,
} from "./sync-server-helpers";
import {
  createUcan,
  createWebCryptoSigner,
  spaceResource,
  type Capability,
} from "@haex-space/ucan";

const SYNC_SERVER_URL = getSyncServerUrl();

// =============================================================================
// UCAN Helper
// =============================================================================

/**
 * Build a cryptographically signed UCAN Authorization header for space-scoped MLS operations.
 */
async function buildUcanAuthHeader(auth: AuthContext, spaceId: string, capability: Capability): Promise<string> {
  const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");
  const privateKey = await importUserPrivateKeyAsync(auth.privateKeyBase64);
  const sign = createWebCryptoSigner(privateKey);

  const token = await createUcan(
    {
      issuer: auth.did,
      audience: auth.did,
      capabilities: { [spaceResource(spaceId)]: capability },
      expiration: Math.floor(Date.now() / 1000) + 3600,
    },
    sign,
  );

  return `UCAN ${token}`;
}

// =============================================================================
// MLS Key Packages
// =============================================================================

/**
 * Upload dummy MLS KeyPackages for a member.
 */
export async function uploadKeyPackages(
  auth: AuthContext,
  spaceId: string,
  count: number = 10,
): Promise<Response> {
  const keyPackages = Array.from({ length: count }, () =>
    crypto.randomBytes(64).toString("base64"),
  );

  const bodyStr = JSON.stringify({ keyPackages });
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/read");

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/mls/key-packages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: bodyStr,
  });
}

// =============================================================================
// MLS Messages
// =============================================================================

/**
 * Send an MLS message (commit or application) with optional GroupInfo.
 */
export async function sendMlsMessage(
  auth: AuthContext,
  spaceId: string,
  payload: string,
  messageType: "commit" | "application",
  options?: { epoch?: number; groupInfo?: string },
): Promise<Response> {
  const bodyObj: Record<string, unknown> = {
    payload,
    messageType,
  };
  if (options?.epoch !== undefined) bodyObj.epoch = options.epoch;
  if (options?.groupInfo) bodyObj.groupInfo = options.groupInfo;

  const bodyStr = JSON.stringify(bodyObj);
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/write");

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/mls/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: bodyStr,
  });
}

/**
 * Fetch MLS messages after a given ID.
 */
export async function fetchMlsMessages(
  auth: AuthContext,
  spaceId: string,
  afterId: number = 0,
): Promise<Response> {
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/read");

  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/messages?after=${afterId}`,
    {
      headers: {
        Authorization: authorization,
      },
    },
  );
}

// =============================================================================
// MLS Rejoin (External Commit)
// =============================================================================

/**
 * Request GroupInfo for External Commit rejoin.
 */
export async function requestRejoin(
  auth: AuthContext,
  spaceId: string,
): Promise<Response> {
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/read");

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/mls/rejoin`, {
    method: "POST",
    headers: {
      Authorization: authorization,
    },
  });
}

/**
 * Submit an External Commit to rejoin the MLS group.
 */
export async function submitExternalCommit(
  auth: AuthContext,
  spaceId: string,
  commitBase64: string,
): Promise<Response> {
  const bodyStr = JSON.stringify({ commit: commitBase64 });
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/read");

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/mls/external-commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: bodyStr,
  });
}
