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
  const authorization = await buildUcanAuthHeader(auth, spaceId, "space/invite");

  return fetch(
    `${SYNC_SERVER_URL}/spaces/${spaceId}/mls/key-packages/${encodeURIComponent(targetDid)}`,
    {
      headers: {
        Authorization: authorization,
      },
    },
  );
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
  auth: SpaceAuth,
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
  auth: SpaceAuth,
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
  auth: SpaceAuth,
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
