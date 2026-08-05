/**
 * Shared-space write-capability enforcement — real 2-vault P2P (ADR 0002 Phase 2)
 *
 * Validates the leader-independent UCAN-chain authorization gate
 * (`space_delivery::local::inbound_sync::required_capability_for` +
 * `AuthGate`) end-to-end over a real QUIC connection between two vault
 * instances, closing the "manual 2-device sync validation" item left open
 * after ADR 0002 Phase 2 (haex-vault PR #717):
 *
 *  - In one space, a member holding only a `space/read` UCAN attempts a
 *    write to `haex_peer_shares` (the one space-scoped table that isn't a
 *    pure membership table — see `crdt/scanner.rs::scan_membership_tables_
 *    for_local_changes`) — the leader MUST reject the batch.
 *  - In a second, independent space, the same member holding a `space/write`
 *    UCAN performs the same kind of write — the leader MUST accept it.
 *
 * Two independent spaces, not one escalated membership: empirically,
 * re-inviting an ALREADY-ACCEPTED member with a higher capability is not a
 * flow the app supports (the invite never arrives) — the existing "second
 * invite" precedent in quic-invite-flow.spec.ts only re-invites after a
 * DECLINE, never after an accept.
 *
 * Deliberately a standalone spec, not a phase bolted onto
 * `invitations/quic-invite-flow.spec.ts`: that file's 7-phase serial chain is
 * already long and timing-sensitive, and nothing here depends on its state.
 * Only pure helpers are reused (`quic-helpers/ui-spaces.ts`); the contact-
 * import block is duplicated from `quic-phases/01-setup.ts` rather than
 * extracted, to avoid touching shared infrastructure other specs depend on.
 *
 * No existing spec exercises this. `tests/spaces/capability-permissions
 * .spec.ts` only drives the sync-server HTTP layer, and its one related test
 * (`member can push signed changes to space`) has been `test.skip`ped since
 * before Phase 2 existed. `invitations/quic-invite-flow.spec.ts` only asserts
 * that a `haex_ucan_tokens` row with the right `capability` landed — never
 * that a write is actually accepted or rejected because of it.
 */
import * as crypto from "crypto";
import { expect, test, VaultAutomation } from "../fixtures";
import { pollUntil, sqlQuery, wait } from "../helpers/ui/utils";
import { clickTestId, elementExists, mousedownClickFound } from "../helpers/ui/ui-primitives";
import { initializeVaultViaUI, openSettingsCategory, startP2PEndpoint } from "../helpers/ui/ui-vault";
import {
  acceptInviteViaUI,
  createLocalSpaceViaUI,
  ensureDeviceRegistered,
  sendInviteViaUI,
} from "./invitations/quic-helpers/ui-spaces";

// Two independent spaces, not one escalated membership: re-inviting an
// ALREADY-ACCEPTED member with a higher capability is not a flow the app
// supports (confirmed empirically — the invite never arrives; the existing
// "second invite" precedent in quic-invite-flow.spec.ts only re-invites
// after a DECLINE, never after an accept). Each space gets exactly one
// invite to Vault B, matching every other precedent in this repo.
// Random per-run suffix: `createLocalSpaceViaUI` resolves a space by
// `WHERE name = ? LIMIT 1`, so a retry (or a rerun against containers that
// still have state from a prior run) must not collide with an
// already-existing row under the same name — that ambiguity is what made
// earlier runs flaky. Computed once at module load, so retries of the same
// test within one run still target the single row they already created.
const RUN_SUFFIX = crypto.randomBytes(4).toString("hex");
const READ_ONLY_SPACE_NAME = `WriteCap ReadOnly Space ${RUN_SUFFIX}`;
const WRITE_SPACE_NAME = `WriteCap Write Space ${RUN_SUFFIX}`;
const CONTACT_LABEL = "WriteCap Vault B Contact";

/**
 * Registers `identityBDid` as a contact on `vaultA` via the JSON-import flow
 * (Settings → Contacts → Add → From file). Duplicated from
 * `quic-phases/01-setup.ts` — see file header for why.
 *
 * Returns the label the contact is *actually* stored under, which is not
 * necessarily `label`: contacts are keyed by DID, and the import upserts
 * without renaming an existing row. Vault A is shared with every other spec
 * in this shard, and `quic-phases/01-setup.ts` imports the same Vault B DID
 * as "Vault B Contact" — so whichever spec runs first wins the name, and
 * `sendInviteViaUI` (which selects by rendered label, not DID) must be given
 * the surviving one.
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
  expect(addClicked).toBe(true);
  await wait(800);

  const dialogOpen = await elementExists(vaultA, '[role="dialog"]');
  expect(dialogOpen).toBe(true);

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
  expect(tabSwitched).toBe(true);
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
  expect(pasted).toBe(true);
  await wait(300);

  const previewClicked = await clickTestId(vaultA, "contacts-import-preview");
  expect(previewClicked).toBe(true);
  await wait(500);

  const submitClicked = await clickTestId(vaultA, "contacts-import-submit");
  expect(submitClicked).toBe(true);
  await wait(1000);

  const contacts = await sqlQuery<{ id: string }>(
    vaultA,
    `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
    [identityBDid],
  );
  expect(contacts.length).toBe(1);

  // The DB row landing is not sufficient: `sendInviteViaUI` selects the
  // contact by reading the reactive `identityStore.contacts` list, which is
  // a separate (Pinia-cached) read path from the SQL query above. On a slow
  // CI run the store can still be serving its pre-import snapshot for a
  // few hundred ms after the DB write commits — `sendInviteViaUI` would
  // then see only contacts imported by *other* spec files sharing this
  // vault-A instance and throw "not selectable in invite dialog". Poll the
  // store directly (not just the DB) so this helper only returns once the
  // contact this test actually needs is there to select.
  //
  // Read the name back out of the same store the dropdown renders from,
  // rather than trusting `label`: if another spec already imported this DID,
  // the upsert kept that spec's name and the dropdown will never show ours.
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
  if (effectiveLabel !== label) {
    console.log(`[QUIC] Contact for Vault B is stored as "${effectiveLabel}", not "${label}" — using the stored name`);
  }
  return effectiveLabel!;
}

/**
 * Inserts a `haex_peer_shares` row directly (mirrors
 * `peerStorageStore.addShareAsync`'s write path, same as
 * `quic-phases/03-local-space.ts` does for Vault A's own share).
 * `haex_peer_shares` is the one space-scoped table that requires Write
 * capability — the 4 `MEMBERSHIP_SYSTEM_TABLES` only need Read — which is
 * exactly the property this spec needs a real write against.
 */
async function attachOwnShare(
  vault: VaultAutomation,
  spaceId: string,
  nodeId: string,
  identityDid: string,
  shareName: string,
  localPath: string,
): Promise<string> {
  const shareId = crypto.randomUUID();
  const ownDeviceRows = await sqlQuery<{ id: string }>(
    vault,
    "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
    [nodeId],
  );
  expect(ownDeviceRows.length).toBe(1);

  await vault.invokeTauriCommand("filesystem_mkdir", { path: localPath });
  await vault.invokeTauriCommand("sql_execute_with_crdt", {
    sql: `INSERT INTO haex_peer_shares
            (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    params: [shareId, spaceId, ownDeviceRows[0].id, nodeId, shareName, localPath, identityDid],
  });
  await vault.invokeTauriCommand("peer_storage_reload_shares").catch(() => { /* not the leader */ });
  return shareId;
}

/** Starts (if needed) and waits until `local_delivery` is actively syncing `spaceId`. */
async function ensureLocalDeliveryActive(vault: VaultAutomation, spaceId: string): Promise<void> {
  await vault.invokeTauriCommand("local_delivery_start", { spaceId }).catch((err) => {
    console.log(`[QUIC] local_delivery_start(${spaceId}) returned: ${err}`);
  });
  await pollUntil(
    async () => {
      const status = await vault.invokeTauriCommand<{ activeSpaces?: string[] }>("local_delivery_status", {});
      return (status.activeSpaces ?? []).includes(spaceId);
    },
    { timeout: 30_000, interval: 1_000, label: "local_delivery active for space" },
  );
}

test.describe("shared spaces: write-capability enforcement on the real P2P apply path", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let readOnlySpaceId: string;
  let writeSpaceId: string;
  // Resolved from the store after the import — see registerContactViaJsonImport.
  let contactLabel: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      for (const id of [readOnlySpaceId, writeSpaceId]) {
        if (!id) continue;
        try { await v.invokeTauriCommand("local_delivery_stop", { spaceId: id }); } catch { /* ignore */ }
      }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  test("open both vaults and start P2P endpoints", async () => {
    await initializeVaultViaUI(vaultA, "WriteCap Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "WriteCap Test B", "test-password-b");
    nodeIdA = await startP2PEndpoint(vaultA);
    nodeIdB = await startP2PEndpoint(vaultB);
    expect(nodeIdA).toBeTruthy();
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
  });

  test("load identities on both vaults", async () => {
    const rowsA = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultA, "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { id: rowsA![0].id, did: rowsA![0].did };

    const rowsB = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultB, "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { id: rowsB![0].id, did: rowsB![0].did };
  });

  test("register Vault B as a contact on Vault A", async () => {
    contactLabel = await registerContactViaJsonImport(vaultA, identityB.did, nodeIdB, CONTACT_LABEL);
    expect(contactLabel).toBeTruthy();
  });

  test("create read-only-test space on Vault A, invite Vault B read-only, and accept", async () => {
    readOnlySpaceId = await createLocalSpaceViaUI(vaultA, READ_ONLY_SPACE_NAME);
    expect(readOnlySpaceId).toBeTruthy();
    await ensureDeviceRegistered(vaultA, readOnlySpaceId, nodeIdA, identityA.did);
    await ensureLocalDeliveryActive(vaultA, readOnlySpaceId);

    await sendInviteViaUI(vaultA, READ_ONLY_SPACE_NAME, contactLabel, false);
    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB, `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`, [readOnlySpaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "read-only invite delivery to Vault B" },
    );
    await acceptInviteViaUI(vaultB, READ_ONLY_SPACE_NAME, readOnlySpaceId);

    const ucans = await sqlQuery<{ capability: string }>(
      vaultB, `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [readOnlySpaceId, identityB.did],
    );
    expect(ucans.some((u) => u.capability === "space/read")).toBe(true);
    expect(ucans.some((u) => u.capability === "space/write")).toBe(false);
  });

  test("read-only member's write attempt is rejected by the leader", async () => {
    const rejectedShareId = await attachOwnShare(
      vaultB, readOnlySpaceId, nodeIdB, identityB.did,
      "WriteCap Rejected Share", "/tmp/haex-e2e-writecap-rejected",
    );
    await ensureLocalDeliveryActive(vaultB, readOnlySpaceId);

    // Bounded wait, not poll-until-true: proving ABSENCE survives several
    // sync cycles, not just checking too early. Re-triggers force_sync a
    // few times across the window rather than relying on the background
    // poll interval alone.
    for (let i = 0; i < 4; i++) {
      await wait(5_000);
      await vaultB.invokeTauriCommand("local_delivery_force_sync", { spaceId: readOnlySpaceId }).catch(() => { /* no-op on older vault */ });
    }

    const onA = await sqlQuery<{ id: string }>(
      vaultA, `SELECT id FROM haex_peer_shares WHERE id = ?1`, [rejectedShareId],
    );
    expect(onA.length).toBe(0);

    // Still present, unsynced, on B's own DB — proves this is a rejection
    // by the leader, not a local write failure on B.
    const onB = await sqlQuery<{ id: string }>(
      vaultB, `SELECT id FROM haex_peer_shares WHERE id = ?1`, [rejectedShareId],
    );
    expect(onB.length).toBe(1);
  });

  test("create write-test space on Vault A, invite Vault B with write, and accept", async () => {
    writeSpaceId = await createLocalSpaceViaUI(vaultA, WRITE_SPACE_NAME);
    expect(writeSpaceId).toBeTruthy();
    await ensureDeviceRegistered(vaultA, writeSpaceId, nodeIdA, identityA.did);
    await ensureLocalDeliveryActive(vaultA, writeSpaceId);

    await sendInviteViaUI(vaultA, WRITE_SPACE_NAME, contactLabel, true);
    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB, `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`, [writeSpaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "write-capability invite delivery to Vault B" },
    );

    await acceptInviteViaUI(vaultB, WRITE_SPACE_NAME, writeSpaceId);

    const ucans = await sqlQuery<{ capability: string }>(
      vaultB, `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [writeSpaceId, identityB.did],
    );
    // The invite grants both space/read and space/write (write is always
    // additive to the base read grant — see SpaceInviteDialog.vue). Both
    // must land as independent rows: capabilities are orthogonal grants,
    // not a rank, so claiming must not collapse the set down to one.
    expect(ucans.some((u) => u.capability === "space/read")).toBe(true);
    expect(ucans.some((u) => u.capability === "space/write")).toBe(true);
  });

  test("write-capability member's write is accepted by the leader", async () => {
    const acceptedShareId = await attachOwnShare(
      vaultB, writeSpaceId, nodeIdB, identityB.did,
      "WriteCap Accepted Share", "/tmp/haex-e2e-writecap-accepted",
    );
    await ensureLocalDeliveryActive(vaultB, writeSpaceId);
    await vaultB.invokeTauriCommand("local_delivery_force_sync", { spaceId: writeSpaceId }).catch(() => { /* no-op on older vault */ });

    await pollUntil(
      async () => {
        await vaultB.invokeTauriCommand("local_delivery_force_sync", { spaceId: writeSpaceId }).catch(() => { /* no-op */ });
        const rows = await sqlQuery<{ id: string }>(
          vaultA, `SELECT id FROM haex_peer_shares WHERE id = ?1`, [acceptedShareId],
        );
        return rows.length === 1;
      },
      { timeout: 60_000, interval: 2_000, label: "write-capability share row reached Vault A" },
    );
  });
});
