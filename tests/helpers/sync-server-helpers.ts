// tests/helpers/sync-server-helpers.ts
//
// Shared helpers for sync-server API interactions in E2E tests.
// Provides identity creation, authentication, vault key management,
// and sync operations.

import * as crypto from "crypto";

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
// Identity & Crypto Helpers (WebCrypto-based, matching vault-sdk format)
// =============================================================================

export interface TestIdentity {
  /** WebCrypto key pair */
  cryptoKeyPair: CryptoKeyPair;
  /** SPKI-encoded public key as Base64 (what the server stores) */
  publicKeyBase64: string;
  /** did:key:z... derived from the compressed P-256 point */
  did: string;
  /** Test email address */
  email: string;
}

// Base58-btc alphabet (no 0, O, I, l)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    zeros++;
  }

  // Convert to big integer and encode
  let num = BigInt(0);
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  let result = "";
  while (num > 0n) {
    const mod = Number(num % 58n);
    result = BASE58_ALPHABET[mod] + result;
    num = num / 58n;
  }

  return "1".repeat(zeros) + result;
}

/**
 * Compress a P-256 uncompressed point (65 bytes: 0x04 || X || Y) to 33 bytes.
 */
function compressP256Point(raw: Uint8Array): Uint8Array {
  // raw[0] === 0x04 (uncompressed), raw[1..32] = X, raw[33..64] = Y
  const x = raw.slice(1, 33);
  const yLastByte = raw[64];
  const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

/**
 * Derive a did:key from a SPKI Base64-encoded P-256 public key.
 * Uses the same algorithm as vault-sdk: multicodec 0x8024 + compressed point + base58btc.
 */
async function publicKeyToDidKey(spkiBase64: string): Promise<string> {
  // Import SPKI to get a CryptoKey, then export as raw to get the uncompressed point
  const spkiBytes = Uint8Array.from(atob(spkiBase64), c => c.charCodeAt(0));
  const key = await subtle.importKey(
    "spki", spkiBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    true, ["verify"],
  );
  const rawBytes = new Uint8Array(await subtle.exportKey("raw", key));
  const compressed = compressP256Point(rawBytes);

  // Prepend multicodec prefix for P-256: [0x80, 0x24]
  const multicodec = new Uint8Array(2 + compressed.length);
  multicodec[0] = 0x80;
  multicodec[1] = 0x24;
  multicodec.set(compressed, 2);

  return `did:key:z${base58btcEncode(multicodec)}`;
}

/**
 * Generate a fresh ECDSA P-256 identity for testing.
 * Uses WebCrypto to match the vault-sdk format exactly.
 */
export async function createTestIdentity(
  email?: string,
): Promise<TestIdentity> {
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const spkiBytes = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
  const publicKeyBase64 = btoa(String.fromCharCode(...spkiBytes));
  const did = await publicKeyToDidKey(publicKeyBase64);

  return {
    cryptoKeyPair: keyPair,
    publicKeyBase64,
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
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.cryptoKeyPair.privateKey, data),
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
 * The server verifies: ECDSA-SHA256(nonce_bytes) using raw signature format.
 */
export async function signChallenge(
  identity: TestIdentity,
  nonce: string,
): Promise<string> {
  const data = new TextEncoder().encode(nonce);
  const sigBytes = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.cryptoKeyPair.privateKey, data),
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
 * Create a test user via the admin API (Supabase-based) and return an auth token.
 * This is the simplest way to get a JWT for sync-server tests.
 */
export async function createAdminUser(): Promise<{
  accessToken: string;
  userId: string;
  email: string;
}> {
  // The sync server now requires a registered identity (for quota tracking).
  // Flow: register identity → server creates GoTrue user → confirm email → challenge login → JWT.
  const identity = await createTestIdentity();
  const regResult = await registerIdentity(identity);

  // Confirm the user's email via Supabase Admin API so challenge-login works.
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

  // List GoTrue users to find the one created for this identity
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
      (u) => u.email === identity.email,
    );
    if (user) {
      // Confirm email via admin API
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: anonKey,
        },
        body: JSON.stringify({ email_confirm: true }),
      });
    }
  }

  // Now perform challenge-login to get JWT tokens
  const tokens = await challengeLogin(identity);

  return {
    accessToken: tokens.access_token,
    userId: regResult.identityId,
    email: identity.email,
  };
}

/**
 * Like createAdminUser but also returns the identity's public key.
 * Needed for space membership tests where the public key is used as identifier.
 */
export async function createAdminUserWithIdentity(): Promise<{
  accessToken: string;
  userId: string;
  email: string;
  publicKey: string;
  privateKeyBase64: string;
}> {
  const identity = await createTestIdentity();
  const regResult = await registerIdentity(identity);

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
      (u) => u.email === identity.email,
    );
    if (user) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: anonKey,
        },
        body: JSON.stringify({ email_confirm: true }),
      });
    }
  }

  const tokens = await challengeLogin(identity);

  // Export private key as Base64 PKCS8 for signRecordAsync
  const pkcs8Bytes = new Uint8Array(
    await subtle.exportKey("pkcs8", identity.cryptoKeyPair.privateKey),
  );
  const privateKeyBase64 = btoa(String.fromCharCode(...pkcs8Bytes));

  return {
    accessToken: tokens.access_token,
    userId: regResult.identityId,
    email: identity.email,
    publicKey: identity.publicKeyBase64,
    privateKeyBase64,
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
  accessToken: string,
  spaceId: string,
  label: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      id: spaceId,
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
      label,
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
      },
    }),
  });
}

/**
 * Add a member to a space.
 */
export async function addSpaceMember(
  adminToken: string,
  spaceId: string,
  memberPublicKey: string,
  label: string,
  role: "owner" | "member" | "reader",
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      publicKey: memberPublicKey,
      label,
      role,
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
        generation: 1,
      },
    }),
  });
}

/**
 * Remove a member from a space.
 */
export async function removeSpaceMember(
  adminToken: string,
  spaceId: string,
  memberPublicKey: string,
): Promise<Response> {
  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/members/${encodeURIComponent(memberPublicKey)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    },
  );
}

/**
 * Delete a space.
 */
export async function deleteSpace(
  adminToken: string,
  spaceId: string,
): Promise<Response> {
  return fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

/**
 * Insert a broadcast message directly into realtime.messages via the sync-db container.
 * Used for testing broadcast delivery without needing Push endpoint signatures.
 * Topic and event are sanitized (only alphanumeric, hyphens, colons allowed).
 */
export async function insertBroadcastMessage(
  topic: string,
  event = "INSERT",
): Promise<void> {
  const { execFileSync } = await import("child_process");
  // Sanitize inputs to prevent injection
  const safeTopic = topic.replace(/[^a-zA-Z0-9:\-_]/g, "");
  const safeEvent = event.replace(/[^A-Z]/g, "");
  execFileSync("docker", [
    "exec", "haex_e2e_sync_db", "psql", "-U", "postgres", "-d", "postgres", "-c",
    `INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES ('${safeTopic}', 'broadcast', '${safeEvent}', '{"op": "${safeEvent}"}'::jsonb, true);`,
  ], { stdio: "pipe" });
}

// =============================================================================
// Vault Key Helpers
// =============================================================================

/**
 * Store a test vault key on the sync server.
 */
export async function createVaultKey(
  accessToken: string,
  vaultId: string,
): Promise<void> {
  const res = await fetch(`${SYNC_SERVER_URL}/sync/vault-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      vaultId,
      encryptedVaultKey: crypto.randomBytes(32).toString("base64"),
      encryptedVaultName: Buffer.from("E2E Test Vault").toString("base64"),
      vaultKeySalt: crypto.randomBytes(16).toString("base64"),
      ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
      vaultKeyNonce: crypto.randomBytes(12).toString("base64"),
      vaultNameNonce: crypto.randomBytes(12).toString("base64"),
    }),
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
  accessToken: string,
  vaultId: string,
): Promise<void> {
  const res = await fetch(`${SYNC_SERVER_URL}/sync/vault/${vaultId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
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
  accessToken: string,
  spaceId: string,
  changes: SyncChange[],
  privateKeyBase64: string,
  publicKey: string,
): Promise<{ count: number; serverTimestamp: string }> {
  const { signRecordAsync } = await import("@haex-space/vault-sdk");

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

  return pushChanges(accessToken, spaceId, signedChanges);
}

/**
 * Push sync changes to the server.
 */
export async function pushChanges(
  accessToken: string,
  vaultId: string,
  changes: SyncChange[],
): Promise<{ count: number; serverTimestamp: string }> {
  const res = await fetch(`${SYNC_SERVER_URL}/sync/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ vaultId, changes }),
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
  accessToken: string,
  vaultId: string,
  options: {
    excludeDeviceId?: string;
    afterUpdatedAt?: string;
    limit?: number;
  } = {},
): Promise<{ changes: SyncChange[]; hasMore: boolean; serverTimestamp: string }> {
  const params = new URLSearchParams({ vaultId });
  if (options.excludeDeviceId) params.set("excludeDeviceId", options.excludeDeviceId);
  if (options.afterUpdatedAt) params.set("afterUpdatedAt", options.afterUpdatedAt);
  if (options.limit) params.set("limit", options.limit.toString());

  const res = await fetch(`${SYNC_SERVER_URL}/sync/pull?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
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
