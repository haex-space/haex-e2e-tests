import * as crypto from "crypto";
import { expect, type VaultAutomation } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../../helpers/ui/utils";
import {
  clickTestId,
  mousedownClickFound,
  mousedownClickSelector,
  mousedownClickTestId,
  setInputValue,
} from "../../../helpers/ui/ui-primitives";
import { openSettingsCategory } from "../../../helpers/ui/ui-vault";

/**
 * Insert a `haex_space_devices` row for the vault's own device in `spaceId`
 * when the row is missing. Used at the start of personal/local space tests
 * because the UI does not auto-register the device until an invite flow runs.
 *
 * `device_id` must point at the real `haex_devices.id` for the vault — the
 * ensure-refs trigger collides on UNIQUE(endpoint_id) when a random UUID is
 * used (see Phase 2 FK migration). Throws via `expect` when the own-device
 * row is missing because that means peer storage was never started.
 */
export async function ensureDeviceRegistered(
  vault: VaultAutomation,
  spaceId: string,
  nodeId: string,
  identityDid: string,
  deviceName: string = "Vault A Desktop",
  platform: string = "desktop",
): Promise<void> {
  const devices = await sqlQuery<{ endpoint_id: string }>(
    vault,
    "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
    [spaceId],
  );
  if (devices.some((d) => d.endpoint_id === nodeId)) return;

  const ownDeviceRows = await sqlQuery<{ id: string }>(
    vault,
    "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
    [nodeId],
  );
  expect(ownDeviceRows.length).toBe(1);
  await vault.invokeTauriCommand("sql_execute_with_crdt", {
    sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    params: [
      crypto.randomUUID(),
      spaceId,
      ownDeviceRows[0].id,
      nodeId,
      deviceName,
      platform,
      identityDid,
    ],
  });
}

/**
 * Navigate to Settings → Spaces → Create a LOCAL space via the dialog.
 * Returns the new space's ID (read from the database after creation).
 */
export async function createLocalSpaceViaUI(
  vault: VaultAutomation,
  spaceName: string,
): Promise<string> {
  await openSettingsCategory(vault, "spaces");
  await wait(500);

  // Click "Create" in the Spaces header (opens the dialog)
  await clickTestId(vault, "spaces-create-trigger");
  await wait(800); // drawer animation

  // Fill the create-space dialog
  // 1. Space name input (data-testid is on the UiInput wrapper div)
  await setInputValue(
    vault,
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])',
    spaceName,
    '[data-testid="spaces-create-name"]',
  );
  await wait(300);

  // 2. Click "Local" type button
  await clickTestId(vault, "spaces-create-type-local");
  await wait(300);

  // 3. Click the dialog's submit button
  await clickTestId(vault, "spaces-create-submit");
  await wait(1500); // space creation + list refresh

  // Read the spaceId from DB
  const spaces = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 LIMIT 1`,
    [spaceName],
  );
  expect(spaces.length).toBe(1);
  return spaces[0].id;
}

/**
 * Open the SpaceInviteDialog via UI and send a QUIC invite.
 *
 * The UI navigation (spaces list → invite dropdown → dialog) is fully tested.
 * The actual invite delivery uses `local_delivery_push_invite` because the
 * UiSelectMenu contact picker renders items without textContent, making
 * WebDriver selection unreliable. This still tests the full QUIC P2P pipeline.
 *
 * @param vault        The inviter's vault
 * @param contactLabel Label of the contact to select in the dialog
 * @param withWrite    Whether to enable write capability
 */
export async function sendInviteViaUI(
  vault: VaultAutomation,
  spaceName: string,
  contactLabel: string,
  withWrite: boolean = false,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1000);

  // Dismiss the driver.js welcome tour if active — it overlays the entire UI
  await vault.executeScript(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const tourStore = pinia?._s?.get('tourStore');
    if (tourStore?.isActive) tourStore.complete();
  `);
  await wait(300);

  // Open invite dialog through the real UI: click the per-space dropdown
  // trigger, then click the "invite contact" option. Each option carries a
  // stable `data-testid` keyed by space ID so the right card's dropdown is
  // unambiguous (previously this required a window.__openInviteDialog hook
  // because the menu items had no testable handles).
  const spaceForInvite = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 LIMIT 1`,
    [spaceName],
  );
  const targetSpaceId = spaceForInvite[0]?.id;
  if (!targetSpaceId) {
    throw new Error(`[QUIC] Space "${spaceName}" not found in haex_spaces`);
  }

  // The invite trigger is a UDropdownMenu (reka-ui). reka-ui's
  // DropdownMenuTrigger reacts to pointerdown/mousedown, not `click()` —
  // see mousedownClickTestId. Previous CI runs showed
  // `preflight: dialogs=0 trigger=false` on first attempt and only
  // recovered on Playwright retries before we switched away from `.click()`.
  //
  // Race that survived even after switching to mousedown: reka-ui's
  // DropdownMenu auto-closes on click-outside / focus-loss between when
  // we observe the option mounted and when we dispatch the click event.
  // The option DOM node gets removed, the click finds nothing, and the
  // dialog never opens. Retry the entire trigger→option→dialog cascade
  // until either the dialog is up or we've exhausted 3 attempts.
  //
  // Also poll for the trigger testid to be mounted first — the space row
  // exists in haex_spaces before Vue re-renders its card on the next
  // microtask, and clicking before the trigger renders cascades into the
  // same "dialog never opens" failure mode the loop is meant to guard
  // against.
  const triggerMounted = await pollUntil(
    () => vault.executeScript<boolean>(`
      return !!document.querySelector('[data-testid="space-invite-trigger-${targetSpaceId}"]');
    `),
    { timeout: 5_000, interval: 200, label: `space-invite-trigger-${targetSpaceId} mounted` },
  ).catch(() => false);
  console.log(`[QUIC-DEBUG] invite-trigger-mounted: ${triggerMounted}`);

  let triggerFound: boolean = false;
  let triggerExpanded: boolean = false;
  let optionMounted: boolean = false;
  let optionClicked: boolean = false;
  let dialogOpen: boolean = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await wait(800);
    triggerFound = await mousedownClickTestId(
      vault,
      `space-invite-trigger-${targetSpaceId}`,
    );
    triggerExpanded = await vault.executeScript<boolean>(`
      const el = document.querySelector('[data-testid="space-invite-trigger-${targetSpaceId}"]');
      return !!el && (el.getAttribute('aria-expanded') === 'true' || el.getAttribute('data-state') === 'open');
    `);
    // Poll for the menu portal to actually mount the contact option, so we
    // don't race the click below. reka-ui mounts/unmounts the portal on each
    // open; the item element won't exist until then.
    optionMounted = await pollUntil(
      () => vault.executeScript<boolean>(`
        return !!document.querySelector('[data-testid="space-invite-option-contact-${targetSpaceId}"]');
      `),
      { timeout: 5_000, interval: 200, label: "invite-option-contact mounted" },
    ).catch(() => false);

    // Click the contact option. The testid is on the slot <span>; the actual
    // reka-ui MenuItem is its parent.
    optionClicked = await mousedownClickFound(
      vault,
      `
        const span = document.querySelector('[data-testid="space-invite-option-contact-${targetSpaceId}"]');
        if (!span) return null;
        return span.closest('[role="menuitem"]') ?? span.parentElement ?? span;
      `,
    );

    // Wait for the invite dialog itself to appear before continuing.
    dialogOpen = await pollUntil(
      () => vault.executeScript<boolean>(`
        return !!document.querySelector('[data-testid="invite-contact-select"]');
      `),
      { timeout: 5_000, interval: 200, label: "invite dialog open" },
    ).catch(() => false);
    if (dialogOpen) break;
    console.log(`[QUIC-DEBUG] dialog-open attempt ${attempt + 1} failed (trigger=${triggerFound}/${triggerExpanded} option=${optionMounted}/${optionClicked}) — retrying`);
  }
  console.log(`[QUIC-DEBUG] invite-trigger: found=${triggerFound} expanded=${triggerExpanded}`);
  console.log(`[QUIC-DEBUG] invite-option mounted: ${optionMounted}`);
  console.log(`[QUIC-DEBUG] invite-option click: ${optionClicked}`);
  console.log(`[QUIC-DEBUG] invite dialog open: ${dialogOpen}`);

  // Select contact. Two things have historically broken this step:
  //   1) The Pinia contacts store had stale data right after the import flow
  //      (no DB subscription). The store now reloads on dialog open
  //      (SpaceInviteDialog.vue watch(open)), so this is no longer racy.
  //   2) The combobox trigger uses reka-ui, which activates on `mousedown`
  //      not `click()`. `data-testid="invite-contact-select"` lives on the
  //      Nuxt-UI wrapper, so `el.click()` on it does NOT open the popup —
  //      the ComboboxPortal stays unmounted and no `[data-slot="item"]`
  //      ever appears. We dispatch mousedown on the inner `role=combobox`
  //      element (same gotcha as the Tabs trigger in 01-setup.ts).
  //
  // Logging is deliberately verbose: when this breaks again in CI, the
  // failure mode (store empty? popup not open? item label mismatch?)
  // must be unambiguous from the log alone — debugging Playwright traces
  // from CI is painful.

  // Pre-flight: what does the app think we have to choose from?
  const preflight = await vault.executeScript<{
    dialogCount: number;
    triggerFound: boolean;
    triggerTag: string | null;
    comboboxFound: boolean;
    storeContacts: { id: string; name: string; did: string }[];
  }>(`
    const wrapper = document.querySelector('[data-testid="invite-contact-select"]');
    const combobox = wrapper?.querySelector('[role="combobox"]')
      ?? document.querySelector('[data-testid="invite-contact-select"] [role="combobox"]');
    let storeContacts = [];
    try {
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const identityStore = pinia?._s?.get('identityStore');
      const list = identityStore?.contacts ?? [];
      storeContacts = list.map(c => ({ id: c.id, name: c.name, did: (c.did || '').slice(0, 30) }));
    } catch (e) { /* best-effort */ }
    return {
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      triggerFound: !!wrapper,
      triggerTag: wrapper?.tagName ?? null,
      comboboxFound: !!combobox,
      storeContacts,
    };
  `);
  console.log(`[QUIC-DEBUG] preflight: dialogs=${preflight.dialogCount} trigger=${preflight.triggerFound}(${preflight.triggerTag}) combobox=${preflight.comboboxFound} contacts=${JSON.stringify(preflight.storeContacts)}`);

  // Open the combobox via reka-ui-compatible events (mousedown+click).
  // The trigger lives inside the wrapper that carries the testid.
  //
  // Flake guard: the first mousedown+click sometimes lands while the dialog
  // is still settling its initial focus trap, in which case reka-ui swallows
  // the event and `aria-expanded` stays `false` even though our test rig
  // reported the click landed. We retry the click up to 3× until either the
  // combobox reports expanded=true or the portal/listbox shows up in the DOM
  // — `expanded` is the cleanest signal but `portal` is the post-condition
  // we actually care about; either becoming truthy unblocks the flow.
  let triggerOpened: unknown = false;
  let popupOpened = { used: "none", expanded: false };
  let portalState = { contentFound: false, itemCount: 0, itemLabels: [] as string[], listboxRole: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await wait(500);
    triggerOpened = await mousedownClickFound(
      vault,
      `
        const wrapper = document.querySelector('[data-testid="invite-contact-select"]');
        if (!wrapper) return null;
        return wrapper.querySelector('[role="combobox"]') ?? wrapper.querySelector('button') ?? wrapper;
      `,
    );
    popupOpened = await vault.executeScript<{ used: string; expanded: boolean }>(`
      const wrapper = document.querySelector('[data-testid="invite-contact-select"]');
      const trigger = wrapper?.querySelector('[role="combobox"]') ?? wrapper?.querySelector('button') ?? wrapper;
      if (!trigger) return { used: 'none', expanded: false };
      return {
        used: trigger.tagName + (trigger.getAttribute('role') ? '['+trigger.getAttribute('role')+']' : ''),
        expanded: trigger.getAttribute('aria-expanded') === 'true' || trigger.getAttribute('data-state') === 'open',
      };
    `);
    // Wait for the portal to mount before deciding whether to retry — the
    // expansion-to-mount gap is async (Vue tick + reka portal teleport).
    await wait(500);
    portalState = await vault.executeScript<{ contentFound: boolean; itemCount: number; itemLabels: string[]; listboxRole: boolean }>(`
      const items = [...document.querySelectorAll('[data-slot="item"]')];
      const listbox = !!document.querySelector('[role="listbox"]');
      const content = !!document.querySelector('[data-reka-popper-content-wrapper], [role="listbox"]');
      return {
        contentFound: content,
        itemCount: items.length,
        itemLabels: items.slice(0, 10).map(el => (el.textContent || '').trim().slice(0, 40)),
        listboxRole: listbox,
      };
    `);
    if (popupOpened.expanded || portalState.contentFound) break;
    console.log(`[QUIC-DEBUG] open-trigger attempt ${attempt + 1} did not open the popup (expanded=${popupOpened.expanded} portal=${portalState.contentFound}) — retrying`);
  }
  console.log(`[QUIC-DEBUG] open-trigger: clicked=${triggerOpened} used=${popupOpened.used} expanded=${popupOpened.expanded}`);
  console.log(`[QUIC-DEBUG] portal: content=${portalState.contentFound} listbox=${portalState.listboxRole} items=${portalState.itemCount} labels=${JSON.stringify(portalState.itemLabels)}`);

  const contactSelected = await pollUntil(
    () => mousedownClickFound(
      vault,
      `
        const label = ${JSON.stringify(contactLabel)};
        const items = [...document.querySelectorAll('[data-slot="item"]')];
        return items.find(el => el.textContent?.includes(label)) ?? null;
      `,
    ),
    { timeout: 10_000, interval: 500, label: `contact "${contactLabel}" visible in dropdown` },
  ).catch(() => false);
  console.log(`[QUIC] Contact selected: ${contactSelected}`);

  // Re-snapshot AFTER selection to confirm the model picked it up.
  const postSelect = await vault.executeScript<{ selectedIds: string[]; submitEnabled: boolean }>(`
    let selectedIds = [];
    try {
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      // The dialog state isn't in Pinia — fall back to checking the rendered
      // chips/badges inside the wrapper. SelectMenu shows selected entries
      // as pill-style children of the trigger.
      const wrapper = document.querySelector('[data-testid="invite-contact-select"]');
      selectedIds = wrapper
        ? [...wrapper.querySelectorAll('[data-slot="value"], [data-slot="chip"], button span')].map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 5)
        : [];
    } catch (e) { /* best-effort */ }
    const submit = document.querySelector('[data-testid="invite-submit"]');
    return {
      selectedIds,
      submitEnabled: !!submit && !(submit instanceof HTMLButtonElement && submit.disabled),
    };
  `);
  console.log(`[QUIC-DEBUG] post-select: visible=${JSON.stringify(postSelect.selectedIds)} submitEnabled=${postSelect.submitEnabled}`);

  if (!contactSelected) {
    // No silent pass: hide-the-failure bit us before (test reported success
    // while invite-submit fired with empty selection → empty outbox → 120s
    // delivery timeout downstream). The diagnostic dumps above make the
    // failure mode visible in the log.
    throw new Error(
      `[QUIC] Contact "${contactLabel}" not selectable in invite dialog. ` +
      `Store had ${preflight.storeContacts.length} contacts (${preflight.storeContacts.map(c => c.name).join(', ')}); ` +
      `portal mounted: ${portalState.contentFound}; items rendered: ${portalState.itemCount}; ` +
      `labels seen: ${JSON.stringify(portalState.itemLabels)}.`,
    );
  }
  await wait(300);

  // Close dropdown
  await vault.executeScript(`document.body.click()`);
  await wait(300);

  // Set capabilities if write is requested
  if (withWrite) {
    await clickTestId(vault, "invite-cap-write");
    await wait(200);
  }

  // Submit
  await clickTestId(vault, "invite-submit");
  await wait(2000);

  console.log(`[QUIC] Invite sent via UI dialog`);
}

/**
 * On the invitee's vault, navigate to Spaces and click the Accept button
 * on the pending invite. Falls back to direct status update if UI button not found.
 */
export async function acceptInviteViaUI(
  vault: VaultAutomation,
  spaceName: string,
  spaceIdForFallback: string,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1500);

  const clicked = await vault.executeScript<boolean>(`
    const name = ${JSON.stringify(spaceName)};
    const items = [...document.querySelectorAll('[class*="rounded-lg"]')];
    for (const item of items) {
      if (!item.textContent?.includes(name)) continue;
      const btns = [...item.querySelectorAll('button')];
      const acceptBtn = btns.find(b => {
        const t = b.textContent?.trim();
        return t?.includes('Accept') || t?.includes('Annehmen');
      });
      if (acceptBtn) { acceptBtn.click(); return true; }
    }
    return false;
  `);
  console.log(`[QUIC] Accept button clicked: ${clicked}`);

  if (!clicked) {
    console.log("[QUIC] Accept button not found in UI");
  }

  // Accept triggers an async QUIC ClaimInvite roundtrip — poll until DB reflects it
  await pollUntil(
    async () => {
      const rows = await sqlQuery<{ status: string }>(
        vault,
        `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
        [spaceIdForFallback],
      );
      const status = rows[0]?.status;
      if (status && status !== "pending") {
        console.log(`[QUIC] Invite status: ${status}`);
      }
      return rows.length > 0 && rows[0].status === "accepted";
    },
    { timeout: 45_000, interval: 1_000, label: "invite accepted" },
  );
}

/**
 * On the invitee's vault, navigate to Spaces and click the Decline button
 * on the pending invite. Falls back to CRDT delete if the UI button is not found.
 */
export async function declineInviteViaUI(
  vault: VaultAutomation,
  spaceName: string,
  spaceIdForFallback: string,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1500);

  // Find ANY item with the space name that has a Decline button
  const clicked = await vault.executeScript<boolean>(`
    const name = ${JSON.stringify(spaceName)};
    const items = [...document.querySelectorAll('[class*="rounded-lg"]')];
    for (const item of items) {
      if (!item.textContent?.includes(name)) continue;
      const btns = [...item.querySelectorAll('button')];
      const declineBtn = btns.find(b => {
        const t = b.textContent?.trim();
        return t?.includes('Decline') || t?.includes('Ablehnen');
      });
      if (declineBtn) { declineBtn.click(); return true; }
    }
    return false;
  `);

  if (!clicked) {
    // UI button not found — decline via CRDT delete (same effect as the UI handler)
    console.log("[QUIC] Decline button not in UI, falling back to CRDT delete");
    const invites = await sqlQuery<{ id: string }>(
      vault,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceIdForFallback],
    );
    for (const inv of invites) {
      await vault.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `DELETE FROM haex_pending_invites WHERE id = ?1`,
        params: [inv.id],
      });
    }
  }
  await wait(1000);
}

/**
 * Set the invite policy via the dropdown in the Spaces settings header.
 * @param policy  'all' | 'contacts_only' | 'nobody'
 *
 * Force-closes any open settings window and reopens fresh on the spaces
 * category. The policy dropdown lives in the spaces *index* view's
 * header — earlier tests in the suite navigate into the SpaceDetail
 * drill-down (e.g. :1613 for the share-visibility check) and that
 * navigation state persists per tab. Without resetting, the helper's
 * dropdown selector fires against a DOM that doesn't contain the
 * trigger and the underlying setPolicy() never runs.
 */
export async function setInvitePolicyViaUI(
  vault: VaultAutomation,
  policy: "all" | "contacts_only" | "nobody",
): Promise<void> {
  // Close any existing settings window so reopening returns to the
  // spaces *index* view (not whichever drill-down a previous test
  // left behind). Mirrors the pattern used by startP2PEndpoint.
  await vault.executeScript(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const wm = pinia?._s?.get('windowManager');
    if (wm) {
      const win = wm.currentWorkspaceWindows?.find(w =>
        w.sourceId === 'settings' || w.tabs?.some(t => t.sourceId === 'settings')
      );
      if (win) wm.closeWindow(win.id);
    }
  `);
  await wait(500);

  await openSettingsCategory(vault, "spaces");
  await wait(500);

  const labelMap: Record<string, string[]> = {
    all: ["Everyone", "Alle"],
    contacts_only: ["Contacts only", "Nur Kontakte"],
    nobody: ["Nobody", "Niemand"],
  };
  const labels = labelMap[policy];

  // Click the policy select trigger
  await vault.executeScript(`
    // The policy dropdown is a USelectMenu near text "Invitations allowed from"/"Einladungen erlaubt von"
    const allBtns = [...document.querySelectorAll('[role="combobox"], button')];
    const policyTrigger = allBtns.find(b => {
      const t = b.textContent?.trim();
      return t === 'Everyone' || t === 'Alle' || t === 'Contacts only' || t === 'Nur Kontakte'
          || t === 'Nobody' || t === 'Niemand';
    });
    if (policyTrigger) policyTrigger.click();
  `);
  await wait(400);

  // Select the desired option
  await vault.executeScript(`
    const labels = ${JSON.stringify(labels)};
    const options = [...document.querySelectorAll('[role="option"]')];
    const match = options.find(o => labels.some(l => o.textContent?.trim().includes(l)));
    if (match) match.click();
  `);
  await wait(500);
}
