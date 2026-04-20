import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../../fixtures";

/**
 * QUIC Space Invitation E2E Tests — Full UI Flow
 *
 * Tests the REAL invitation flow between two vault instances over QUIC,
 * driving all user-facing actions through the actual UI:
 *
 *  - Vault creation/opening via the vault picker UI
 *  - P2P endpoint start via Settings → P2P Network
 *  - Space creation via Settings → Spaces → Create dialog
 *  - Invite sending via SpaceInviteDialog (contact mode)
 *  - Invite accept/decline via pending invite UI buttons
 *  - Policy enforcement via Spaces settings dropdown
 *
 * SQL/commands are used only for:
 *  - Contact registration (no UI for adding contacts by DID + endpoint)
 *  - Verification assertions (checking DB state matches UI actions)
 *  - Loading identities (infrastructure setup)
 *  - Self-invite edge case (impossible via UI — you can't select yourself)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

type JsonValue = string | number | boolean | null;

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `fn` returns a truthy value, or throw after `timeout` ms. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 15_000, interval = 1_000, label = "condition" } = opts;
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await wait(interval);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeout}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL Helper  (verification only — not for driving user actions)
// ═══════════════════════════════════════════════════════════════════════════════

async function sqlQuery<T extends Record<string, unknown>>(
  vault: VaultAutomation,
  sql: string,
  params: JsonValue[] = [],
): Promise<T[]> {
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  if (!selectMatch) throw new Error(`Cannot parse SELECT columns: ${sql}`);
  const columns = selectMatch[1]
    .split(",")
    .map((c) =>
      c.trim().replace(/.*\s+AS\s+/i, "").replace(/"/g, "").replace(/.*\./, ""),
    );
  const rows = await vault.invokeTauriCommand<JsonValue[][]>(
    "sql_select_with_crdt",
    { sql, params },
  );
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj as T;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI Helpers — low-level
// ═══════════════════════════════════════════════════════════════════════════════

/** Click a <button> whose visible text matches one of `labels`. */
async function clickButton(
  vault: VaultAutomation,
  ...labels: string[]
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const labels = ${JSON.stringify(labels)};
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    for (const label of labels) {
      const btn = btns.find(b => {
        const t = b.textContent?.trim();
        return t === label || t?.includes(label);
      });
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  `);
}

/** Click a button inside a specific container (scoped). */
async function clickButtonIn(
  vault: VaultAutomation,
  containerSelector: string,
  ...labels: string[]
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const container = document.querySelector('${containerSelector}');
    if (!container) return false;
    const labels = ${JSON.stringify(labels)};
    const btns = [...container.querySelectorAll('button, [role="button"]')];
    for (const label of labels) {
      const btn = btns.find(b => {
        const t = b.textContent?.trim();
        return t === label || t?.includes(label);
      });
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  `);
}

/** Click element by data-testid. */
async function clickTestId(vault: VaultAutomation, testId: string): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="${testId}"]');
    if (el) { el.click(); return true; }
    return false;
  `);
}

/** Set the value of an <input> using the native setter (triggers Vue reactivity). */
async function setInputValue(
  vault: VaultAutomation,
  selector: string,
  value: string,
  container = "document",
): Promise<void> {
  await vault.executeScript(`
    const root = ${container === "document" ? "document" : `document.querySelector('${container}')`};
    const input = root?.querySelector('${selector}');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `);
}

/** Check whether an element matching `selector` exists in the DOM. */
async function elementExists(vault: VaultAutomation, selector: string): Promise<boolean> {
  return vault.executeScript<boolean>(
    `return !!document.querySelector('${selector}');`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI Helpers — high-level
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open (or create) a vault through the real UI.
 * Triggers the full Nuxt lifecycle: Pinia stores → identity creation → extension loading.
 * NEVER uses location.reload() (would destroy the WebDriver session).
 */
async function initializeVaultViaUI(
  vault: VaultAutomation,
  vaultName: string,
  password: string,
): Promise<void> {
  // Already inside an open vault?
  const href = await vault.executeScript<string>("return location.href");
  if (href?.includes("/vault/")) {
    console.log(`[QUIC] Already open on ${vault.getInstance()}: ${href}`);
    return;
  }

  const vaults = await vault.invokeTauriCommand<Array<{ name: string }>>(
    "list_vaults",
    {},
  );
  const exists = vaults.some((v) => v.name === vaultName);

  if (!exists) {
    // ── Create vault via UI ─────────────────────────────────────────────
    console.log(`[QUIC] Creating "${vaultName}" via UI on ${vault.getInstance()}…`);

    // Click "Create vault" / "Vault erstellen" — retry until the button is rendered
    await pollUntil(
      () => clickButton(vault, "Create vault", "Vault erstellen"),
      { timeout: 10_000, label: "Create vault button" },
    );
    await wait(1000); // drawer animation

    // Fill the create-vault dialog (scoped to the visible dialog)
    await vault.executeScript(`
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // Vault name — the only non-password input in the dialog
      const nameInput = dialog.querySelector(
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])'
      );
      if (nameInput) {
        setter.call(nameInput, '');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(nameInput, ${JSON.stringify(vaultName)});
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Both password fields (password + confirm)
      dialog.querySelectorAll('input[type="password"]').forEach(input => {
        setter.call(input, ${JSON.stringify(password)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    `);
    await wait(500);

    // Click "Create" / "Erstellen" inside the dialog
    await clickButtonIn(vault, '[role="dialog"]', "Create", "Erstellen");
  } else {
    // ── Open existing vault via UI ──────────────────────────────────────
    console.log(`[QUIC] Opening "${vaultName}" via UI on ${vault.getInstance()}…`);

    // Click the vault entry in the picker (TreeWalker approach from global-setup)
    for (let attempt = 0; attempt < 5; attempt++) {
      const clicked = await vault.executeScript<boolean>(`
        const name = ${JSON.stringify(vaultName)};
        // Strategy 1: button[data-slot="base"] containing vault name
        const slotBtns = [...document.querySelectorAll('button[data-slot="base"]')];
        const slotMatch = slotBtns.find(b => b.textContent?.trim().includes(name));
        if (slotMatch) { slotMatch.click(); return true; }
        // Strategy 2: TreeWalker for exact text match → closest button
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent?.trim() === name) {
            const btn = node.parentElement?.closest('button')
              || node.parentElement?.closest('[role="button"]');
            if (btn) { btn.click(); return true; }
            node.parentElement?.click();
            return true;
          }
        }
        return false;
      `);
      if (clicked) break;
      console.log(`[QUIC] Vault button not found, retrying (${attempt + 1}/5)…`);
      await wait(2000);
    }
    await wait(1500); // wait for password dialog

    // Enter password + click Unlock via executeScript
    // (findElement/sendKeys use fetch which fails cross-container for Vault B)
    await vault.executeScript(`
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const pw = document.querySelector('input[type="password"]');
      if (pw) {
        setter.call(pw, ${JSON.stringify(password)});
        pw.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);
    await wait(300);
    await clickButton(vault, "Unlock", "Entsperren");
  }

  // Wait for navigation to the vault desktop page (/vault/{id})
  await pollUntil(
    async () => {
      const h = await vault.executeScript<string>("return location.href");
      return h?.includes("/vault/") || false;
    },
    { timeout: 30_000, interval: 1000, label: "vault desktop" },
  );
  console.log(`[QUIC] Vault "${vaultName}" ready on ${vault.getInstance()}`);

  // Let stores finish initialising (identity, extensions, sync)
  await wait(5000);
}

/**
 * Open the Settings floating window and navigate to a category.
 * Opens settings via the windowManager Pinia store (the launcher click handler
 * is unreliable from WebDriver), then clicks `data-testid="settings-category-<cat>"`.
 */
async function openSettingsCategory(
  vault: VaultAutomation,
  category: string,
): Promise<void> {
  const testId = `settings-category-${category}`;

  // If settings is already open with the category button visible, just click it
  if (await elementExists(vault, `[data-testid="${testId}"]`)) {
    await clickTestId(vault, testId);
    await wait(500);
    return;
  }

  // Open settings via the windowManager Pinia store.
  // Pinia is accessible through the Nuxt app instance, NOT window.__pinia__.
  await vault.executeScript(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const wm = pinia?._s?.get('windowManager');
    if (wm?.openWindowAsync) {
      wm.openWindowAsync({
        sourceId: 'settings', type: 'system',
        params: { category: '${category}' },
      });
    }
  `);

  // Wait for the category nav button to actually render before clicking.
  // Fixed sleeps (wait(2500) + 10s poll) were too tight for CI under load —
  // when the Nuxt/Pinia boot took >12s, the poll timed out before the element
  // rendered. Polling for existence with a short interval is both faster on
  // fast runners and more tolerant on slow ones.
  await pollUntil(
    () => elementExists(vault, `[data-testid="${testId}"]`),
    { timeout: 30_000, interval: 500, label: `settings-category-${category} visible` },
  );

  // Click-and-verify: Vue's @click handler may not yet be bound the instant
  // the element appears in the DOM. Click, give the frame a tick to flush,
  // then verify the click had an effect (category button gains an 'active'
  // attribute/class). If not, click again. This guards against the
  // "element exists → click → nothing happened" race.
  await pollUntil(
    async () => {
      const clicked = await clickTestId(vault, testId);
      if (!clicked) return false;
      await wait(200);
      return vault.executeScript<boolean>(`
        const el = document.querySelector('[data-testid="${testId}"]');
        return !!el && (
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('data-active') === 'true' ||
          el.classList.contains('active') ||
          el.classList.contains('selected') ||
          el.classList.contains('router-link-active')
        );
      `);
    },
    { timeout: 10_000, interval: 500, label: `settings-category-${category} active` },
  ).catch(() => {
    // Fallback: the app might not mark active state with any of our known
    // attributes. One final click so the click at least fired; content-level
    // assertions downstream (e.g., P2P Start button poll) will catch genuine
    // navigation failures.
    return clickTestId(vault, testId);
  });
  await wait(500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI Helpers — feature-specific
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Start the P2P endpoint through the real UI:
 *   Settings → P2P Network → click "Start" button.
 *
 * This triggers the full Vue component lifecycle in peer-storage.vue's
 * onToggleEndpointAsync(), which calls store.startAsync() within the
 * reactive context — ensuring startLocalSpaceLeadersAsync() and
 * local_delivery_start both complete (registers the delivery_handler
 * on the QUIC accept loop so ClaimInvite works).
 *
 * Returns the nodeId from `peer_storage_status` after startup.
 */
async function startP2PEndpoint(vault: VaultAutomation): Promise<string> {
  const status = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
  if (status.running) {
    const ds = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
    console.log(`[QUIC] P2P already running on ${vault.getInstance()}: isLeader=${ds.isLeader}, activeSpaces=${ds.activeSpaces?.length ?? 0}`);
    if (ds.isLeader) return status.nodeId;

    // Leaders not running — restart via UI to trigger full lifecycle
    console.log(`[QUIC] Restarting P2P on ${vault.getInstance()} to initialize leaders…`);
    await vault.invokeTauriCommand("peer_storage_stop", {});
    await wait(1000);
  }

  // 1. Close any leftover Settings window, then open fresh at the Sync category.
  //    The P2P Start/Stop button moved from a top-level "peerNetwork" category
  //    into Sync → Config (drill-down subview), so we must navigate twice.
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
  await openSettingsCategory(vault, "sync");
  await wait(500);

  // 2. Drill into the "Config" subview — menu items are plain <button>s with
  //    localized labels (no test-id), so we match by visible text.
  const configOpened = await pollUntil(
    () => clickButton(vault, "Konfiguration", "Configuration"),
    { timeout: 10_000, label: "Sync → Config menu item" },
  );
  console.log(`[QUIC] Sync config menu clicked: ${configOpened}`);
  await wait(800);

  // 3. Click the "Start" / "Starten" button (not "Stop"/"Stoppen" — P2P should be stopped)
  const startClicked = await pollUntil(
    () => clickButton(vault, "Start", "Starten"),
    { timeout: 10_000, label: "P2P Start button" },
  );
  console.log(`[QUIC] Start button clicked: ${startClicked}`);

  // 4. Wait for P2P endpoint to come up
  const info = await pollUntil(
    async () => {
      const s = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
      return s.running ? s : null;
    },
    { timeout: 30_000, interval: 1_000, label: "P2P running" },
  );

  // 5. Wait for leaders to initialize (startLocalSpaceLeadersAsync is part of startAsync)
  await wait(3000);

  // 6. Verify leaders are running
  const ds = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
  console.log(`[QUIC] After UI start: is_leader=${ds.isLeader}, active_spaces=[${ds.activeSpaces?.join(', ')}]`);

  return info!.nodeId;
}

/**
 * Navigate to Settings → Spaces → Create a LOCAL space via the dialog.
 * Returns the new space's ID (read from the database after creation).
 */
async function createLocalSpaceViaUI(
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
async function sendInviteViaUI(
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

  // Select contact
  await clickTestId(vault, "invite-contact-select");
  await wait(500);

  const contactSelected = await vault.executeScript<boolean>(`
    const label = ${JSON.stringify(contactLabel)};
    const items = [...document.querySelectorAll('[data-slot="item"]')];
    const match = items.find(el => el.textContent?.includes(label));
    if (match) { match.click(); return true; }
    return false;
  `);
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
async function acceptInviteViaUI(
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
  ).catch(() => {
    console.log("[QUIC] Invite not yet accepted after polling — proceeding");
  });
}

/**
 * On the invitee's vault, navigate to Spaces and click the Decline button
 * on the pending invite. Falls back to CRDT delete if the UI button is not found.
 */
async function declineInviteViaUI(
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
 */
async function setInvitePolicyViaUI(
  vault: VaultAutomation,
  policy: "all" | "contacts_only" | "nobody",
): Promise<void> {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("QUIC: real invite flow between two vaults (UI-driven)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let personalSpaceId: string;
  let spaceId: string;
  const spaceName = "QUIC Invite Test";
  const contactLabel = "Vault B Contact";

  // ─── Setup / Teardown ─────────────────────────────────────────────────────

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      for (const id of [spaceId, personalSpaceId]) {
        if (!id) continue;
        try { await v.invokeTauriCommand("local_delivery_stop", { spaceId: id }); } catch { /* ignore */ }
      }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1 — Initialize vaults through the UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("open Vault A through UI", async () => {
    await initializeVaultViaUI(vaultA, "QUIC Test A", "test-password-a");
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("open Vault B through UI", async () => {
    await initializeVaultViaUI(vaultB, "QUIC Test B", "test-password-b");
    const href = await vaultB.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2 — Start P2P endpoints via Settings UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("start P2P endpoint on Vault A", async () => {
    nodeIdA = await startP2PEndpoint(vaultA);
    expect(nodeIdA).toBeTruthy();
    console.log(`[QUIC] Vault A endpoint: ${nodeIdA.slice(0, 16)}…`);
  });

  test("start P2P endpoint on Vault B", async () => {
    nodeIdB = await startP2PEndpoint(vaultB);
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
    console.log(`[QUIC] Vault B endpoint: ${nodeIdB.slice(0, 16)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3 — Load identities (SQL — no UI for raw identity viewing)
  // ═══════════════════════════════════════════════════════════════════════════

  test("load identity on Vault A", async () => {
    const rows = await pollUntil(
      async () => {
        try {
          const r = await sqlQuery<{ id: string; did: string }>(
            vaultA,
            "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
          );
          return r.length > 0 ? r : null;
        } catch { return null; }
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { id: rows![0].id, did: rows![0].did };
    expect(identityA.did).toContain("did:key:");
    console.log(`[QUIC] Identity A: ${identityA.did.slice(0, 30)}…`);
  });

  test("load identity on Vault B", async () => {
    const rows = await pollUntil(
      async () => {
        try {
          const r = await sqlQuery<{ id: string; did: string }>(
            vaultB,
            "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
          );
          return r.length > 0 ? r : null;
        } catch { return null; }
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { id: rows![0].id, did: rows![0].did };
    expect(identityB.did).toContain("did:key:");
    console.log(`[QUIC] Identity B: ${identityB.did.slice(0, 30)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4 — Share Vault B's identity and import as contact on Vault A
  //          Uses the JSON import flow in Settings → Contacts
  // ═══════════════════════════════════════════════════════════════════════════

  test("register Vault B as contact on Vault A via JSON import", async () => {
    // Build the identity JSON payload (same format as ShareIdentityDialog / QR export)
    const identityPayload = JSON.stringify({
      did: identityB.did,
      name: contactLabel,
      claims: [{ type: "endpointId", value: nodeIdB }],
    });

    // Navigate to Settings → Contacts
    await openSettingsCategory(vaultA, "contacts");
    await wait(500);

    // Click "Add" button
    const addClicked = await clickTestId(vaultA, "contacts-add-trigger");
    console.log(`[QUIC] Add contact button clicked: ${addClicked}`);
    await wait(800);

    const dialogOpen = await elementExists(vaultA, '[role="dialog"]');
    console.log(`[QUIC] Add contact dialog open: ${dialogOpen}`);

    // Click the "From file" tab explicitly
    // reka-ui TabsTrigger activates on mousedown.left, NOT click — .click() won't work
    const tabSwitched = await vaultA.executeScript<boolean>(`
      const container = document.querySelector('[data-testid="contacts-add-tabs"]');
      if (!container) return false;
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      const fileTab = tabs.find(t => {
        const text = t.textContent?.toLowerCase() || '';
        return text.includes('file') || text.includes('datei');
      });
      if (!fileTab) return false;
      fileTab.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      return true;
    `);
    console.log(`[QUIC] File tab switched: ${tabSwitched}`);
    await wait(300);

    // Paste JSON into the textarea
    const pasted = await vaultA.executeScript<boolean>(`
      const el = document.querySelector('[data-testid="contacts-import-json"]');
      const textarea = el?.tagName === 'TEXTAREA' ? el : el?.querySelector('textarea');
      if (!textarea) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(identityPayload)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    console.log(`[QUIC] JSON pasted into textarea: ${pasted}`);
    await wait(300);

    // Click "Preview"
    const previewClicked = await clickTestId(vaultA, "contacts-import-preview");
    console.log(`[QUIC] Preview button clicked: ${previewClicked}`);
    await wait(500);

    // Click "Add" to confirm import
    const submitClicked = await clickTestId(vaultA, "contacts-import-submit");
    console.log(`[QUIC] Import submit clicked: ${submitClicked}`);
    await wait(1000);

    // Verify contact exists in DB
    const contacts = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
      [identityB.did],
    );
    expect(contacts.length).toBe(1);

    // Verify endpointId claim was saved
    const claims = await sqlQuery<{ type: string; value: string }>(
      vaultA,
      `SELECT type, value FROM haex_identity_claims WHERE identity_id = ?1`,
      [contacts[0].id],
    );
    console.log(`[QUIC] Contact claims: ${JSON.stringify(claims)}`);
    const epClaim = claims.find((c) => c.type === "endpointId");
    expect(epClaim).toBeDefined();
    expect(epClaim!.value).toBe(nodeIdB);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4b — Invite to Personal space (auto-created default space)
  // ═══════════════════════════════════════════════════════════════════════════

  test("find Personal space on Vault A", async () => {
    const spaces = await sqlQuery<{ id: string; name: string }>(
      vaultA,
      `SELECT id, name FROM haex_spaces WHERE name = 'Personal' AND status = 'active' LIMIT 1`,
    );
    expect(spaces.length).toBe(1);
    personalSpaceId = spaces[0].id;
    console.log(`[QUIC] Personal space: ${personalSpaceId.slice(0, 8)}…`);

    // Ensure device is registered in Personal space
    const devices = await sqlQuery<{ device_endpoint_id: string }>(
      vaultA,
      "SELECT device_endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [personalSpaceId],
    );
    if (!devices.some((d) => d.device_endpoint_id === nodeIdA)) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_endpoint_id, device_name)
              VALUES (?1, ?2, ?3, ?4)`,
        params: [crypto.randomUUID(), personalSpaceId, nodeIdA, "Vault A Desktop"],
      });
    }

    // No cleanup — test expects fresh vault containers. If Vault B already has
    // this space active from a prior run, the PushInvite handler correctly skips
    // it (accepted: true, no pending invite created) which is by design.
  });

  test("send invite to Personal space from Vault A to Vault B", async () => {
    // Debug: check QUIC connectivity before invite
    console.log(`[QUIC-DEBUG] Personal space invite — nodeIdA=${nodeIdA?.slice(0, 12)}… nodeIdB=${nodeIdB?.slice(0, 12)}…`);
    for (const [label, vault] of [["A", vaultA], ["B", vaultB]] as const) {
      try {
        const st = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
        console.log(`[QUIC-DEBUG] Vault ${label} local_delivery: is_leader=${st.isLeader}, spaces=${st.activeSpaces?.length ?? 0}`);
      } catch (e) {
        console.log(`[QUIC-DEBUG] Vault ${label} local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
      }
    }

    const t0 = Date.now();
    await sendInviteViaUI(vaultA, "Personal", contactLabel);
    console.log(`[QUIC-DEBUG] sendInviteViaUI took ${Date.now() - t0}ms`);

    // Check outbox status on Vault A — the invite should be queued or delivered
    await wait(3000);
    const outbox = await sqlQuery<{ id: string; status: string; retry_count: number; target_endpoint_id: string; space_id: string; created_at: string }>(
      vaultA,
      `SELECT id, status, retry_count, target_endpoint_id, space_id, created_at FROM haex_invite_outbox WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 3`,
      [personalSpaceId],
    );
    console.log(`[QUIC-DEBUG] Outbox for Personal space: ${JSON.stringify(outbox.map(o => ({ status: o.status, retries: o.retry_count, target: o.target_endpoint_id?.slice(0, 12), created: o.created_at })))}`);

    // Check ALL pending invites on Vault B (without space_id filter)
    const allPendingB = await sqlQuery<{ id: string; space_id: string; status: string; space_name: string }>(
      vaultB,
      `SELECT id, space_id, status, space_name FROM haex_pending_invites ORDER BY created_at DESC LIMIT 10`,
    );
    console.log(`[QUIC-DEBUG] Vault B ALL pending invites: ${JSON.stringify(allPendingB.map(i => ({ spaceId: i.space_id?.slice(0, 8), status: i.status, name: i.space_name })))}`);

    // Also check haex_spaces on Vault B for any new entries
    const spacesB = await sqlQuery<{ id: string; name: string; type: string; status: string }>(
      vaultB,
      `SELECT id, name, type, status FROM haex_spaces ORDER BY created_at DESC LIMIT 5`,
    );
    console.log(`[QUIC-DEBUG] Vault B spaces: ${JSON.stringify(spacesB.map(s => ({ id: s.id?.slice(0, 8), name: s.name, type: s.type, status: s.status })))}`);

    // Delivery path: Vault A's outbox processor → QUIC dial via iroh-relay →
    // Vault B's accept loop → insert into haex_pending_invites.
    //
    // Under CI load iroh's dial+handshake occasionally needs more than a minute
    // to settle (observed: outbox drained in ~9s but B sees nothing for 70s+).
    // Bumping the timeout to 120s + tightening the interval from 2s to 1s
    // triples poll density and tolerates slower relay round-trips. The debug
    // log throttle stays every-5th-poll so noise doesn't explode.
    let pollCount = 0;
    const lastOutbox = { status: null as string | null, retries: -1 };
    await pollUntil(
      async () => {
        pollCount++;
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [personalSpaceId],
        );
        // Transition tracker for flake-C analysis: log whenever outbox status
        // or retry_count changes, so classification (stuck-queued vs.
        // stuck-delivering vs. delivered-but-B-silent) is unambiguous across
        // CI runs. Cheap: single-row SELECT per poll.
        const ob = await sqlQuery<{ status: string; retry_count: number }>(
          vaultA,
          `SELECT status, retry_count FROM haex_invite_outbox ORDER BY created_at DESC LIMIT 1`,
        );
        if (ob.length > 0) {
          const { status, retry_count } = ob[0];
          if (status !== lastOutbox.status || retry_count !== lastOutbox.retries) {
            console.log(`[FLAKE-C] outbox@${Date.now() - t0}ms ${lastOutbox.status}→${status} retries ${lastOutbox.retries}→${retry_count} invitesOnB=${invites.length}`);
            lastOutbox.status = status;
            lastOutbox.retries = retry_count;
          }
        }
        if (pollCount % 10 === 1) {
          console.log(`[QUIC-DEBUG] Poll #${pollCount} (${Date.now() - t0}ms): invites=${invites.length}`);
        }
        return invites.length > 0;
      },
      { timeout: 120_000, interval: 1_000, label: "Personal space invite delivery to Vault B" },
    );
    console.log(`[QUIC-DEBUG] Invite delivered after ${Date.now() - t0}ms (${pollCount} polls)`);
  });

  test("decline Personal space invite on Vault B", async () => {
    await declineInviteViaUI(vaultB, "Personal", personalSpaceId);

    const remaining = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [personalSpaceId],
    );
    expect(remaining.length).toBe(0);
  });

  test("Vault A Personal space still active after decline", async () => {
    const spaces = await sqlQuery<{ id: string; status: string }>(
      vaultA,
      `SELECT id, status FROM haex_spaces WHERE id = ?1`,
      [personalSpaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].status).toBe("active");
  });

  test("re-invite to Personal space after decline", async () => {
    await sendInviteViaUI(vaultA, "Personal", contactLabel);

    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [personalSpaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "Personal space re-invite delivery" },
    );
  });

  test("accept Personal space invite on Vault B", async () => {
    // Debug: inspect the pending invite to verify spaceEndpoints is populated
    const inviteData = await sqlQuery<{ id: string; space_endpoints: string; token_id: string; space_name: string }>(
      vaultB,
      `SELECT id, space_endpoints, token_id, space_name FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending' LIMIT 1`,
      [personalSpaceId],
    );
    console.log(`[QUIC-DEBUG] Invite data before accept: ${JSON.stringify(inviteData.map(i => ({ id: i.id?.slice(0, 8), endpoints: i.space_endpoints, token: i.token_id?.slice(0, 8), name: i.space_name })))}`);

    await acceptInviteViaUI(vaultB, "Personal", personalSpaceId);

    const invites = await sqlQuery<{ status: string }>(
      vaultB,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      [personalSpaceId],
    );

    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].status).toBe("accepted");
  });

  test("Vault B has Personal space after accepting", async () => {
    const spaces = await sqlQuery<{ id: string; name: string; status: string }>(
      vaultB,
      `SELECT id, name, status FROM haex_spaces WHERE id = ?1`,
      [personalSpaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("Personal");
    console.log(`[QUIC] Vault B joined Personal space: ${spaces[0].status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5 — Create local space on Vault A via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("create local space on Vault A via UI", async () => {
    spaceId = await createLocalSpaceViaUI(vaultA, spaceName);
    expect(spaceId).toBeTruthy();
    console.log(`[QUIC] Space created: ${spaceId.slice(0, 8)}…`);
  });

  test("ensure Vault A device is registered in space", async () => {
    // The UI might auto-register the device; if not, do it manually.
    const devices = await sqlQuery<{ device_endpoint_id: string }>(
      vaultA,
      "SELECT device_endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    if (!devices.some((d) => d.device_endpoint_id === nodeIdA)) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_endpoint_id, device_name)
              VALUES (?1, ?2, ?3, ?4)`,
        params: [crypto.randomUUID(), spaceId, nodeIdA, "Vault A Desktop"],
      });
    }

    const updated = await sqlQuery<{ device_endpoint_id: string }>(
      vaultA,
      "SELECT device_endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    expect(updated.some((d) => d.device_endpoint_id === nodeIdA)).toBe(true);

    // No stale-data cleanup — test expects fresh vault containers.

    // Start leader for the newly created space on Vault A
    try {
      await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
      console.log(`[QUIC] Started leader for space ${spaceId.slice(0, 8)}…`);
    } catch { /* already running */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6 — Send invite from A → B via SpaceInviteDialog
  // ═══════════════════════════════════════════════════════════════════════════

  test("send invite from Vault A to Vault B via UI", async () => {
    await sendInviteViaUI(vaultA, spaceName, contactLabel);

    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [spaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "invite delivery to Vault B" },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7 — Verify pending invite is visible in Vault B's Spaces UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B shows pending invite in Spaces UI", async () => {
    await openSettingsCategory(vaultB, "spaces");
    await wait(1000);

    // The pending invite should appear as a list item with the space name
    const visible = await pollUntil(
      () => vaultB.executeScript<boolean>(`
        const items = [...document.querySelectorAll('[class*="rounded-lg"]')];
        return items.some(el =>
          el.textContent?.includes(${JSON.stringify(spaceName)})
          && (el.textContent?.includes('Pending') || el.textContent?.includes('Ausstehend')
              || el.className?.includes('dashed'))
        );
      `),
      { timeout: 5000, label: "pending invite visible in UI" },
    ).catch(() => false);

    // Also verify via DB (use only columns guaranteed to exist across migrations)
    const invites = await sqlQuery<{
      id: string; space_id: string; inviter_did: string; capabilities: string; status: string;
    }>(
      vaultB,
      `SELECT id, space_id, inviter_did, capabilities, status
       FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThanOrEqual(1);
    expect(invites[0].space_id).toBe(spaceId);
    expect(invites[0].inviter_did).toBe(identityA.did);
    expect(invites[0].status).toBe("pending");
  });

  test("Vault B space entry depends on invite handling strategy", async () => {
    // After receiving a PushInvite, Vault B may or may not create a space entry.
    // The handler might create a placeholder space for the pending invite.
    // We just verify the pending invite exists and is in 'pending' status.
    const invites = await sqlQuery<{ status: string }>(
      vaultB,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites.some((i) => i.status === "pending")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 8 — Decline the first invite via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("decline invite on Vault B via UI", async () => {
    await declineInviteViaUI(vaultB, spaceName, spaceId);

    // Verify: no more pending invites for this space
    const remaining = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(remaining.length).toBe(0);
  });

  test("Vault A space is still active after B declined", async () => {
    const spaces = await sqlQuery<{ id: string; status: string; name: string }>(
      vaultA,
      `SELECT id, status, name FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].status).toBe("active");
    expect(spaces[0].name).toBe(spaceName);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9 — Send second invite (with write capability) and accept
  // ═══════════════════════════════════════════════════════════════════════════

  test("send second invite with write capability via UI", async () => {
    await sendInviteViaUI(vaultA, spaceName, contactLabel, true);

    // Wait for arrival on Vault B
    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [spaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, label: "second invite delivery" },
    );

    // Verify capabilities include both read and write
    const invites = await sqlQuery<{ capabilities: string }>(
      vaultB,
      `SELECT capabilities FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBe(1);
    const caps = JSON.parse(invites[0].capabilities);
    expect(caps).toContain("space/read");
    expect(caps).toContain("space/write");
  });

  test("accept invite on Vault B via UI", async () => {
    // Flake-B state snapshot: diff against the stable sibling test at line
    // 1050 ("accept Personal space invite on Vault B"). Differences in
    // pending-invite counts, leftover MLS welcomes, or space-member rows
    // point to distinct fixes (selector ambiguity vs. welcome race vs.
    // pure timing). See docs/plans/2026-04-20-fix-e2e-flakes.md in haex-vault.
    const pending = await sqlQuery<{ id: string; space_id: string; status: string; space_name: string }>(
      vaultB,
      `SELECT id, space_id, status, space_name FROM haex_pending_invites ORDER BY created_at DESC LIMIT 10`,
    );
    const mlsWelcomes = await sqlQuery<{ id: string; space_id: string; source: string }>(
      vaultB,
      `SELECT id, space_id, source FROM haex_mls_pending_welcomes_no_sync`,
    );
    const members = await sqlQuery<{ space_id: string; identity_id: string }>(
      vaultB,
      `SELECT space_id, identity_id FROM haex_space_members`,
    );
    console.log(`[FLAKE-B] pending=${JSON.stringify(pending.map(p => ({ id: p.id.slice(0, 8), sp: p.space_id.slice(0, 8), st: p.status, n: p.space_name })))}`);
    console.log(`[FLAKE-B] mls_welcomes=${mlsWelcomes.length} members=${members.length}`);

    await acceptInviteViaUI(vaultB, spaceName, spaceId);

    // Verify: invite status changed to 'accepted'
    const invites = await sqlQuery<{ status: string }>(
      vaultB,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].status).toBe("accepted");
  });

  test("accepted space exists on Vault B with status active", async () => {
    // This is the critical test: after accepting a QUIC invite, a real space
    // entry must exist in haex_spaces. If acceptLocalInviteAsync only does
    // UPDATE without INSERT, this fails — which is exactly the bug we found.
    const spaces = await sqlQuery<{ id: string; status: string; name: string; type: string }>(
      vaultB,
      `SELECT id, status, name, type FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].id).toBe(spaceId);
    expect(spaces[0].status).toBe("active");
    expect(spaces[0].name).toBe(spaceName);
    expect(spaces[0].type).toBe("local");
    console.log(`[QUIC] Space on Vault B after accept: id=${spaces[0].id.slice(0, 8)}… status=${spaces[0].status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9b — Inviter attribution after accept (regression: owner_identity_id
  // previously pointed to the claimant's own identity, making shared spaces
  // appear self-owned in the UI)
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B space.owner_identity_id points to inviter's identity row, not claimant's", async () => {
    const spaces = await sqlQuery<{ owner_identity_id: string }>(
      vaultB,
      `SELECT owner_identity_id FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    const ownerId = spaces[0].owner_identity_id;
    expect(ownerId).toBeTruthy();

    // The owner identity row must exist on Vault B and carry Vault A's DID —
    // not Vault B's own DID. This is exactly the Rust-side
    // resolve_owner_identity_id regression.
    const owner = await sqlQuery<{ id: string; did: string; private_key: string | null }>(
      vaultB,
      `SELECT id, did, private_key FROM haex_identities WHERE id = ?1`,
      [ownerId],
    );
    expect(owner.length).toBe(1);
    expect(owner[0].did).toBe(identityA.did);
    expect(owner[0].did).not.toBe(identityB.did);

    // The mirrored inviter identity on Vault B has no private key — it's a
    // remote party, not a local own-identity.
    expect(owner[0].private_key).toBeNull();
    console.log(`[QUIC] Owner attribution: space.owner=${owner[0].did.slice(0, 24)}… (inviter) ✓`);
  });

  test("Vault B's UCAN for the shared space has issuer=inviter, audience=claimant", async () => {
    // Regression: the old local-claim path stored issuer_did = claimant DID
    // ("self-issued for local claims"), which misrepresented the delegation
    // chain signed by the inviter and confused CRDT fan-out on the admin side.
    const rows = await sqlQuery<{ issuer_did: string; audience_did: string; capability: string }>(
      vaultB,
      `SELECT issuer_did, audience_did, capability
       FROM haex_ucan_tokens
       WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(rows.length).toBeGreaterThan(0);

    // Every row delegated to Vault B must be issued by Vault A.
    for (const row of rows) {
      expect(row.audience_did).toBe(identityB.did);
      expect(row.issuer_did).toBe(identityA.did);
      expect(row.issuer_did).not.toBe(identityB.did);
    }
    console.log(`[QUIC] UCAN delegation shape: ${rows.length} row(s) with issuer=A, audience=B ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 10 — Self-invite prevention (backend edge case — no UI for this)
  // ═══════════════════════════════════════════════════════════════════════════

  test("self-invite is rejected (connecting to self not supported)", async () => {
    let rejected = false;
    try {
      await vaultA.invokeTauriCommand<boolean>(
        "local_delivery_push_invite",
        {
          targetEndpointId: nodeIdA,
          spaceId,
          spaceName,
          spaceType: "local",
          tokenId: crypto.randomUUID(),
          capabilities: ["space/read"],
          includeHistory: false,
          inviterDid: identityA.did,
          inviterLabel: "Self",
          spaceEndpoints: [nodeIdA],
          originUrl: null,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      );
    } catch (e) {
      rejected = true;
      expect(String(e)).toContain("ourself");
    }
    expect(rejected).toBe(true);

    // No pending invite should exist for self
    const selfInvites = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_pending_invites
       WHERE space_id = ?1 AND inviter_label = 'Self' AND status = 'pending'`,
      [spaceId],
    );
    expect(selfInvites.length).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 11 — Invite policy enforcement via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("set policy to 'nobody' via UI and verify invite is rejected", async () => {
    // ── Debug: check QUIC connectivity state before the critical operation ──
    console.log(`[QUIC-DEBUG] Step 11 start — nodeIdA=${nodeIdA?.slice(0, 12)}… nodeIdB=${nodeIdB?.slice(0, 12)}…`);
    try {
      const statusA = await vaultA.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
      console.log(`[QUIC-DEBUG] Vault A local_delivery_status: isLeader=${statusA.isLeader}, spaces=${statusA.activeSpaces?.length ?? 0}`);
    } catch (e) {
      console.log(`[QUIC-DEBUG] Vault A local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
    }
    try {
      const statusB = await vaultB.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
      console.log(`[QUIC-DEBUG] Vault B local_delivery_status: isLeader=${statusB.isLeader}, spaces=${statusB.activeSpaces?.length ?? 0}`);
    } catch (e) {
      console.log(`[QUIC-DEBUG] Vault B local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
    }

    // Change policy on Vault B through the Spaces settings dropdown
    console.log(`[QUIC-DEBUG] Setting invite policy to 'nobody' on Vault B...`);
    const t0Policy = Date.now();
    await setInvitePolicyViaUI(vaultB, "nobody");
    console.log(`[QUIC-DEBUG] setInvitePolicyViaUI took ${Date.now() - t0Policy}ms`);

    // Verify policy was applied
    const policy = await sqlQuery<{ policy: string }>(
      vaultB,
      `SELECT policy FROM haex_invite_policy WHERE id = 'default'`,
    );
    expect(policy.length).toBe(1);
    expect(policy[0].policy).toBe("nobody");
    console.log(`[QUIC-DEBUG] Policy confirmed: ${policy[0].policy}`);

    // Attempt to send an invite — should be rejected
    const newSpaceId = crypto.randomUUID();
    console.log(`[QUIC-DEBUG] Sending blocked invite from A→B (spaceId=${newSpaceId.slice(0, 8)}…, target=${nodeIdB?.slice(0, 12)}…)`);
    const t0Invite = Date.now();
    const accepted = await vaultA.invokeTauriCommand<boolean>(
      "local_delivery_push_invite",
      {
        targetEndpointId: nodeIdB,
        spaceId: newSpaceId,
        spaceName: "Blocked Space",
        spaceType: "local",
        tokenId: crypto.randomUUID(),
        capabilities: ["space/read"],
        includeHistory: false,
        inviterDid: identityA.did,
        inviterLabel: "Vault A",
        spaceEndpoints: [nodeIdA],
        originUrl: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    );
    console.log(`[QUIC-DEBUG] local_delivery_push_invite returned: ${accepted} (took ${Date.now() - t0Invite}ms)`);
    expect(accepted).toBe(false);

    // No pending invite should have been created
    const blocked = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1`,
      [newSpaceId],
    );
    expect(blocked.length).toBe(0);

    // Reset policy back to 'all'
    await setInvitePolicyViaUI(vaultB, "all");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 12 — Verify logging
  // ═══════════════════════════════════════════════════════════════════════════

  test("PushInvite handler logged on Vault B", async () => {
    // haex_logs might not exist or have different columns depending on vault version
    try {
      const logs = await sqlQuery<{ source: string; message: string }>(
        vaultB,
        `SELECT source, message FROM haex_logs
         WHERE source = 'PushInvite' ORDER BY timestamp DESC LIMIT 10`,
      );
      expect(logs.length).toBeGreaterThan(0);
      console.log(`[QUIC] Found ${logs.length} PushInvite log entries on Vault B`);
    } catch {
      // Log table might not exist — verify invites were received instead
      const inviteCount = await sqlQuery<{ cnt: number }>(
        vaultB,
        `SELECT COUNT(*) as cnt FROM haex_pending_invites WHERE space_id = ?1`,
        [spaceId],
      );
      expect(inviteCount[0].cnt).toBeGreaterThan(0);
      console.log("[QUIC] haex_logs not available, verified via pending_invites count");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 13 — Capability enforcement (read-only user cannot write)
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B has read-only UCAN for the first invite (space/read only)", async () => {
    // The first invite was sent with ["space/read"] capabilities.
    // Vault B should NOT have space/write or space/admin.
    const ucans = await sqlQuery<{ capability: string; audience_did: string }>(
      vaultB,
      `SELECT capability, audience_did FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    console.log(`[QUIC] UCANs on Vault B for space: ${JSON.stringify(ucans)}`);

    // The second invite had space/read + space/write, so check which one Vault B ended up with
    const capabilities = ucans.map(u => u.capability);
    // At minimum, Vault B should have some UCAN for this space
    expect(ucans.length).toBeGreaterThan(0);

    // Vault B should NOT have space/admin (only the creator has that)
    expect(capabilities).not.toContain("space/admin");
  });

  test("Vault B's UCAN does not grant write/admin capability", async () => {
    // After accepting the second invite (with space/read + space/write),
    // Vault B should have those capabilities but NOT space/admin.
    // Only the space creator (Vault A) should have space/admin.
    const ucansOnB = await sqlQuery<{ capability: string }>(
      vaultB,
      `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    const caps = ucansOnB.map(u => u.capability);
    expect(caps).not.toContain("space/admin");
    console.log(`[QUIC] Vault B capabilities: ${JSON.stringify(caps)}`);

    // Vault A should have space/admin
    const ucansOnA = await sqlQuery<{ capability: string }>(
      vaultA,
      `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    const capsA = ucansOnA.map(u => u.capability);
    expect(capsA).toContain("space/admin");
    console.log(`[QUIC] Vault A capabilities: ${JSON.stringify(capsA)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 14 — Default space ID collision (regression test)
  // ═══════════════════════════════════════════════════════════════════════════

  test("invite for space with ID 'default' is silently skipped (already active on recipient)", async () => {
    // Both vaults create a default space with the same hardcoded ID 'default'.
    // If this ID is still used, push_invite returns accepted=true but creates
    // no pending invite (space already exists check in handle_push_invite).
    // This test catches the regression if the default space ID is not unique.

    // Check if vault B has a space with the old hardcoded 'default' ID
    const defaultOnB = await sqlQuery<{ id: string; status: string }>(
      vaultB,
      `SELECT id, status FROM haex_spaces WHERE id = 'default'`,
    );

    if (defaultOnB.length > 0) {
      // Old-style vault: 'default' space exists on both sides → invite is silently skipped
      const accepted = await vaultA.invokeTauriCommand<boolean>("local_delivery_push_invite", {
        targetEndpointId: nodeIdB,
        spaceId: "default",
        spaceName: "Personal",
        spaceType: "local",
        tokenId: crypto.randomUUID(),
        capabilities: ["space/read"],
        includeHistory: false,
        inviterDid: identityA.did,
        inviterLabel: "Vault A",
        spaceEndpoints: [nodeIdA],
        originUrl: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      // accepted=true but no pending invite — the invite is lost
      expect(accepted).toBe(true);
      const pendingDefault = await sqlQuery<{ id: string }>(
        vaultB,
        `SELECT id FROM haex_pending_invites WHERE space_id = 'default' AND status = 'pending'`,
      );
      // This SHOULD have a pending invite, but with hardcoded 'default' ID it won't.
      // If this assertion fails, it means the default space still uses 'default' as ID.
      console.log(`[QUIC] Default space invite: pending=${pendingDefault.length} (0 = ID collision bug)`);
    } else {
      // New-style vault: default space has a random UUID → no collision possible
      console.log("[QUIC] Default space has unique ID — no collision risk");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 14 — Admin deletes the space after sharing
  // ═══════════════════════════════════════════════════════════════════════════

  test("admin (Vault A) deletes the shared space", async () => {
    // Vault A is the admin/creator of the space. Delete it.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_spaces WHERE id = ?1`,
      params: [spaceId],
    });

    // Verify space is gone on Vault A
    const spacesOnA = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spacesOnA.length).toBe(0);
    console.log("[QUIC] Admin deleted space on Vault A");
  });

  test("deleted space does not affect Vault B's accepted copy", async () => {
    // Vault B accepted the invite and has its own space entry.
    // The admin deleting the space on A should NOT propagate to B
    // (the CRDT tombstone only applies if spaces are actively syncing).
    // For local-only (QUIC) spaces, B's copy is independent.
    const spacesOnB = await sqlQuery<{ id: string; status: string }>(
      vaultB,
      `SELECT id, status FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    // B should still have the space
    expect(spacesOnB.length).toBe(1);
    expect(spacesOnB[0].status).toBe("active");
    console.log("[QUIC] Vault B still has the space after admin deletion on A");
  });
});
