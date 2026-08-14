// tests/helpers/mls-attack-helpers.ts
//
// Helpers for the MLS Phase-3 committer-capability attack specs
// (tests/spaces/mls-committer-capability/). Wraps the `e2e-hooks`-gated
// Tauri commands added in haex-vault's `mls::e2e_hooks` module, plus UCAN
// forging on top of `@haex-space/ucan`'s `createUcan`.
//
// Types below are hand-mirrored from the ts-rs bindings emitted by
// `cargo test --features e2e-hooks export_bindings` — source of truth:
//   src-tauri/bindings/TestCommitGateOutcome.ts
//   src-tauri/bindings/TestCommitGateReport.ts
//   src-tauri/bindings/TestUncheckedRemovalReport.ts

import * as crypto from "crypto";
import {
  createUcan,
  createWebCryptoSigner,
  spaceResource,
  type Capability,
} from "@haex-space/ucan";
import {
  generateIdentityAsync,
  importUserPrivateKeyAsync,
} from "@haex-space/vault-sdk";
import type { VaultAutomation } from "../fixtures";
import { pollUntil, sqlQuery, wait } from "./ui/utils";
import { clickTestId, elementExists, mousedownClickFound } from "./ui/ui-primitives";
import { openSettingsCategory } from "./ui/ui-vault";
import {
  createLocalSpaceViaUI,
  ensureDeviceRegistered,
  sendInviteViaUI,
} from "../spaces/invitations/quic-helpers/ui-spaces";

// =============================================================================
// e2e-hooks Tauri command wrappers
// =============================================================================

export type TestCommitGateOutcome =
  | { kind: "accepted" }
  | { kind: "rejectedPhase1"; reason: string }
  | { kind: "rejectedPop"; reason: string }
  | { kind: "rejectedCommitBind"; reason: string }
  | { kind: "rejectedCommitterCapability"; reason: string }
  | { kind: "rejectedOther"; reason: string };

export interface TestCommitGateReport {
  outcome: TestCommitGateOutcome;
  epochBefore: number;
  epochAfter: number;
  resolvedAudienceDid: string | null;
  resolvedLevel: string | null;
}

export interface TestUncheckedRemovalReport {
  commitB64: string;
  commitBindSigB64: string;
  committerDid: string;
  targetDid: string;
}

/**
 * Attacker-side hook: produce a Remove commit on `vault`'s own MLS group for
 * `spaceId`, targeting `memberIndex`, with NO local capability gate and NO
 * attached UCAN. Always returns a real commit-bind signature.
 */
export async function testMlsRemoveMemberUnchecked(
  vault: VaultAutomation,
  spaceId: string,
  memberIndex: number,
): Promise<TestUncheckedRemovalReport> {
  return vault.invokeTauriCommand<TestUncheckedRemovalReport>(
    "test_mls_remove_member_unchecked",
    { spaceId, memberIndex },
  );
}

/**
 * Victim-side hook: feed `commitB64` into `vault`'s REAL receive path
 * (`MlsManager::decrypt` — same gates, same order as production) and report
 * the classified outcome plus epoch before/after.
 */
export async function testMlsProcessCommitReport(
  vault: VaultAutomation,
  spaceId: string,
  commitB64: string,
  committerUcan: string | null = null,
  committerCommitBindSigB64: string | null = null,
): Promise<TestCommitGateReport> {
  return vault.invokeTauriCommand<TestCommitGateReport>(
    "test_mls_process_commit_report",
    { spaceId, commitB64, committerUcan, committerCommitBindSigB64 },
  );
}

/**
 * Non-throwing form — resolves `targetDid`'s own MLS leaf index in `spaceId`,
 * or `null` when the member is not present. Also swallows the "no group" throw
 * that fires on a vault that has torn down its group after processing a Remove
 * targeting itself; both outcomes are legitimate signals of "not a member".
 */
export async function findMlsMemberIndexOrNull(
  vault: VaultAutomation,
  spaceId: string,
  targetDid: string,
): Promise<number | null> {
  const idx = await vault
    .invokeTauriCommand<number | null>("mls_find_member_index", {
      spaceId,
      memberDid: targetDid,
    })
    .catch(() => null);
  return idx ?? null;
}

/** Resolve `targetDid`'s own MLS leaf index in `spaceId`, as seen by `vault`. Throws when absent — use as a precondition assert. */
export async function findMlsMemberIndex(
  vault: VaultAutomation,
  spaceId: string,
  targetDid: string,
): Promise<number> {
  const idx = await vault.invokeTauriCommand<number | null>("mls_find_member_index", {
    spaceId,
    memberDid: targetDid,
  });
  if (idx === null || idx === undefined) {
    throw new Error(`No MLS member index found for ${targetDid} in space ${spaceId}`);
  }
  return idx;
}

// =============================================================================
// UCAN forging
// =============================================================================

/**
 * Read the real space-admin identity for `spaceId` out of `vault`'s own DB —
 * its DID, self-signed `space/admin` root UCAN token, and private key.
 * Mirrors `space_delivery::local::ucan::load_admin_identity` (Rust).
 *
 * Used to mint REAL delegation chains (rooted at the actual, self-certifying
 * space_id — see `ucan::space_id::verify_space_id_binding` in haex-vault) for
 * attack shapes that must chain-validate successfully and fail on a LATER
 * check (wrong audience, commit-bind replay) rather than at chain-walk time.
 */
export async function loadAdminIdentity(
  vault: VaultAutomation,
  spaceId: string,
): Promise<{ did: string; rootToken: string; privateKeyBase64: string }> {
  const rootRows = await sqlQuery<{ issuer_did: string; token: string }>(
    vault,
    `SELECT issuer_did, token FROM haex_ucan_tokens WHERE space_id = ?1 AND capability = 'space/admin' LIMIT 1`,
    [spaceId],
  );
  if (rootRows.length === 0) {
    throw new Error(`No space/admin root UCAN found for space ${spaceId}`);
  }
  const { issuer_did: did, token: rootToken } = rootRows[0];

  const keyRows = await sqlQuery<{ private_key: string }>(
    vault,
    `SELECT private_key FROM haex_identities WHERE did = ?1 AND private_key IS NOT NULL LIMIT 1`,
    [did],
  );
  if (keyRows.length === 0) {
    throw new Error(`No private_key found for admin identity ${did}`);
  }
  return { did, rootToken, privateKeyBase64: keyRows[0].private_key };
}

/**
 * Generate a fresh, throwaway identity — a random keypair with no relation
 * to any real space. Used to construct forged/rootless UCAN chains (e2e
 * Spec 3's "wrong signer" and "broken chain" sub-cases).
 */
export async function generateThrowawayIdentity(): Promise<{
  did: string;
  privateKeyBase64: string;
}> {
  const identity = await generateIdentityAsync();
  return { did: identity.did, privateKeyBase64: identity.signingPrivateKey };
}

/**
 * Mint (and sign) a UCAN token delegating `capability` for `spaceId` from
 * `issuerDid` to `audienceDid`. `proofs` chains it under a parent token (a
 * real root from `loadAdminIdentity`, or a fake one from
 * `mintFakeSelfSignedRoot`); omit for a self-signed root.
 *
 * `expiresInSeconds` is relative to now — pass a negative value to mint an
 * already-expired token (e2e Spec 3's "expired" sub-case).
 */
export async function mintUcan(params: {
  issuerDid: string;
  issuerPrivateKeyBase64: string;
  audienceDid: string;
  spaceId: string;
  capability: Capability;
  expiresInSeconds?: number;
  proofs?: string[];
}): Promise<string> {
  const privateKey = await importUserPrivateKeyAsync(params.issuerPrivateKeyBase64);
  const sign = createWebCryptoSigner(privateKey);
  const expiresInSeconds = params.expiresInSeconds ?? 3600;
  return createUcan(
    {
      issuer: params.issuerDid,
      audience: params.audienceDid,
      capabilities: { [spaceResource(params.spaceId)]: params.capability },
      expiration: Math.floor(Date.now() / 1000) + expiresInSeconds,
      proofs: params.proofs,
    },
    sign,
  );
}

/**
 * Self-signed `space/admin` root UCAN for a throwaway identity — internally
 * consistent (chain-walks fine) but NOT rooted at the real space: the
 * receiver's `verify_space_id_binding` check ties `space_id` to the actual
 * admin's DID via `H(domain_tag ‖ nonce ‖ root_did)`, so a chain built on
 * this root fails there even though every edge above it verifies cleanly.
 */
export async function mintFakeSelfSignedRoot(
  fakeIdentity: { did: string; privateKeyBase64: string },
  spaceId: string,
): Promise<string> {
  return mintUcan({
    issuerDid: fakeIdentity.did,
    issuerPrivateKeyBase64: fakeIdentity.privateKeyBase64,
    audienceDid: fakeIdentity.did,
    spaceId,
    capability: "space/admin",
  });
}

// =============================================================================
// Shared two-party space setup
// =============================================================================

/**
 * Registers `identityBDid` as a contact on `vaultA` via the JSON-import flow
 * (Settings → Contacts → Add → From file). Duplicated from
 * `write-capability-p2p-enforcement.spec.ts` (itself duplicated from
 * `quic-phases/01-setup.ts`) — this repo's established convention for this
 * exact helper is duplication per spec file, not shared extraction, to keep
 * each spec's blast radius local (see that file's header).
 *
 * Returns the label the contact is *actually* stored under (upsert-by-DID
 * may keep a name from a spec that ran first in this shard).
 */
async function registerContactViaJsonImport(
  vaultA: VaultAutomation,
  identityBDid: string,
  nodeIdB: string,
  label: string,
): Promise<string> {
  const identityPayload = JSON.stringify({
    did: identityBDid,
    name: label,
    claims: [{ type: "endpointId", value: nodeIdB }],
  });

  await openSettingsCategory(vaultA, "contacts");
  await wait(500);

  const addClicked = await clickTestId(vaultA, "contacts-add-trigger");
  if (!addClicked) throw new Error("[MLS-ATTACK] contacts-add-trigger not clickable");
  await wait(800);

  const dialogOpen = await elementExists(vaultA, '[role="dialog"]');
  if (!dialogOpen) throw new Error("[MLS-ATTACK] contact-add dialog did not open");

  const tabSwitched = await mousedownClickFound(
    vaultA,
    `
      const container = document.querySelector('[data-testid="contacts-add-tabs"]');
      if (!container) return null;
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      return tabs.find(t => {
        const text = t.textContent?.toLowerCase() || '';
        return text.includes('file') || text.includes('datei');
      }) ?? null;
    `,
  );
  if (!tabSwitched) throw new Error("[MLS-ATTACK] could not switch to file-import tab");
  await wait(300);

  const pasted = await vaultA.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="contacts-import-json"]');
    const textarea = el?.tagName === 'TEXTAREA' ? el : el?.querySelector('textarea');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(identityPayload)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  if (!pasted) throw new Error("[MLS-ATTACK] could not paste identity JSON");
  await wait(300);

  await clickTestId(vaultA, "contacts-import-preview");
  await wait(500);
  await clickTestId(vaultA, "contacts-import-submit");
  await wait(1000);

  const contacts = await sqlQuery<{ id: string }>(
    vaultA,
    `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
    [identityBDid],
  );
  if (contacts.length !== 1) {
    throw new Error(`[MLS-ATTACK] contact import did not land: found ${contacts.length} rows`);
  }

  const effectiveLabel = await pollUntil(
    () => vaultA.executeScript<string | null>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const identityStore = pinia?._s?.get('identityStore');
      const list = identityStore?.contacts ?? [];
      const hit = list.find(c => c.did === ${JSON.stringify(identityBDid)});
      return hit?.name || null;
    `),
    { timeout: 10_000, interval: 500, label: `identityStore.contacts includes ${label}` },
  );
  return effectiveLabel ?? label;
}

/** Starts (if needed) and waits until `local_delivery` is actively syncing `spaceId`. */
async function ensureLocalDeliveryActive(vault: VaultAutomation, spaceId: string): Promise<void> {
  // `local_delivery_start` throws if the space is already active — that's the
  // expected path when this helper runs after an earlier setup step. But any
  // other failure was previously swallowed and surfaced only as an opaque
  // 30s poll timeout; retain it for the label.
  let startError: unknown = null;
  await vault
    .invokeTauriCommand("local_delivery_start", { spaceId })
    .catch((e) => { startError = e; /* may already be active */ });
  await pollUntil(
    async () => {
      const status = await vault.invokeTauriCommand<{ activeSpaces?: string[] }>("local_delivery_status", {});
      return (status.activeSpaces ?? []).includes(spaceId);
    },
    {
      timeout: 30_000,
      interval: 1_000,
      label: `local_delivery active for space${startError ? ` (start reported: ${String(startError)})` : ""}`,
    },
  );
}

/**
 * Accepts the pending invite for `spaceId` by driving the same store action
 * the Accept button issues (rather than clicking through the UI list, which
 * is ambiguous once a vault accumulates invites from earlier specs in the
 * shard — same reasoning as `write-capability-p2p-enforcement.spec.ts`).
 */
async function acceptInviteViaStore(vault: VaultAutomation, spaceId: string): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1000);

  const rows = await sqlQuery<{
    id: string;
    space_id: string;
    space_name: string | null;
    space_type: string | null;
    origin_url: string | null;
    inviter_did: string;
    inviter_label: string | null;
    inviter_avatar: string | null;
    inviter_avatar_options: string | null;
    inviter_relay_url: string | null;
    space_endpoints: string | null;
    token_id: string | null;
  }>(
    vault,
    `SELECT id, space_id, space_name, space_type, origin_url,
            inviter_did, inviter_label, inviter_avatar, inviter_avatar_options, inviter_relay_url,
            space_endpoints, token_id
     FROM haex_pending_invites
     WHERE space_id = ?1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [spaceId],
  );
  if (rows.length !== 1) {
    throw new Error(`[MLS-ATTACK] expected exactly 1 pending invite for space ${spaceId}, found ${rows.length}`);
  }
  const invite = rows[0];

  const result = await vault.executeScript<{ ok: boolean; error: string | null }>(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const spacesStore = pinia?._s?.get('spacesStore');
    if (!spacesStore) {
      return { ok: false, error: 'spacesStore not found in pinia' };
    }
    try {
      await spacesStore.acceptLocalInviteAsync({
        id: ${JSON.stringify(invite.id)},
        spaceId: ${JSON.stringify(invite.space_id)},
        spaceName: ${JSON.stringify(invite.space_name)},
        spaceType: ${JSON.stringify(invite.space_type)},
        originUrl: ${JSON.stringify(invite.origin_url)},
        inviterDid: ${JSON.stringify(invite.inviter_did)},
        inviterLabel: ${JSON.stringify(invite.inviter_label)},
        inviterAvatar: ${JSON.stringify(invite.inviter_avatar)},
        inviterAvatarOptions: ${JSON.stringify(invite.inviter_avatar_options)},
        inviterRelayUrl: ${JSON.stringify(invite.inviter_relay_url)},
        spaceEndpoints: ${JSON.stringify(invite.space_endpoints)},
        tokenId: ${JSON.stringify(invite.token_id)},
      });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  `);
  if (!result.ok) {
    throw new Error(`[MLS-ATTACK] acceptLocalInviteAsync failed: ${result.error}`);
  }

  await pollUntil(
    async () => {
      const r = await sqlQuery<{ status: string }>(
        vault,
        `SELECT status FROM haex_pending_invites WHERE id = ?1`,
        [invite.id],
      );
      return r[0]?.status === "accepted";
    },
    { timeout: 45_000, interval: 1_000, label: `invite ${invite.id.slice(0, 8)}… accepted` },
  );
}

/**
 * Full real-P2P round-trip for one dedicated space: create a LOCAL space on
 * `vaultA`, register `vaultB` as a contact, send a read-only invite, accept
 * it on `vaultB`, and wait until `vaultB`'s MLS Welcome has landed
 * (`mls_has_group` true) — the precondition every attack spec needs before
 * `test_mls_remove_member_unchecked` has a group to operate on.
 *
 * Read-only, not Invite-capability: the invite dialog UI has no Invite-level
 * toggle (see `sendInviteViaUI` — only a write checkbox). The attack specs
 * that need B to present an Invite-level UCAN mint one directly via
 * `mintUcan` + `loadAdminIdentity`, bypassing the UI entirely — exactly the
 * out-of-band-injection design of this whole spec matrix.
 */
export async function setupTwoPartySpace(params: {
  vaultA: VaultAutomation;
  vaultB: VaultAutomation;
  nodeIdA: string;
  nodeIdB: string;
  identityADid: string;
  identityBDid: string;
  contactLabel: string;
  spaceName: string;
}): Promise<string> {
  const { vaultA, vaultB, nodeIdA, nodeIdB, identityADid, identityBDid, contactLabel, spaceName } = params;

  const effectiveContactLabel = await registerContactViaJsonImport(vaultA, identityBDid, nodeIdB, contactLabel);

  const spaceId = await createLocalSpaceViaUI(vaultA, spaceName);
  await ensureDeviceRegistered(vaultA, spaceId, nodeIdA, identityADid);
  await ensureLocalDeliveryActive(vaultA, spaceId);

  await sendInviteViaUI(vaultA, spaceName, effectiveContactLabel, false);
  await pollUntil(
    async () => {
      const invites = await sqlQuery<{ id: string }>(
        vaultB,
        `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
        [spaceId],
      );
      return invites.length > 0;
    },
    { timeout: 60_000, interval: 2_000, label: `invite delivery to Vault B for "${spaceName}"` },
  );
  await acceptInviteViaStore(vaultB, spaceId);
  await ensureLocalDeliveryActive(vaultB, spaceId);

  // MLS Welcome processing is async relative to the invite-accept status
  // flip — wait for B's own group before any attack hook touches it.
  await pollUntil(
    () => vaultB.invokeTauriCommand<boolean>("mls_has_group", { spaceId }),
    { timeout: 45_000, interval: 1_000, label: `Vault B has an MLS group for "${spaceName}"` },
  );

  return spaceId;
}

/** Random per-run suffix, matching this repo's `RUN_SUFFIX` idiom (avoids colliding with a prior run's rows under the same space name). */
export function runSuffix(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Ensure `did` has a `haex_space_members` row on `vault`'s OWN db for
 * `spaceId` — idempotent (no-op if already present).
 *
 * The convergence precondition every attack spec needs (design doc C1):
 * `authorize_committer_capability`'s `all_targets_already_gone` exemption
 * can't tell "the removal target already left" from "this receiver never
 * applied the Add in the first place" — row absence means both. Without
 * explicitly ensuring the target's row here, an attack spec can pass for
 * the wrong reason (the exemption silently accepting a proof-less commit)
 * rather than because the committer-capability gate actually fired.
 */
export async function ensureSpaceMemberRow(
  vault: VaultAutomation,
  spaceId: string,
  did: string,
): Promise<void> {
  const identity = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_identities WHERE did = ?1 LIMIT 1`,
    [did],
  );
  if (identity.length === 0) {
    throw new Error(`[MLS-ATTACK] no haex_identities row for ${did} on this vault`);
  }
  // `haex_space_members_space_identity_unique` (`(space_id, identity_id)`) makes
  // this a no-op if the row already exists — safer than a check-then-insert
  // sequence when two setup steps race (each attack spec's setup calls this).
  await vault.invokeTauriCommand("sql_execute_with_crdt", {
    sql: `INSERT OR IGNORE INTO haex_space_members (id, space_id, identity_id, role) VALUES (?1, ?2, ?3, 'member')`,
    params: [crypto.randomUUID(), spaceId, identity[0].id],
  });
}
