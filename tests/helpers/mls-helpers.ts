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
  createUcanPopHeader,
  createWebCryptoSigner,
  POP_HEADER_NAME,
  spaceCapabilitySet,
  spaceCapabilitySetFromEntries,
  spaceResource,
  type SpaceCap,
  type SpaceCapabilitySet,
} from "@haex-space/ucan";

const SYNC_SERVER_URL = getSyncServerUrl();

// =============================================================================
// UCAN Helper
// =============================================================================

type LegacySpaceCap = `space/${SpaceCap}`;

function normalizeSpaceCap(capability: SpaceCap | LegacySpaceCap): SpaceCap {
  return capability.replace("space/", "") as SpaceCap;
}

/**
 * Auth material for a principal whose space authority was DELEGATED by the
 * space owner instead of self-asserted.
 *
 * The sync-server anchors every UCAN caller on `spaces.ownerId`: each root of
 * the presented proof forest must equal the owner's DID. A self-signed token
 * therefore only works for the owner — for anybody else it is the C1
 * privilege-escalation attack (any member self-signing `admin`) and is
 * refused with 403 regardless of what `space_members` says.
 *
 * Shape mirrors the production client (`createRootUcanAsync` +
 * `delegateUcanAsync` in haex-vault/src/utils/auth/ucanStore.ts):
 *
 *   root   iss = aud = owner, all four caps `delegatable: true`, no proofs
 *   leaf   iss = owner, aud = member, cap = `granted`, proofs = [root]
 *
 * Only the owner signs; the member presents the leaf verbatim, exactly like a
 * real invitee presents the UCAN they received. Consequences worth knowing:
 *
 *   - `member.privateKeyBase64` is unused here. A UCAN is a bearer token —
 *     nothing binds it to its presenter.
 *   - The server identifies UCAN callers by the token's `iss` (see
 *     `getCallerDid` in the sync-server's mls.ts), which on a delegated leaf
 *     is the OWNER. Any route that attributes a side effect to the caller
 *     attributes it to the owner, not to `member`.
 */
export interface DelegatedSpaceAuth {
  /** The delegate — audience of the leaf token. */
  member: AuthContext;
  /** The space owner — root of the proof forest, and the only signer. */
  owner: AuthContext;
  /**
   * Exactly the set the owner delegated. Deliberately NOT widened to the
   * capability a given request needs: a member holds one token with a fixed
   * set, so a request needing a cap outside `granted` must be refused by the
   * server. Widening it per call is what makes a capability test vacuous.
   */
  granted: SpaceCapabilitySet;
}

/** Either a self-signing owner or an owner-delegated member. */
export type SpaceAuth = AuthContext | DelegatedSpaceAuth;

function isDelegated(auth: SpaceAuth): auth is DelegatedSpaceAuth {
  return "owner" in auth;
}

/**
 * Bundle an owner + delegate + granted set into a {@link DelegatedSpaceAuth}.
 *
 * Pass the set the server itself would grant that member — see
 * `presetForLegacyCapability` in ./legacy-space-capabilities.
 */
export function delegatedSpaceAuth(
  owner: AuthContext,
  member: AuthContext,
  granted: SpaceCapabilitySet,
): DelegatedSpaceAuth {
  return { owner, member, granted };
}

/**
 * The owner's root UCAN: self-signed, every cap held and delegatable.
 *
 * Matches `createRootUcanAsync`. All four caps must be `delegatable: true`
 * because `enforceDelegatable` walks SPACE_CAP_ORDER (read, write, invite,
 * admin) and returns on the FIRST offender — a root that withheld
 * delegatable `read` would make every downstream grant fail on `read` before
 * the cap the child actually wants is ever considered.
 */
function ownerRootCapabilities(): SpaceCapabilitySet {
  return spaceCapabilitySet().read(true).write(true).invite(true).admin(true).build();
}

/**
 * Build a cryptographically signed UCAN token for space-scoped MLS operations.
 *
 * For a plain {@link AuthContext} this mints a self-signed root claiming
 * `capability` — correct only when that context IS the space owner, whose DID
 * is the forest root the server demands.
 *
 * For a {@link DelegatedSpaceAuth} it mints the owner-rooted two-token chain
 * described there and `capability` is IGNORED: the member's authority is
 * whatever the owner delegated, and the server decides whether that covers
 * the request.
 */
export async function buildSignedUcan(
  auth: SpaceAuth,
  spaceId: string,
  capability: SpaceCap | LegacySpaceCap,
): Promise<string> {
  const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");
  const expiration = Math.floor(Date.now() / 1000) + 3600;

  if (isDelegated(auth)) {
    const ownerKey = await importUserPrivateKeyAsync(auth.owner.privateKeyBase64);
    const ownerSign = createWebCryptoSigner(ownerKey);

    const rootUcan = await createUcan(
      {
        issuer: auth.owner.did,
        audience: auth.owner.did,
        capabilities: { [spaceResource(spaceId)]: ownerRootCapabilities() },
        expiration,
      },
      ownerSign,
    );

    return createUcan(
      {
        issuer: auth.owner.did,
        audience: auth.member.did,
        capabilities: { [spaceResource(spaceId)]: auth.granted },
        proofs: [rootUcan],
        expiration,
      },
      ownerSign,
    );
  }

  const privateKey = await importUserPrivateKeyAsync(auth.privateKeyBase64);
  const sign = createWebCryptoSigner(privateKey);

  return createUcan(
    {
      issuer: auth.did,
      audience: auth.did,
      capabilities: {
        [spaceResource(spaceId)]: spaceCapabilitySetFromEntries([
          { cap: normalizeSpaceCap(capability), delegatable: true },
        ]),
      },
      expiration,
    },
    sign,
  );
}

/**
 * `Authorization` header value for a space-scoped UCAN request.
 *
 * Exported so specs that hand-roll a `fetch` against a non-MLS route (member
 * management, space admin, sync push) can authenticate a non-owner the way
 * the real client does, instead of falling back to DID-Auth — which the
 * server accepts only from the owner, so every non-owner DID-Auth call is
 * refused before its capability is ever looked at.
 */
export async function buildUcanAuthHeader(
  auth: SpaceAuth,
  spaceId: string,
  capability: SpaceCap | LegacySpaceCap,
): Promise<string> {
  const token = await buildSignedUcan(auth, spaceId, capability);
  return `UCAN ${token}`;
}

/**
 * The DID that PRESENTS the UCAN — the leaf's audience — and whose private key
 * signs the companion `X-UCAN-PoP`.
 *
 * A self-signed root is presented by its issuer (= audience). A delegated leaf
 * is presented by the member, whose DID is the leaf's audience.
 */
function presenterOf(auth: SpaceAuth): AuthContext {
  return isDelegated(auth) ? auth.member : auth;
}

/**
 * Split an URL into the (path, rawQuery) pair the PoP payload signs. `rawQuery`
 * is EVERYTHING after `?` verbatim — no re-encoding, no key sorting, no `?`.
 * Matches the sync-server middleware's canonicalisation.
 */
function splitPathAndQuery(url: string): { path: string; rawQuery: string } {
  const qIdx = url.indexOf("?");
  const noQuery = qIdx === -1 ? url : url.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? "" : url.slice(qIdx + 1);
  // Strip the scheme+host prefix if present, keep only the pathname verbatim.
  const schemeIdx = noQuery.indexOf("://");
  if (schemeIdx === -1) return { path: noQuery, rawQuery };
  const afterScheme = noQuery.slice(schemeIdx + 3);
  const slashIdx = afterScheme.indexOf("/");
  const path = slashIdx === -1 ? "/" : afterScheme.slice(slashIdx);
  return { path, rawQuery };
}

const BODY_BEARING_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Build request headers for a UCAN-authed API call carrying BOTH
 * `Authorization: UCAN <token>` and the companion `X-UCAN-PoP` header signed
 * by the UCAN audience's private key over the request line + body.
 *
 * `sync-server` main enforces `X-UCAN-PoP` on every UCAN-authed route; a
 * request that omits it is refused with 401 before its capability is looked at.
 * Body-bearing methods (POST/PUT/PATCH) additionally need `Content-Length`,
 * which the middleware demands ahead of the PoP check (411 otherwise) — this
 * helper attaches it based on the byte length of `request.body`.
 *
 * Pass the URL through `url` (this helper splits path + rawQuery) OR pass
 * `path`/`rawQuery` directly for a hand-rolled fetch.
 */
export async function buildUcanRequestHeaders(
  auth: SpaceAuth,
  spaceId: string,
  capability: SpaceCap | LegacySpaceCap,
  request:
    | { method?: string; url: string; body?: string; extra?: Record<string, string> }
    | {
        method?: string;
        path: string;
        rawQuery?: string;
        body?: string;
        extra?: Record<string, string>;
      },
): Promise<Record<string, string>> {
  const { importUserPrivateKeyAsync } = await import("@haex-space/vault-sdk");

  const method = (request.method ?? "GET").toUpperCase();
  const body = request.body ?? "";
  const { path, rawQuery } =
    "url" in request
      ? splitPathAndQuery(request.url)
      : { path: request.path, rawQuery: request.rawQuery ?? "" };

  const token = await buildSignedUcan(auth, spaceId, capability);
  const presenter = presenterOf(auth);
  const presenterKey = await importUserPrivateKeyAsync(presenter.privateKeyBase64);

  const pop = await createUcanPopHeader({
    privateKey: presenterKey,
    ucanAud: presenter.did,
    method,
    path,
    rawQuery,
    body,
  });

  const headers: Record<string, string> = {
    Authorization: `UCAN ${token}`,
    [POP_HEADER_NAME]: pop,
    ...(request.extra ?? {}),
  };

  if (BODY_BEARING_METHODS.has(method)) {
    // Byte length, not string length — the middleware compares to the
    // actual body octet count. UTF-8 encoding matches how fetch serialises
    // a string body.
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
  }

  return headers;
}

// =============================================================================
// MLS Key Packages
// =============================================================================

/**
 * Fetch (and consume) one unconsumed KeyPackage for a target DID.
 * Requires `space/invite` capability AND an accepted invite for the target.
 */
export async function fetchKeyPackage(
  auth: SpaceAuth,
  spaceId: string,
  targetDid: string,
): Promise<Response> {
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/key-packages/${encodeURIComponent(targetDid)}`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/invite", {
    method: "GET",
    url,
  });
  return fetch(url, { headers });
}

/**
 * Upload dummy MLS KeyPackages for a member.
 */
export async function uploadKeyPackages(
  auth: SpaceAuth,
  spaceId: string,
  count: number = 10,
): Promise<Response> {
  const keyPackages = Array.from({ length: count }, () =>
    crypto.randomBytes(64).toString("base64"),
  );
  const pops = Array.from({ length: count }, () =>
    crypto.randomBytes(64).toString("base64"),
  );

  const bodyStr = JSON.stringify({ keyPackages, pops });
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/key-packages`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/read", {
    method: "POST",
    url,
    body: bodyStr,
    extra: { "Content-Type": "application/json" },
  });

  return fetch(url, {
    method: "POST",
    headers,
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
  auth: SpaceAuth,
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
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/messages`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/write", {
    method: "POST",
    url,
    body: bodyStr,
    extra: { "Content-Type": "application/json" },
  });

  return fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
  });
}

/**
 * Fetch MLS messages after a given ID.
 */
export async function fetchMlsMessages(
  auth: SpaceAuth,
  spaceId: string,
  afterId: number = 0,
): Promise<Response> {
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/messages?after=${afterId}`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/read", {
    method: "GET",
    url,
  });
  return fetch(url, { headers });
}

// =============================================================================
// MLS Rejoin (External Commit)
// =============================================================================

/**
 * Request GroupInfo for External Commit rejoin.
 */
export async function requestRejoin(
  auth: SpaceAuth,
  spaceId: string,
): Promise<Response> {
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/rejoin`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/read", {
    method: "POST",
    url,
    body: "",
  });

  return fetch(url, {
    method: "POST",
    headers,
  });
}

/**
 * Submit an External Commit to rejoin the MLS group.
 */
export async function submitExternalCommit(
  auth: SpaceAuth,
  spaceId: string,
  commitBase64: string,
): Promise<Response> {
  const bodyStr = JSON.stringify({ commit: commitBase64 });
  const url = `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/external-commit`;
  const headers = await buildUcanRequestHeaders(auth, spaceId, "space/read", {
    method: "POST",
    url,
    body: bodyStr,
    extra: { "Content-Type": "application/json" },
  });

  return fetch(url, {
    method: "POST",
    headers,
    body: bodyStr,
  });
}
