import type { VaultAutomation } from "../../fixtures";
import type { PeerStorageStatus } from "./types";
import { pollUntil, wait } from "./utils";
import {
  clickButton,
  clickButtonIn,
  clickTestId,
  elementExists,
} from "./ui-primitives";

/**
 * Open (or create) a vault through the real UI.
 * Triggers the full Nuxt lifecycle: Pinia stores → identity creation → extension loading.
 * NEVER uses location.reload() (would destroy the WebDriver session).
 */
export async function initializeVaultViaUI(
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
export async function openSettingsCategory(
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
export async function startP2PEndpoint(vault: VaultAutomation): Promise<string> {
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

  // 5. If the vault already has local spaces, the leader for at least one of
  // them must come up after `startAsync`. Poll until that's true so later
  // QUIC steps don't run on a half-initialized peer. A fresh vault with no
  // local spaces yet legitimately has isLeader=false, so skip the wait there.
  // Note: do NOT swallow SQL/IPC errors here with `.catch(() => 0)`. A real
  // backend failure would silently take the "fresh vault" branch below and
  // skip the leader-ready wait, returning a half-initialized peer that
  // breaks later QUIC steps far from the root cause. Any error here is a
  // genuine precondition failure and should surface immediately.
  const localSpaceRows = await vault.invokeTauriCommand<Array<[number]>>("sql_select_with_crdt", {
    sql: `SELECT COUNT(*) FROM haex_spaces WHERE type = 'local'`,
    params: [],
  });
  const localSpaceCount = Number(localSpaceRows?.[0]?.[0] ?? 0);

  if (localSpaceCount > 0) {
    const ds = await pollUntil(
      async () => {
        const current = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>(
          "local_delivery_status",
          {},
        );
        return current.isLeader && (current.activeSpaces?.length ?? 0) > 0 ? current : null;
      },
      { timeout: 15_000, interval: 500, label: "local delivery leader ready" },
    );
    console.log(`[QUIC] After UI start: is_leader=${ds!.isLeader}, active_spaces=[${ds!.activeSpaces?.join(', ')}]`);
  } else {
    // No local spaces yet — leader is expected to be inactive. Log once for
    // visibility and move on.
    const ds = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>(
      "local_delivery_status",
      {},
    );
    console.log(`[QUIC] After UI start: is_leader=${ds.isLeader} (no local spaces yet, expected)`);
  }

  return info!.nodeId;
}
