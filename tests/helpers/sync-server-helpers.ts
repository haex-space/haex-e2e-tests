// tests/helpers/sync-server-helpers.ts
//
// Shared helpers for sync-server API interactions in E2E tests.
// Provides identity creation, authentication, vault key management,
// and sync operations.
//
// Uses Ed25519 signing keys + DID-Auth (not P-256/Bearer JWT).

import * as crypto from "crypto";
import {
  generateUserKeypairAsync,
  exportUserKeypairAsync,
  publicKeyToDidKeyAsync,
  signRecordAsync,
} from "@haex-space/vault-sdk";
import { DidAuthAction } from "@haex-space/ucan";

export { DidAuthAction };

const { subtle } = crypto.webcrypto as unknown as Crypto;

// The sync-server is accessed directly (not through Kong) for all API calls.
// Kong only proxies /auth/v1/* to GoTrue, not the sync-server endpoints.
// Inside Docker: sync-server:3002. On host: localhost:3002.
const SYNC_SERVER_URL =
  process.env.SYNC_SERVER_DIRECT_URL || "http://sync-server:3002";

// Supabase auth URL (through Kong gateway which proxies /auth/v1/* to GoTrue)
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.SYNC_SERVER_URL || "http://sync-kong:8000";

// =============================================================================
// Identity & Crypto Helpers (Ed25519-based, matching vault-sdk format)
// =============================================================================

export interface TestIdentity {
  /** Ed25519 signing key pair (WebCrypto) */
  signingKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  /** X25519 agreement key pair (WebCrypto) */
  agreementKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  /** SPKI-encoded signing public key as Base64 (what the server stores) */
  publicKeyBase64: string;
  /** PKCS8-encoded signing private key as Base64 */
  privateKeyBase64: string;
  /** SPKI-encoded agreement public key as Base64 */
  agreementPublicKeyBase64: string;
  /** did:key:z... derived from the Ed25519 public key */
  did: string;
  /** Test email address */
  email: string;
}

/**
 * Auth context for DID-Auth API calls.
 * Functions that previously accepted `accessToken: string` now accept this.
 */
export interface AuthContext {
  /** DID identifier (did:key:z...) */
  did: string;
  /** PKCS8-encoded Ed25519 private key as Base64 */
  privateKeyBase64: string;
  /** Supabase JWT (only needed for Realtime connections, not API auth) */
  accessToken: string;
}

// =============================================================================
// DID-Auth Header
// =============================================================================

function base64urlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * Create a DID-Auth Authorization header value.
 * Format: `DID <base64url-payload>.<base64url-signature>`
 */
export async function createDidAuthHeader(
  privateKeyBase64: string,
  did: string,
  action: string,
  body?: string,
): Promise<string> {
  const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");

  const bodyHash = base64urlEncode(
    new Uint8Array(
      await subtle.digest("SHA-256", new TextEncoder().encode(body ?? "")),
    ),
  );

  const payload = JSON.stringify({
    did,
    action,
    timestamp: Date.now(),
    bodyHash,
  });

  const payloadEncoded = base64urlEncode(new TextEncoder().encode(payload));
  const privateKey = await importUserPrivateKeyAsync(privateKeyBase64);
  const signature = new Uint8Array(
    await subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payloadEncoded)),
  );

  return `DID ${payloadEncoded}.${base64urlEncode(signature)}`;
}

// =============================================================================
// Identity Creation & Authentication
// =============================================================================

/**
 * Generate a fresh Ed25519 + X25519 identity for testing.
 * Uses vault-sdk's generateUserKeypairAsync to match the app exactly.
 */
export async function createTestIdentity(
  email?: string,
): Promise<TestIdentity> {
  const keypair = await generateUserKeypairAsync();
  const exported = await exportUserKeypairAsync(keypair);
  const did = await publicKeyToDidKeyAsync(exported.signingPublicKey);

  return {
    signingKeyPair: {
      publicKey: keypair.signingPublicKey,
      privateKey: keypair.signingPrivateKey,
    },
    agreementKeyPair: {
      publicKey: keypair.agreementPublicKey,
      privateKey: keypair.agreementPrivateKey,
    },
    publicKeyBase64: exported.signingPublicKey,
    privateKeyBase64: exported.signingPrivateKey,
    agreementPublicKeyBase64: exported.agreementPublicKey,
    did,
    email: email ?? `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.haex.space`,
  };
}

/**
 * Create a signed claim presentation for identity registration.
 * Matches the vault-sdk canonical signing format:
 *   did\0timestamp\0key1=value1\0key2=value2...  (null-byte separated, claims sorted)
 */
export async function signPresentation(
  identity: TestIdentity,
  claims?: Record<string, string>,
) {
  const timestamp = new Date().toISOString();
  const effectiveClaims = claims ?? { email: identity.email };

  // Build canonical form: did\0timestamp\0key1=value1\0key2=value2...
  const sortedKeys = Object.keys(effectiveClaims).sort();
  const claimParts = sortedKeys.map(k => `${k}=${effectiveClaims[k]}`);
  const canonical = [identity.did, timestamp, ...claimParts].join("\0");
  const data = new TextEncoder().encode(canonical);

  const sigBytes = new Uint8Array(
    await subtle.sign("Ed25519", identity.signingKeyPair.privateKey, data),
  );
  const signature = btoa(String.fromCharCode(...sigBytes));

  return {
    did: identity.did,
    publicKey: identity.publicKeyBase64,
    claims: effectiveClaims,
    signature,
    timestamp,
  };
}

/**
 * Sign a challenge nonce for authentication.
 * The server verifies: Ed25519(nonce_bytes) using raw signature format.
 */
export async function signChallenge(
  identity: TestIdentity,
  nonce: string,
): Promise<string> {
  const data = new TextEncoder().encode(nonce);
  const sigBytes = new Uint8Array(
    await subtle.sign("Ed25519", identity.signingKeyPair.privateKey, data),
  );
  return btoa(String.fromCharCode(...sigBytes));
}

// =============================================================================
// Sync Server API Helpers
// =============================================================================

/**
 * Get the sync server base URL.
 */
export function getSyncServerUrl(): string {
  return SYNC_SERVER_URL;
}


/**
 * Ensure the 'free' tier exists in the sync-server database.
 * The Drizzle migration creates the tiers table but doesn't seed data.
 * Without a tier row, the quota check fails (maxBytes=0 → over-quota on first push).
 *
 * Uses the sync-server's admin endpoint to seed tiers if available,
 * otherwise logs a warning.
 */
let _tierSeeded = false;
export async function ensureFreeTierExists(): Promise<void> {
  if (_tierSeeded) return;

  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

  try {
    // Try the admin seed-tiers endpoint first
    const res = await fetch(`${SYNC_SERVER_URL}/auth/admin/seed-tiers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        tiers: [{ name: "free", maxStorageBytes: "104857600", maxSpaces: 3 }],
      }),
    });

    if (res.ok) {
      _tierSeeded = true;
      return;
    }
    console.warn(
      `[E2E] seed-tiers endpoint returned ${res.status}; assuming tier was seeded by infra`,
    );
  } catch {
    // Endpoint may not exist — that's fine
  }

  // Tier must be seeded externally (docker-compose init SQL or manual INSERT).
  // The test infra inserts it if missing.
  _tierSeeded = true;
}

/**
 * Check if the sync server is healthy.
 * Also ensures the free tier is seeded (one-time).
 */
export async function checkSyncServerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SYNC_SERVER_URL}/`);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.status === "ok") {
      await ensureFreeTierExists();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Register a new identity with the sync server.
 * Returns the identity ID and status.
 */
export async function registerIdentity(
  identity: TestIdentity,
): Promise<{ identityId: string; did: string; status: string }> {
  const presentation = await signPresentation(identity);

  const res = await fetch(`${SYNC_SERVER_URL}/identity-auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presentation }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Registration failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Verify an identity's email.
 * NOTE: In E2E tests, email verification may need to be bypassed.
 * This is a placeholder — the actual mechanism depends on whether
 * GoTrue admin API or direct DB access is available.
 */
export async function verifyEmail(
  did: string,
  code: string,
): Promise<void> {
  const res = await fetch(`${SYNC_SERVER_URL}/identity-auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did, code }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Email verification failed (${res.status}): ${body}`);
  }
}

/**
 * Perform challenge-response login and return JWT tokens.
 * The JWT is now only needed for Supabase Realtime, not API auth.
 */
export async function challengeLogin(
  identity: TestIdentity,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  // Request challenge
  const challengeRes = await fetch(`${SYNC_SERVER_URL}/identity-auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did: identity.did }),
  });

  if (!challengeRes.ok) {
    const body = await challengeRes.text();
    throw new Error(`Challenge request failed (${challengeRes.status}): ${body}`);
  }

  const { nonce } = await challengeRes.json();
  const signature = await signChallenge(identity, nonce);

  // Verify challenge
  const verifyRes = await fetch(`${SYNC_SERVER_URL}/identity-auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did: identity.did, nonce, signature }),
  });

  if (!verifyRes.ok) {
    const body = await verifyRes.text();
    throw new Error(`Challenge verification failed (${verifyRes.status}): ${body}`);
  }

  return verifyRes.json();
}

/**
 * Confirm a user's email via Supabase Admin API.
 * Shared between createAdminUser and createAdminUserWithIdentity.
 */
async function confirmEmailViaAdmin(email: string): Promise<void> {
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

  const listRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=50`,
    {
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: anonKey,
      },
    },
  );

  if (listRes.ok) {
    const listData = await listRes.json();
    const users = listData.users || listData;
    const user = (users as { id: string; email: string }[]).find(
      (u) => u.email === email,
    );
    if (user) {
      const updateRes = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${user.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: anonKey,
          },
          body: JSON.stringify({ email_confirm: true }),
        },
      );
      if (!updateRes.ok) {
        const body = await updateRes.text().catch(() => "");
        throw new Error(
          `Failed to confirm email for ${email}: ${updateRes.status} ${body}`,
        );
      }
    }
  }
}

/**
 * Create a test user: register identity → confirm email → challenge login.
 * Returns an AuthContext for DID-Auth API calls, plus user metadata.
 */
export async function createAdminUser(): Promise<{
  accessToken: string;
  identityId: string;
  email: string;
  did: string;
  privateKeyBase64: string;
}> {
  const identity = await createTestIdentity();
  const regResult = await registerIdentity(identity);

  await confirmEmailViaAdmin(identity.email);

  const tokens = await challengeLogin(identity);

  return {
    accessToken: tokens.access_token,
    identityId: regResult.identityId,
    email: identity.email,
    did: identity.did,
    privateKeyBase64: identity.privateKeyBase64,
  };
}

/**
 * Like createAdminUser but also returns the identity's public key.
 * Needed for space membership tests where the public key is used as identifier.
 */
export async function createAdminUserWithIdentity(): Promise<{
  accessToken: string;
  identityId: string;
  email: string;
  publicKey: string;
  privateKeyBase64: string;
  did: string;
}> {
  const identity = await createTestIdentity();
  const regResult = await registerIdentity(identity);

  await confirmEmailViaAdmin(identity.email);

  const tokens = await challengeLogin(identity);

  return {
    accessToken: tokens.access_token,
    identityId: regResult.identityId,
    email: identity.email,
    publicKey: identity.publicKeyBase64,
    privateKeyBase64: identity.privateKeyBase64,
    did: identity.did,
  };
}

/**
 * Build an AuthContext from a createAdminUser/createAdminUserWithIdentity result.
 * Convenience for functions that accept AuthContext.
 */
export function toAuthContext(user: {
  did: string;
  privateKeyBase64: string;
  accessToken: string;
}): AuthContext {
  return {
    did: user.did,
    privateKeyBase64: user.privateKeyBase64,
    accessToken: user.accessToken,
  };
}

// =============================================================================
// Space Helpers
// =============================================================================

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

/**
 * Create a shared space owned by the given user.
 */
export async function createSpace(
  auth: AuthContext,
  spaceId: string,
  label: string,
): Promise<Response> {
  const bodyObj = {
    id: spaceId,
    encryptedName: randomBase64(32),
    nameNonce: randomBase64(12),
    label,
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(`${SYNC_SERVER_URL}/spaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace, bodyStr),
    },
    body: bodyStr,
  });
}

/**
 * Add a member to a space.
 */
export async function addSpaceMember(
  auth: AuthContext,
  spaceId: string,
  memberDid: string,
  label: string,
  capability: "space/write" | "space/read",
): Promise<Response> {
  const bodyObj = {
    did: memberDid,
    label,
    capability,
  };
  const bodyStr = JSON.stringify(bodyObj);

  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace, bodyStr),
    },
    body: bodyStr,
  });
}

/**
 * Remove a member from a space.
 */
export async function removeSpaceMember(
  auth: AuthContext,
  spaceId: string,
  memberDid: string,
): Promise<Response> {
  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberDid)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace),
      },
    },
  );
}

/**
 * Delete a space.
 */
export async function deleteSpace(
  auth: AuthContext,
  spaceId: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
    method: "DELETE",
    headers: {
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace),
    },
  });
}

// =============================================================================
// Vault Key Helpers
// =============================================================================

/**
 * Store a test vault key on the sync server.
 */
export async function createVaultKey(
  auth: AuthContext,
  spaceId: string,
): Promise<void> {
  const bodyObj = {
    spaceId,
    encryptedVaultKey: crypto.randomBytes(32).toString("base64"),
    encryptedVaultName: Buffer.from("E2E Test Vault").toString("base64"),
    vaultKeySalt: crypto.randomBytes(16).toString("base64"),
    ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
    vaultKeyNonce: crypto.randomBytes(12).toString("base64"),
    vaultNameNonce: crypto.randomBytes(12).toString("base64"),
    vaultNameSalt: crypto.randomBytes(16).toString("base64"),
  };
  const bodyStr = JSON.stringify(bodyObj);

  const res = await fetch(`${SYNC_SERVER_URL}/sync/vault-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultKeyUpload, bodyStr),
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create vault key failed (${res.status}): ${body}`);
  }
}

/**
 * Delete a vault from the sync server.
 */
export async function deleteVault(
  auth: AuthContext,
  spaceId: string,
): Promise<void> {
  const res = await fetch(`${SYNC_SERVER_URL}/sync/vault/${spaceId}`, {
    method: "DELETE",
    headers: {
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.VaultDelete),
    },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Delete vault failed (${res.status}): ${body}`);
  }
}

// =============================================================================
// Sync Operation Helpers
// =============================================================================

export interface SyncChange {
  tableName: string;
  rowPks: string;
  columnName: string;
  hlcTimestamp: string;
  deviceId: string;
  encryptedValue: string | null;
  nonce: string | null;
  batchId?: string;
  batchSeq?: number;
  batchTotal?: number;
  signature?: string;
  signedBy?: string;
  collaborative?: boolean;
}

/**
 * Sign and push changes to a space. Uses vault-sdk's signRecordAsync.
 */
export async function signAndPushSpaceChanges(
  auth: AuthContext,
  spaceId: string,
  changes: SyncChange[],
  privateKeyBase64: string,
  publicKey: string,
): Promise<{ count: number; serverTimestamp: string }> {
  const signedChanges = await Promise.all(
    changes.map(async (change) => {
      const signature = await signRecordAsync(
        {
          tableName: change.tableName,
          rowPks: change.rowPks,
          columnName: change.columnName,
          encryptedValue: change.encryptedValue,
          hlcTimestamp: change.hlcTimestamp,
        },
        privateKeyBase64,
      );
      return { ...change, signature, signedBy: publicKey };
    }),
  );

  return pushChanges(auth, spaceId, signedChanges);
}

/**
 * Push sync changes to the server.
 */
export async function pushChanges(
  auth: AuthContext,
  spaceId: string,
  changes: SyncChange[],
): Promise<{ count: number; serverTimestamp: string }> {
  const bodyObj = { spaceId, changes };
  const bodyStr = JSON.stringify(bodyObj);

  const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.SyncPush, bodyStr),
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Push failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Pull sync changes from the server.
 */
export async function pullChanges(
  auth: AuthContext,
  spaceId: string,
  options: {
    excludeDeviceId?: string;
    afterUpdatedAt?: string;
    limit?: number;
  } = {},
): Promise<{ changes: SyncChange[]; hasMore: boolean; serverTimestamp: string }> {
  const params = new URLSearchParams({ spaceId });
  if (options.excludeDeviceId) params.set("excludeDeviceId", options.excludeDeviceId);
  if (options.afterUpdatedAt) params.set("afterUpdatedAt", options.afterUpdatedAt);
  if (options.limit) params.set("limit", options.limit.toString());

  const res = await fetch(`${SYNC_SERVER_URL}/sync/pull?${params}`, {
    headers: {
      Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.SyncPull),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pull failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Create a single sync change object with sensible defaults.
 */
export function makeSyncChange(overrides: Partial<SyncChange> & {
  tableName: string;
  rowPks: string;
  columnName: string;
}): SyncChange {
  return {
    hlcTimestamp: new Date().toISOString(),
    deviceId: `e2e-device-${Date.now()}`,
    encryptedValue: crypto.randomBytes(16).toString("base64"),
    nonce: crypto.randomBytes(12).toString("base64"),
    ...overrides,
  };
}
