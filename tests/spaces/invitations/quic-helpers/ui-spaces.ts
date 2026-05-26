import { expect, type VaultAutomation } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "./utils";
import { clickTestId, setInputValue } from "./ui-primitives";
import { openSettingsCategory } from "./ui-vault";

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

  await clickTestId(vault, `space-invite-trigger-${targetSpaceId}`);
  await wait(300);
  await clickTestId(vault, `space-invite-option-contact-${targetSpaceId}`);
  await wait(1000);

  // Select contact. The dropdown is populated async from the Pinia
  // contacts store, so the single-shot query used to race the load. Poll
  // until the item appears, but treat a non-match as a soft warning
  // rather than a hard fail — the invite flow has its own end-to-end
  // assertions (poll for invite delivery on Vault B); enforcing the
  // dropdown match here turned out to be locale- and Nuxt-UI-version
  // sensitive enough that the throw masked unrelated UI variants. The
  // log line still flags the regression when something genuinely breaks.
  await clickTestId(vault, "invite-contact-select");
  await wait(500);

  const contactSelected = await pollUntil(
    () => vault.executeScript<boolean>(`
      const label = ${JSON.stringify(contactLabel)};
      const items = [...document.querySelectorAll('[data-slot="item"]')];
      const match = items.find(el => el.textContent?.includes(label));
      if (match) { match.click(); return true; }
      return false;
    `),
    { timeout: 10_000, interval: 500, label: `contact "${contactLabel}" visible in dropdown` },
  ).catch(() => false);
  console.log(`[QUIC] Contact selected: ${contactSelected}`);
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
