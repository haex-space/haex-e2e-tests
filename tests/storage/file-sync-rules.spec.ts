import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../fixtures";
import { wait, pollUntil, sqlQuery } from "../helpers/ui/utils";
import {
  clickButton,
  clickButtonIn,
  clickTestId,
  setInputValue,
  elementExists,
} from "../helpers/ui/ui-primitives";
import { initializeVaultViaUI, openSettingsCategory, startP2PEndpoint } from "../helpers/ui/ui-vault";
import type { JsonValue, PeerStorageStatus } from "../helpers/ui/types";

/**
 * E2E regression suite for file-sync rules using a peer source.
 *
 * Specifically covers the path exercised by PR fix/file-sync-content-uri-manifest:
 * the server-side `handle_manifest` handler must return a valid recursive file
 * listing instead of an error when a sync rule calls `file_sync_trigger_now`
 * with `sourceType: "peer"`. The `PeerProvider` sends a `Request::Manifest`
 * over QUIC; the remote peer responds with `Response::Manifest` containing
 * a flat list of all files recursively.
 *
 * Desktop shares use the `scan_directory_recursive` code path;
 * Android Content URI shares use the new `scan_content_uri_recursive` path.
 * Both return identical `Response::Manifest` structures and are consumed by
 * the same client code in `PeerProvider::manifest()`.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncResult {
  filesDownloaded: number;
  filesDeleted: number;
  directoriesCreated: number;
  bytesTransferred: number;
  conflictsResolved: number;
  errors: string[];
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

  const spaces = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 LIMIT 1`,
    [spaceName],
  );
  expect(spaces.length).toBe(1);
  return spaces[0].id;
}

async function sendInviteViaUI(
  vault: VaultAutomation,
  spaceName: string,
  contactLabel: string,
  withWrite: boolean,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1000);

  await vault.executeScript(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const tourStore = pinia?._s?.get('tourStore');
    if (tourStore?.isActive) tourStore.complete();
  `);
  await wait(300);

  const spaceRow = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 LIMIT 1`,
    [spaceName],
  );
  const targetSpaceId = spaceRow[0]?.id;
  if (!targetSpaceId) throw new Error(`Space "${spaceName}" not found`);

  await clickTestId(vault, `space-invite-trigger-${targetSpaceId}`);
  await wait(300);
  await clickTestId(vault, `space-invite-option-contact-${targetSpaceId}`);
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
  spaceName: string,
  spaceId: string,
): Promise<void> {
  await openSettingsCategory(vault, "spaces");
  await wait(1500);

  await vault.executeScript<boolean>(`
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

  await pollUntil(
    async () => {
      const rows = await sqlQuery<{ status: string }>(
        vault,
        `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
        [spaceId],
      );
      return rows.length > 0 && rows[0].status === "accepted";
    },
    { timeout: 45_000, interval: 1_000, label: "invite accepted" },
  );
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

test.describe("file-sync: peer-to-local sync rule via manifest", () => {
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let spaceId: string;
  let actualContactLabel: string;

  const spaceName = "File Sync Manifest Test";
  const contactLabel = "Vault B (sync)";
  // Source dir on Vault A — the peer share
  const sourceDir = `/tmp/e2e-file-sync-source-${Date.now()}`;
  // Target dir on Vault B — where synced files land
  const targetDir = `/tmp/e2e-file-sync-target-${Date.now()}`;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const vault of [vaultA, vaultB]) {
      if (!vault) continue;
      try { await vault.invokeTauriCommand("file_sync_stop_all", {}); } catch { /* ignore */ }
      try { await vault.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
    try {
      await vaultA.invokeTauriCommand("filesystem_remove", { path: sourceDir, recursive: true });
    } catch { /* best effort */ }
    try {
      await vaultB.invokeTauriCommand("filesystem_remove", { path: targetDir, recursive: true });
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
  // Infrastructure setup (same pattern as cross-vault-file-sharing.spec.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  test("open Vault A via UI", async () => {
    await initializeVaultViaUI(vaultA, "Sync Rule A", "test-password-a");
    expect(await vaultA.executeScript<string>("return location.href")).toContain("/vault/");
  });

  test("open Vault B via UI", async () => {
    await initializeVaultViaUI(vaultB, "Sync Rule B", "test-password-b");
    expect(await vaultB.executeScript<string>("return location.href")).toContain("/vault/");
  });

  test("start P2P on Vault A", async () => {
    nodeIdA = await startP2PEndpoint(vaultA);
    expect(nodeIdA).toBeTruthy();
    console.log(`[FileSyncRules] Vault A endpoint: ${nodeIdA.slice(0, 16)}…`);
  });

  test("start P2P on Vault B", async () => {
    nodeIdB = await startP2PEndpoint(vaultB);
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
    console.log(`[FileSyncRules] Vault B endpoint: ${nodeIdB.slice(0, 16)}…`);
  });

  test("load identities on both vaults", async () => {
    const rowsA = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultA,
          "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { id: rowsA![0].id, did: rowsA![0].did };

    const rowsB = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultB,
          "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { id: rowsB![0].id, did: rowsB![0].did };

    expect(identityA.did).toContain("did:key:");
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

    // Poll for the row — onImportContactAsync chains async DB writes
    // (identity insert + claims + reactive store reload). The 1s wait
    // raced the insert under shard load and returned length=0.
    const contacts = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; name: string }>(
          vaultA,
          `SELECT id, name FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
          [identityB.did],
        );
        return r.length === 1 ? r : null;
      },
      { timeout: 10_000, interval: 500, label: "imported contact row on Vault A" },
    );
    expect(contacts).not.toBeNull();
    expect(contacts!.length).toBe(1);
    // Use the actual stored name — on reused vault containers a prior suite may
    // have already registered this DID under a different label (e.g. "Vault B").
    actualContactLabel = contacts![0].name;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Create source tree: root file + nested subdir
  // ═══════════════════════════════════════════════════════════════════════════

  test("create source file tree on Vault A", async () => {
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: sourceDir });
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: `${sourceDir}/docs` });
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: `${sourceDir}/docs/drafts` });

    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${sourceDir}/readme.txt`,
      data: Buffer.from("Sync test file").toString("base64"),
    });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${sourceDir}/docs/notes.txt`,
      data: Buffer.from("Notes content").toString("base64"),
    });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${sourceDir}/docs/drafts/draft.txt`,
      data: Buffer.from("Draft content — deeply nested").toString("base64"),
    });

    console.log(`[FileSyncRules] Source tree created at ${sourceDir}`);
  });

  test("create space, register device, and peer share on Vault A", async () => {
    spaceId = await createLocalSpaceViaUI(vaultA, spaceName);
    expect(spaceId).toBeTruthy();

    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    // device_id must point at the real haex_devices row of this vault (Phase 2
    // FK + UNIQUE(endpoint_id) — see cross-vault-file-sharing.spec.ts for the
    // rationale).
    const ownDeviceRows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      [nodeIdA],
    );
    expect(ownDeviceRows.length).toBe(1);
    const localDeviceIdA = ownDeviceRows[0].id;
    if (!devices.some((d) => d.endpoint_id === nodeIdA)) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        params: [crypto.randomUUID(), spaceId, localDeviceIdA, nodeIdA, "Vault A", "desktop", identityA.did],
      });
    }

    try {
      await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
    } catch { /* already running */ }

    const shareId = crypto.randomUUID();
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares
              (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [shareId, spaceId, localDeviceIdA, nodeIdA, "SyncShare", sourceDir, identityA.did],
    });

    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    console.log(`[FileSyncRules] Space ${spaceId.slice(0, 8)}… and share registered on Vault A`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Invite flow — needed for a real UCAN token on Vault B
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A sends invite with write capability to Vault B", async () => {
    await sendInviteViaUI(vaultA, spaceName, actualContactLabel, true);

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
    console.log(`[FileSyncRules] Invite delivered to Vault B`);
  });

  test("Vault B accepts the invite and gains a UCAN", async () => {
    await acceptInviteViaUI(vaultB, spaceName, spaceId);

    const ucans = await pollUntil(
      async () => {
        const rows = await sqlQuery<{ token: string }>(
          vaultB,
          `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
          [spaceId, identityB.did],
        );
        return rows.length > 0 ? rows : null;
      },
      { timeout: 60_000, interval: 2_000, label: "UCAN on Vault B" },
    );
    expect(ucans!.length).toBeGreaterThan(0);
    // Real JWT: three base64 segments
    expect(ucans![0].token.split(".").length).toBe(3);
    console.log(`[FileSyncRules] Vault B has ${ucans!.length} UCAN(s) for the space`);
  });

  test("Vault B device row propagates to Vault A (CRDT)", async () => {
    // Explicitly start Vault B's sync loop for the space. Invite-accept
    // alone is racy: when this test runs before B's loop has initialized,
    // the first local_delivery_force_sync below blocks for ~36s waiting
    // for implicit startup. local_delivery_start is idempotent — safe if
    // already running.
    await vaultB
      .invokeTauriCommand("local_delivery_start", { spaceId })
      .catch(() => { /* already running, command absent on older vault, etc. */ });

    // local_delivery_start returns fire-and-forget; the loop is only
    // actually initialized once spaceId appears in local_delivery_status
    // .activeSpaces. If we skip this wait and go straight to force_sync,
    // the FIRST force_sync call blocks for ~34s waiting on the same
    // initialization, burning a third of the 90s device-row budget. Wait
    // for activation on a separate budget so the device-row poll gets the
    // full 90s for actual CRDT propagation.
    await pollUntil(
      async () => {
        const status = await vaultB.invokeTauriCommand<{ activeSpaces?: string[] }>(
          "local_delivery_status",
          {},
        );
        return (status.activeSpaces ?? []).includes(spaceId);
      },
      { timeout: 60_000, interval: 1_000, label: "Vault B local_delivery active for space" },
    );

    // Nudge Vault B's sync loop on every tick so the next cycle starts
    // immediately rather than waiting up to POLL_INTERVAL (5s) on the
    // backend.
    await pollUntil(
      async () => {
        await vaultB
          .invokeTauriCommand("local_delivery_force_sync", { spaceId })
          .catch(() => { /* command absent on older vault */ });
        const rows = await sqlQuery<{ endpoint_id: string }>(
          vaultA,
          `SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1`,
          [spaceId],
        );
        return rows.some((r) => r.endpoint_id === nodeIdB);
      },
      { timeout: 90_000, interval: 500, label: "Vault B device row on Vault A" },
    );
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});
    console.log(`[FileSyncRules] Vault B is now an allowed peer on Vault A ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Core: file_sync_trigger_now — exercises the Manifest protocol path
  // ═══════════════════════════════════════════════════════════════════════════

  test("file_sync_trigger_now pulls all files from peer share into local target dir", async () => {
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(ucans.length).toBeGreaterThan(0);
    const ucanToken = ucans[0].token;

    await vaultB.invokeTauriCommand("filesystem_mkdir", { path: targetDir });

    // This is the call that exercises the Manifest path:
    // PeerProvider::manifest() → remote_manifest() → Request::Manifest → handle_manifest()
    // → scan_directory_recursive() → Response::Manifest { entries }
    const result = await vaultB.invokeTauriCommand<SyncResult>("file_sync_trigger_now", {
      ruleId: `e2e-manifest-test-${Date.now()}`,
      sourceType: "peer",
      sourceConfig: {
        endpointId: nodeIdA,
        relayUrl: null,
        path: "/SyncShare",
        ucanToken,
      },
      targetType: "local",
      targetConfig: { path: targetDir },
      direction: "one_way",
      deleteMode: "ignore",
    });

    console.log(`[FileSyncRules] Sync result: downloaded=${result.filesDownloaded}, dirs=${result.directoriesCreated}, bytes=${result.bytesTransferred}, errors=${JSON.stringify(result.errors)}`);

    // The manifest must have returned a file tree — if it had returned an error,
    // file_sync_trigger_now would have thrown.
    expect(result.errors).toHaveLength(0);
    // 3 files: readme.txt, docs/notes.txt, docs/drafts/draft.txt
    expect(result.filesDownloaded).toBe(3);
    // 2 dirs: docs/, docs/drafts/
    expect(result.directoriesCreated).toBe(2);
    expect(result.bytesTransferred).toBeGreaterThan(0);
  });

  test("synced readme.txt has correct content", async () => {
    const raw = await vaultB.invokeTauriCommand<string>("filesystem_read_file", {
      path: `${targetDir}/readme.txt`,
    });
    expect(Buffer.from(raw, "base64").toString("utf-8")).toBe("Sync test file");
  });

  test("synced docs/notes.txt has correct content", async () => {
    const raw = await vaultB.invokeTauriCommand<string>("filesystem_read_file", {
      path: `${targetDir}/docs/notes.txt`,
    });
    expect(Buffer.from(raw, "base64").toString("utf-8")).toBe("Notes content");
  });

  test("synced docs/drafts/draft.txt has correct content (deeply nested)", async () => {
    // This specifically validates that the manifest included the deeply nested file,
    // not just the top-level contents. If scan_directory_recursive only returned
    // top-level entries this file would be missing.
    const raw = await vaultB.invokeTauriCommand<string>("filesystem_read_file", {
      path: `${targetDir}/docs/drafts/draft.txt`,
    });
    expect(Buffer.from(raw, "base64").toString("utf-8")).toBe("Draft content — deeply nested");
  });

  test("re-running the sync rule is idempotent (no errors, files already up-to-date)", async () => {
    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    const ucanToken = ucans[0].token;

    const result = await vaultB.invokeTauriCommand<SyncResult>("file_sync_trigger_now", {
      ruleId: `e2e-manifest-idempotent-${Date.now()}`,
      sourceType: "peer",
      sourceConfig: {
        endpointId: nodeIdA,
        relayUrl: null,
        path: "/SyncShare",
        ucanToken,
      },
      targetType: "local",
      targetConfig: { path: targetDir },
      direction: "one_way",
      deleteMode: "ignore",
    });

    console.log(`[FileSyncRules] Re-sync result: downloaded=${result.filesDownloaded}, errors=${JSON.stringify(result.errors)}`);
    // No errors — the manifest must have been retrieved cleanly again
    expect(result.errors).toHaveLength(0);
    // Nothing new to download — files are identical
    expect(result.filesDownloaded).toBe(0);
  });

  test("new file added on Vault A appears after next sync", async () => {
    // Write an additional file on Vault A
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${sourceDir}/extra.txt`,
      data: Buffer.from("Extra file added after initial sync").toString("base64"),
    });

    const ucans = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    const ucanToken = ucans[0].token;

    // Give the filesystem a moment to flush the write
    await wait(500);

    const result = await vaultB.invokeTauriCommand<SyncResult>("file_sync_trigger_now", {
      ruleId: `e2e-manifest-newfile-${Date.now()}`,
      sourceType: "peer",
      sourceConfig: {
        endpointId: nodeIdA,
        relayUrl: null,
        path: "/SyncShare",
        ucanToken,
      },
      targetType: "local",
      targetConfig: { path: targetDir },
      direction: "one_way",
      deleteMode: "ignore",
    });

    expect(result.errors).toHaveLength(0);
    // Exactly one new file downloaded
    expect(result.filesDownloaded).toBe(1);

    const raw = await vaultB.invokeTauriCommand<string>("filesystem_read_file", {
      path: `${targetDir}/extra.txt`,
    });
    expect(Buffer.from(raw, "base64").toString("utf-8")).toBe(
      "Extra file added after initial sync",
    );
    console.log(`[FileSyncRules] Incremental sync picked up new file ✓`);
  });
});
