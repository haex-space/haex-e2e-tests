import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../fixtures";

/**
 * Cross-vault P2P file sharing E2E tests.
 *
 * Tests the full real-world flow:
 *  1. Vault A creates a space + shares a folder with real files
 *  2. Vault A invites Vault B via the real QUIC invite flow
 *  3. Vault B accepts the invite
 *  4. After accept, Vault B's device is registered in the space on Vault A
 *     (CRDT sync of haex_space_devices) and peer_storage_reload_shares fires.
 *  5. Vault B can LIST and DOWNLOAD files from Vault A via P2P.
 *
 * This is the regression suite for the bug where SyncPush ownership
 * violations caused whole-batch rejections, preventing Vault B's device row
 * from ever reaching Vault A — so the P2P connection was permanently denied.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  modified: number | null;
}

type JsonValue = string | number | boolean | null;

// ─── Utilities ───────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
    return obj as T;
  });
}

async function clickButton(vault: VaultAutomation, ...labels: string[]): Promise<boolean> {
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

async function clickTestId(vault: VaultAutomation, testId: string): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="${testId}"]');
    if (el) { el.click(); return true; }
    return false;
  `);
}

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

// ─── High-level UI helpers (ported from quic-invite-flow.spec.ts) ─────────────

async function elementExists(vault: VaultAutomation, selector: string): Promise<boolean> {
  return vault.executeScript<boolean>(`return !!document.querySelector('${selector}')`);
}

async function openSettingsCategory(vault: VaultAutomation, category: string): Promise<void> {
  const testId = `settings-category-${category}`;

  const activateCategory = () =>
    pollUntil(
      async () => {
        const clicked = await clickTestId(vault, testId);
        if (!clicked) return false;
        await wait(200);
        return vault.executeScript<boolean>(`
          const el = document.querySelector('[data-testid="${testId}"]');
          return !!el && el.classList.contains('bg-primary');
        `);
      },
      { timeout: 10_000, interval: 500, label: `settings-category-${category} active` },
    );

  if (await elementExists(vault, `[data-testid="${testId}"]`)) {
    await activateCategory();
    return;
  }

  // Settings window not open — open it via the Pinia window manager.
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

  await pollUntil(
    () => elementExists(vault, `[data-testid="${testId}"]`),
    { timeout: 30_000, interval: 500, label: `settings-category-${category} visible` },
  );

  await activateCategory();
}

async function initializeVaultViaUI(
  vault: VaultAutomation,
  vaultName: string,
  password: string,
): Promise<void> {
  const href = await vault.executeScript<string>("return location.href");
  if (href?.includes("/vault/")) return;

  const vaults = await vault.invokeTauriCommand<Array<{ name: string }>>("list_vaults", {});
  const exists = vaults.some((v) => v.name === vaultName);

  if (!exists) {
    await pollUntil(
      () => clickButton(vault, "Create vault", "Vault erstellen"),
      { timeout: 10_000, label: "Create vault button" },
    );
    await wait(1000);
    await vault.executeScript(`
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const nameInput = dialog.querySelector(
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])'
      );
      if (nameInput) {
        setter.call(nameInput, '');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(nameInput, ${JSON.stringify(vaultName)});
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      dialog.querySelectorAll('input[type="password"]').forEach(input => {
        setter.call(input, ${JSON.stringify(password)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    `);
    await wait(500);
    await clickButtonIn(vault, '[role="dialog"]', "Create", "Erstellen");
  } else {
    for (let attempt = 0; attempt < 5; attempt++) {
      const clicked = await vault.executeScript<boolean>(`
        const name = ${JSON.stringify(vaultName)};
        const slotBtns = [...document.querySelectorAll('button[data-slot="base"]')];
        const slotMatch = slotBtns.find(b => b.textContent?.trim().includes(name));
        if (slotMatch) { slotMatch.click(); return true; }
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
      await wait(2000);
    }
    await wait(1500);
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

  await pollUntil(
    () => vault.executeScript<boolean>("return location.href?.includes('/vault/')"),
    { timeout: 30_000, interval: 1_000, label: "vault navigation" },
  );
  await wait(2000);
}

async function startP2PEndpoint(vault: VaultAutomation): Promise<string> {
  const status = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
  if (status.running) {
    const ds = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
    if (ds.isLeader) return status.nodeId;
    await vault.invokeTauriCommand("peer_storage_stop", {});
    await wait(1000);
  }

  // Close leftover settings window
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

  // Navigate into the Config subview and click Start. If we're already in the
  // Config subview (left over from a previous suite's UI navigation), the
  // "Konfiguration" button won't exist as a clickable item — the Start button
  // will already be visible. Combining both into one poll handles both states.
  await pollUntil(
    async () => {
      await clickButton(vault, "Konfiguration", "Configuration");
      return clickButton(vault, "Start", "Starten");
    },
    { timeout: 15_000, label: "P2P Start button" },
  );

  const info = await pollUntil(
    async () => {
      const s = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
      return s.running ? s : null;
    },
    { timeout: 30_000, interval: 1_000, label: "P2P running" },
  );

  await wait(3000); // let leaders initialize
  return info!.nodeId;
}

async function createLocalSpaceViaUI(vault: VaultAutomation, spaceName: string): Promise<string> {
  await openSettingsCategory(vault, "spaces");
  await pollUntil(
    () => clickTestId(vault, "spaces-create-trigger"),
    { timeout: 10_000, interval: 300, label: "spaces-create-trigger" },
  );
  await setInputValue(
    vault,
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])',
    spaceName,
    '[data-testid="spaces-create-name"]',
  );
  await pollUntil(
    () => clickTestId(vault, "spaces-create-type-local"),
    { timeout: 10_000, interval: 300, label: "spaces-create-type-local" },
  );
  await pollUntil(
    () => clickTestId(vault, "spaces-create-submit"),
    { timeout: 10_000, interval: 300, label: "spaces-create-submit" },
  );
  await wait(1500);

  // Pick the newest matching space — multiple spaces may share the same
  // name across test retries on a persistent app instance, and we always
  // want the one we just created.
  const spaces = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 ORDER BY created_at DESC LIMIT 1`,
    [spaceName],
  );
  expect(spaces.length).toBe(1);
  return spaces[0].id;
}

async function sendInviteViaUI(
  vault: VaultAutomation,
  spaceId: string,
  contactLabel: string,
  withWrite = false,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1000);

  // Dismiss tour if active
  await vault.executeScript(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const tourStore = pinia?._s?.get('tourStore');
    if (tourStore?.isActive) tourStore.complete();
  `);
  await wait(300);

  await clickTestId(vault, `space-invite-trigger-${spaceId}`);
  await wait(300);
  await clickTestId(vault, `space-invite-option-contact-${spaceId}`);
  await wait(1000);

  await clickTestId(vault, "invite-contact-select");
  await wait(500);

  await vault.executeScript(`
    const label = ${JSON.stringify(contactLabel)};
    const items = [...document.querySelectorAll('[data-slot="item"]')];
    const match = items.find(el => el.textContent?.includes(label));
    if (match) match.click();
  `);
  await wait(300);
  await vault.executeScript(`document.body.click()`);
  await wait(300);

  if (withWrite) {
    await clickTestId(vault, "invite-cap-write");
    await wait(200);
  }

  await clickTestId(vault, "invite-submit");
  await wait(2000);
}

async function acceptInviteViaUI(
  vault: VaultAutomation,
  spaceId: string,
): Promise<void> {
  // Force a remount of the spaces settings panel: navigating to "spaces"
  // when the spaces panel is already open is a no-op and skips onMounted,
  // so loadInvitesAsync() doesn't re-run and pendingInvites can be stale
  // (e.g. when an earlier spec in the same shard left settings on "spaces").
  // A detour through another category guarantees onMounted fires when we
  // come back, refreshing pendingInvites from the DB.
  await openSettingsCategory(vault, "general");
  await wait(300);
  await openSettingsCategory(vault, "spaces");
  await wait(1500);

  // Find the pending space card by stable per-space testid and click its
  // Accept button. Targeting via spaceId avoids ambiguity when multiple
  // spaces share the same name (e.g. across test retries on a persistent
  // app instance).
  //
  // The card mounts asynchronously — `pendingInvites` is loaded reactively
  // after the haex_pending_invites row arrives — so the card may not exist
  // when this function first runs. Poll the click until either the click
  // lands or the SQL row flips to 'accepted', whichever comes first.
  await pollUntil(
    async () => {
      const clicked = await vault.executeScript<boolean>(`
        const card = document.querySelector('[data-testid="space-card-${spaceId}"]');
        if (!card) return false;
        const btns = [...card.querySelectorAll('button')];
        const acceptBtn = btns.find(b => {
          const t = b.textContent?.trim();
          return t?.includes('Accept') || t?.includes('Annehmen');
        });
        if (!acceptBtn || acceptBtn.disabled) return false;
        acceptBtn.click();
        return true;
      `);
      if (clicked) return true;
      // The accept may already have fired earlier — short-circuit if the
      // row is already accepted so we don't keep clicking after success.
      const rows = await sqlQuery<{ status: string }>(
        vault,
        `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
        [spaceId],
      );
      return rows.length > 0 && rows[0].status === "accepted";
    },
    { timeout: 30_000, interval: 500, label: "accept button clickable" },
  ).catch(() => console.log("[FileSharing] Accept button not clickable within 30s"));

  await pollUntil(
    async () => {
      const rows = await sqlQuery<{ status: string }>(
        vault,
        `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
        [spaceId],
      );
      return rows.length > 0 && rows[0].status === "accepted";
    },
    { timeout: 45_000, interval: 500, label: "invite accepted" },
  ).catch(() => console.log("[FileSharing] Invite not yet accepted after polling — proceeding"));
}

/**
 * Wipe leftover state from earlier runs (failed test + Playwright retry, or
 * earlier specs in the same shard sharing the WebDriver session). All steps
 * are best-effort: a fresh app has nothing to clean and the SQL DELETEs are
 * no-ops in that case.
 *
 *   1. Stop every running local_delivery loop so no stale sync attempts
 *      compete with the new test setup.
 *   2. Stop the P2P endpoint — startP2PEndpoint() restarts it cleanly.
 *   3. Drop pending invites scoped to this test's space name (no FK cascade
 *      on haex_pending_invites).
 *   4. Drop matching spaces. haex_space_devices and haex_peer_shares cascade
 *      via FK, so deleting the space is enough.
 */
async function resetTestState(
  vault: VaultAutomation,
  label: string,
  testSpaceName: string,
): Promise<void> {
  try {
    const status = await vault.invokeTauriCommand<{ activeSpaces?: string[] }>(
      "local_delivery_status",
      {},
    );
    for (const sid of status.activeSpaces ?? []) {
      try { await vault.invokeTauriCommand("local_delivery_stop", { spaceId: sid }); } catch { /* ok */ }
    }
  } catch { /* ok */ }

  try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ok */ }

  try {
    await vault.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_pending_invites WHERE space_name = ?1`,
      params: [testSpaceName],
    });
  } catch (e) { console.log(`[FileSharing] reset invites on ${label}: ${e}`); }

  try {
    await vault.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_spaces WHERE name = ?1`,
      params: [testSpaceName],
    });
  } catch (e) { console.log(`[FileSharing] reset spaces on ${label}: ${e}`); }
}

/**
 * On a sync timeout, the failure is one of:
 *   - leader never started       → local_delivery_status.activeSpaces empty
 *   - peer storage offline       → peer_storage_status.running = false
 *   - leader didn't accept push  → device row missing on A but present on B
 *   - never inserted on B        → device row missing on both
 *   - pending invite not delivered/accepted → status anomalies
 *
 * Without this dump the failure looks like an opaque 60s timeout. Each branch
 * below answers one of the questions above so the next failure is sortable
 * from the log alone.
 */
async function dumpSyncDiagnostics(
  vaultA: VaultAutomation,
  vaultB: VaultAutomation,
  spaceId: string,
  nodeIdB: string,
): Promise<void> {
  const safe = async <T>(fn: () => Promise<T>, label: string): Promise<T | string> => {
    try { return await fn(); } catch (e) { return `<error: ${(e as Error).message ?? e}> on ${label}`; }
  };

  const [
    statusA, statusB,
    peerA, peerB,
    devicesA, devicesB,
    invitesA, invitesB,
  ] = await Promise.all([
    safe(() => vaultA.invokeTauriCommand("local_delivery_status", {}), "A.local_delivery_status"),
    safe(() => vaultB.invokeTauriCommand("local_delivery_status", {}), "B.local_delivery_status"),
    safe(() => vaultA.invokeTauriCommand("peer_storage_status", {}), "A.peer_storage_status"),
    safe(() => vaultB.invokeTauriCommand("peer_storage_status", {}), "B.peer_storage_status"),
    safe(() => sqlQuery(vaultA, `SELECT endpoint_id, name FROM haex_space_devices WHERE space_id = ?1`, [spaceId]), "A.haex_space_devices"),
    safe(() => sqlQuery(vaultB, `SELECT endpoint_id, name FROM haex_space_devices WHERE space_id = ?1`, [spaceId]), "B.haex_space_devices"),
    safe(() => sqlQuery(vaultA, `SELECT id, status, created_at FROM haex_pending_invites WHERE space_id = ?1`, [spaceId]), "A.haex_pending_invites"),
    safe(() => sqlQuery(vaultB, `SELECT id, status, created_at FROM haex_pending_invites WHERE space_id = ?1`, [spaceId]), "B.haex_pending_invites"),
  ]);

  console.log("[FileSharing][diag] ──── sync timeout diagnostics ────");
  console.log(`[FileSharing][diag] spaceId=${spaceId.slice(0, 8)}… expected nodeIdB=${nodeIdB.slice(0, 16)}…`);
  console.log(`[FileSharing][diag] A.local_delivery_status: ${JSON.stringify(statusA)}`);
  console.log(`[FileSharing][diag] B.local_delivery_status: ${JSON.stringify(statusB)}`);
  console.log(`[FileSharing][diag] A.peer_storage_status:   ${JSON.stringify(peerA)}`);
  console.log(`[FileSharing][diag] B.peer_storage_status:   ${JSON.stringify(peerB)}`);
  console.log(`[FileSharing][diag] A.space_devices: ${JSON.stringify(devicesA)}`);
  console.log(`[FileSharing][diag] B.space_devices: ${JSON.stringify(devicesB)}`);
  console.log(`[FileSharing][diag] A.pending_invites: ${JSON.stringify(invitesA)}`);
  console.log(`[FileSharing][diag] B.pending_invites: ${JSON.stringify(invitesB)}`);
  console.log("[FileSharing][diag] ────────────────────────────────────");
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

test.describe("cross-vault P2P file sharing after real invite", () => {
  // retries=0: Playwright reuses the same WebDriver session across retries,
  // so a failed run leaves the Tauri app in a polluted state (active loops,
  // half-accepted invites, lingering rows). Retries here typically fail with
  // misleading errors that hide the real root cause. Better to see the
  // primary failure with the diagnostic dump than to chase ghost retries.
  test.describe.configure({ mode: "serial", retries: 0 });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let spaceId: string;

  const spaceName = "File Sharing Test";
  const contactLabel = "Vault B";
  const testDir = `/tmp/e2e-file-sharing-${Date.now()}`;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Reset state from any previous run on this persistent app instance.
    // The same WebDriver session is reused across Playwright retries and
    // across other specs in the same shard, so leftover spaces, invites,
    // and active local_delivery loops can poison this suite.
    await resetTestState(vaultA, "Vault A", spaceName);
    await resetTestState(vaultB, "Vault B", spaceName);
  });

  test.afterAll(async () => {
    for (const vault of [vaultA, vaultB]) {
      if (!vault) continue;
      try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
    try {
      await vaultA.invokeTauriCommand("filesystem_remove", { path: testDir, recursive: true });
    } catch { /* best effort */ }
    // Release the per-suite vault B mount and reset the UI to root so the
    // next suite's beforeAll starts with a clean AppState. Without close_database
    // it gets VaultAlreadyMountedInProcess; without the navigate the WebView
    // stays on /vault/... and initializeVaultViaUI early-returns thinking
    // vault B is open while the DB is actually unmounted. Vault A is opened
    // by global-setup and shared across suites — do NOT close it.
    try { await vaultB.invokeTauriCommand("close_database", {}); } catch { /* ignore */ }
    try { await vaultB.navigateTo("/"); } catch { /* ignore */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Setup
  // ═══════════════════════════════════════════════════════════════════════════

  test("open Vault A via UI", async () => {
    await initializeVaultViaUI(vaultA, "File Sharing A", "test-password-a");
    expect(await vaultA.executeScript<string>("return location.href")).toContain("/vault/");
  });

  test("open Vault B via UI", async () => {
    await initializeVaultViaUI(vaultB, "File Sharing B", "test-password-b");
    expect(await vaultB.executeScript<string>("return location.href")).toContain("/vault/");
  });

  test("start P2P on Vault A (with leader)", async () => {
    nodeIdA = await startP2PEndpoint(vaultA);
    expect(nodeIdA).toBeTruthy();
    console.log(`[FileSharing] Vault A endpoint: ${nodeIdA.slice(0, 16)}…`);
  });

  test("start P2P on Vault B", async () => {
    nodeIdB = await startP2PEndpoint(vaultB);
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
    console.log(`[FileSharing] Vault B endpoint: ${nodeIdB.slice(0, 16)}…`);
  });

  test("load identity on Vault A", async () => {
    const rows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultA,
          "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { id: rows![0].id, did: rows![0].did };
    expect(identityA.did).toContain("did:key:");
  });

  test("load identity on Vault B", async () => {
    const rows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultB,
          "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { id: rows![0].id, did: rows![0].did };
    expect(identityB.did).toContain("did:key:");
  });

  test("register Vault B as contact on Vault A", async () => {
    const identityPayload = JSON.stringify({
      did: identityB.did,
      name: contactLabel,
      claims: [{ type: "endpointId", value: nodeIdB }],
    });

    await openSettingsCategory(vaultA, "contacts");
    await wait(500);
    await clickTestId(vaultA, "contacts-add-trigger");
    await wait(800);

    await vaultA.executeScript(`
      const container = document.querySelector('[data-testid="contacts-add-tabs"]');
      if (!container) return;
      const tabs = [...container.querySelectorAll('[role="tab"]')];
      const fileTab = tabs.find(t => {
        const text = t.textContent?.toLowerCase() || '';
        return text.includes('file') || text.includes('datei');
      });
      if (fileTab) fileTab.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    `);
    await wait(300);

    await vaultA.executeScript(`
      const el = document.querySelector('[data-testid="contacts-import-json"]');
      const textarea = el?.tagName === 'TEXTAREA' ? el : el?.querySelector('textarea');
      if (!textarea) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(identityPayload)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await wait(300);
    await clickTestId(vaultA, "contacts-import-preview");
    await wait(500);
    await clickTestId(vaultA, "contacts-import-submit");
    await wait(1000);

    const contacts = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
      [identityB.did],
    );
    expect(contacts.length).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Create real test files + share
  // ═══════════════════════════════════════════════════════════════════════════

  test("create real test files on Vault A", async () => {
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: testDir });

    const helloBase64 = Buffer.from("Hello from Vault A!").toString("base64");
    const nestedBase64 = Buffer.from("Nested file content").toString("base64");

    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/hello.txt`,
      data: helloBase64,
    });
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: `${testDir}/subfolder` });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/subfolder/nested.txt`,
      data: nestedBase64,
    });

    console.log(`[FileSharing] Test files created at ${testDir}`);
  });

  test("create local space on Vault A", async () => {
    spaceId = await createLocalSpaceViaUI(vaultA, spaceName);
    expect(spaceId).toBeTruthy();
    console.log(`[FileSharing] Space: ${spaceId.slice(0, 8)}…`);
  });

  test("register Vault A device in the space and create peer share", async () => {
    // Ensure Vault A's device is registered in the space
    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    // device_id references the publishing vault's haex_devices.id — random
    // UUID is fine for tests since the FK is not enforced.
    const localDeviceIdA = crypto.randomUUID();
    if (!devices.some((d) => d.endpoint_id === nodeIdA)) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        params: [crypto.randomUUID(), spaceId, localDeviceIdA, nodeIdA, "Vault A", "desktop"],
      });
    }

    // Start space leader. local_delivery_start is idempotent — it overwrites
    // the leader-state map entry — so a real error here (e.g. peer storage
    // not running, HLC lock poisoned) is a hard failure that would silently
    // turn into a 60s sync-loop timeout later. Surface it instead.
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });

    // Create peer share pointing to the real test directory
    const shareId = crypto.randomUUID();
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares
              (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [shareId, spaceId, localDeviceIdA, nodeIdA, "TestShare", testDir, identityA.did],
    });

    // Reload so the running endpoint picks up the new share
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    const shares = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_peer_shares WHERE space_id = ?1 AND endpoint_id = ?2",
      [spaceId, nodeIdA],
    );
    expect(shares.length).toBeGreaterThanOrEqual(1);
    console.log(`[FileSharing] Share registered on Vault A`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Real invite flow
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A sends invite to Vault B", async () => {
    await sendInviteViaUI(vaultA, spaceId, contactLabel, true);

    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [spaceId],
        );
        return invites.length > 0;
      },
      { timeout: 90_000, interval: 2_000, label: "invite delivered to Vault B" },
    );
    console.log(`[FileSharing] Invite delivered to Vault B`);
  });

  test("Vault B accepts the invite", async () => {
    await acceptInviteViaUI(vaultB, spaceId);

    const invites = await sqlQuery<{ status: string }>(
      vaultB,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].status).toBe("accepted");
    console.log(`[FileSharing] Vault B accepted invite`);
  });

  test("Vault B has the space active after accepting", async () => {
    const spaces = await sqlQuery<{ id: string; status: string }>(
      vaultB,
      `SELECT id, status FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].status).toBe("active");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Core regression: after accept, P2P access must work
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B's device row syncs to Vault A after invite accept (CRDT)", async () => {
    // This is the critical pre-condition for P2P access:
    // Vault B's haex_space_devices row must reach Vault A via CRDT SyncPush.
    //
    // The regression being tested: if SyncPush was rejected as a whole batch
    // (due to foreign membership rows), this row never arrived and
    // peer_storage_reload_shares could not include Vault B in allowed_peers.
    //
    // Explicitly start Vault B's sync loop for the space. Invite-accept alone
    // is racy: in CI the diagnostic dump showed B.activeSpaces did NOT include
    // the freshly-accepted space, so CRDT push never even started and we burned
    // the entire 90s budget waiting. local_delivery_start is idempotent — safe
    // if already running.
    await vaultB
      .invokeTauriCommand("local_delivery_start", { spaceId })
      .catch(() => { /* already running, command absent on older vault, etc. */ });

    // We nudge Vault B's sync loop on every poll tick so the next cycle
    // starts immediately instead of waiting up to POLL_INTERVAL (5s) on the
    // backend. force_sync is a no-op when the loop has not been created
    // yet (e.g. local_delivery_connect after accept hasn't completed),
    // so the call is safe to fire blindly from the start of polling.
    try {
      await pollUntil(
        async () => {
          await vaultB
            .invokeTauriCommand("local_delivery_force_sync", { spaceId })
            .catch(() => { /* loop may not exist yet — that's fine */ });
          const rows = await sqlQuery<{ endpoint_id: string }>(
            vaultA,
            `SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1`,
            [spaceId],
          );
          return rows.some((r) => r.endpoint_id === nodeIdB);
        },
        { timeout: 90_000, interval: 500, label: "Vault B device row on Vault A" },
      );
    } catch (err) {
      await dumpSyncDiagnostics(vaultA, vaultB, spaceId, nodeIdB);
      throw err;
    }
    console.log(`[FileSharing] Vault B device row reached Vault A ✓`);
  });

  test("Vault A's allowed_peers includes Vault B (peer_storage_reload_shares fired)", async () => {
    // After Vault B's haex_space_devices row syncs, leader.rs emits
    // local-sync-completed → orchestrator calls peer_storage_reload_shares →
    // PeerStorage.allowed_peers gains Vault B's endpoint. Verify by calling
    // reload_shares ourselves and checking the count increased.
    const loaded = await vaultA.invokeTauriCommand<number>("peer_storage_reload_shares", {});
    expect(loaded).toBeGreaterThanOrEqual(1);

    // Verify via Pinia store that allowed_peers contains Vault B
    const allowedCount = await vaultA.executeScript<number>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const peerStore = pinia?._s?.get('peerStorageStore');
      const devices = peerStore?.spaceDevices ?? [];
      return devices.filter(d => d.endpointId === ${JSON.stringify(nodeIdB)}).length;
    `);
    console.log(`[FileSharing] Pinia spaceDevices entries for B: ${allowedCount}`);
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(allowedCount).toBeGreaterThanOrEqual(1);
  });

  test("Vault B's UCAN for the space is stored and valid", async () => {
    const ucans = await sqlQuery<{ token: string; capability: string }>(
      vaultB,
      `SELECT token, capability FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    // The UCAN JWT must be a non-empty string (header.payload.signature format)
    const token = ucans[0].token;
    expect(token).toBeTruthy();
    expect(token.split(".").length).toBe(3);
    console.log(`[FileSharing] Vault B has ${ucans.length} UCAN(s) for space, cap=${ucans[0].capability}`);
  });

  test("Vault B can LIST files from Vault A via P2P", async () => {
    // Get UCAN for authentication (real token issued by Vault A to Vault B)
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    const ucanToken = ucans[0].token;

    // This call MUST succeed: if Vault B's endpoint is not in allowed_peers on
    // Vault A, the QUIC connection is rejected with "not registered in any shared
    // space" and this command errors. The regression we fixed would have caused
    // exactly that error here.
    const t0 = Date.now();
    let entries: FileEntry[];
    try {
      entries = await vaultB.invokeTauriCommand<FileEntry[]>(
        "peer_storage_remote_list",
        {
          nodeId: nodeIdA,
          relayUrl: null,
          path: "/",
          ucanToken,
        },
      );
    } catch (err) {
      // Diagnostic: check if Vault A has Vault B in allowed_peers
      const devicesOnA = await sqlQuery<{ endpoint_id: string }>(
        vaultA,
        `SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1`,
        [spaceId],
      );
      console.log(`[FileSharing] peer_storage_remote_list FAILED. devicesOnA=${JSON.stringify(devicesOnA.map(d => d.endpoint_id.slice(0, 12)))}, nodeIdB=${nodeIdB.slice(0, 12)}`);
      throw err;
    }
    console.log(`[FileSharing] peer_storage_remote_list took ${Date.now() - t0}ms, entries=${entries.length}`);

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const testShare = entries.find((e) => e.name === "TestShare");
    expect(testShare).toBeDefined();
    expect(testShare!.isDir).toBe(true);
    console.log(`[FileSharing] Vault B listed root shares from Vault A: ${entries.map(e => e.name).join(", ")} ✓`);
  });

  test("Vault B can LIST files inside the shared folder", async () => {
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    const ucanToken = ucans[0].token;

    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      {
        nodeId: nodeIdA,
        relayUrl: null,
        path: "/TestShare",
        ucanToken,
      },
    );

    expect(entries.length).toBe(2); // hello.txt + subfolder
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("hello.txt");
    expect(names).toContain("subfolder");

    const hello = entries.find((e) => e.name === "hello.txt")!;
    expect(hello.isDir).toBe(false);
    expect(hello.size).toBe(19); // "Hello from Vault A!" = 19 bytes
    console.log(`[FileSharing] Vault B can browse files inside TestShare ✓`);
  });

  test("Vault B can DOWNLOAD a file from Vault A via P2P", async () => {
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    const ucanToken = ucans[0].token;

    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: null,
      path: "/TestShare/hello.txt",
      ucanToken,
    });

    expect(localPath).toBeTruthy();
    expect(localPath).toContain("hello.txt");

    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file",
      { path: localPath },
    );
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    expect(decoded).toBe("Hello from Vault A!");
    console.log(`[FileSharing] Vault B downloaded hello.txt from Vault A: "${decoded}" ✓`);
  });

  test("Vault B can download from nested subdirectory", async () => {
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    const ucanToken = ucans[0].token;

    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: null,
      path: "/TestShare/subfolder/nested.txt",
      ucanToken,
    });

    expect(localPath).toBeTruthy();
    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file",
      { path: localPath },
    );
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    expect(decoded).toBe("Nested file content");
    console.log(`[FileSharing] Vault B downloaded nested.txt from Vault A ✓`);
  });
});
