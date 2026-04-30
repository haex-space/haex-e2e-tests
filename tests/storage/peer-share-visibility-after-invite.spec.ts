import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../fixtures";

/**
 * Regression tests: P2P file visibility after QUIC invite acceptance
 *
 * Bug: after a QUIC invite is accepted, the invitee (Vault B) could see share
 * folder entries at root "/" but not list files inside them. Root listing
 * skips the allowed_peers check; sub-folder listing calls find_share_and_subpath
 * which filters by allowed_peers. Vault B's endpoint was never inserted into
 * haex_space_devices for the new space, so Vault A never added Vault B to
 * allowed_peers.
 *
 * Fix (src/stores/spaces/invites.ts): claimPendingLocalInviteAsync now calls
 * registerDeviceInSpaceAsync for the new space before starting the sync loop.
 *
 * Test coverage:
 *   1. Vault B's own nodeId appears in haex_space_devices immediately after
 *      acceptLocalInviteAsync completes (no sync roundtrip required).
 *   2. The row propagates to Vault A via CRDT sync, so Vault A adds Vault B
 *      to allowed_peers on the next reload.
 *   3. Vault B can list files at root "/" (share folder visible — was already
 *      working before the fix, kept as baseline).
 *   4. Vault B can list files INSIDE the share folder (was the failing case).
 *   5. Vault B can download a file from inside the share.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

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

// ─── Utilities ────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 15_000, interval = 1_000, label = "condition" } = opts;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
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
  const rows = await vault.invokeTauriCommand<JsonValue[][]>("sql_select_with_crdt", {
    sql,
    params,
  });
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => { obj[col] = row[i] ?? null; });
    return obj as T;
  });
}

async function clickTestId(vault: VaultAutomation, testId: string): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="${testId}"]');
    if (el) { el.click(); return true; }
    return false;
  `);
}

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

async function createLocalSpaceViaUI(vault: VaultAutomation, spaceName: string): Promise<string> {
  await openSettingsCategory(vault, "spaces");
  await clickTestId(vault, "spaces-create-trigger");
  await wait(800);
  await setInputValue(
    vault,
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])',
    spaceName,
    '[data-testid="spaces-create-name"]',
  );
  await wait(300);
  await clickTestId(vault, "spaces-create-type-local");
  await wait(300);
  await clickTestId(vault, "spaces-create-submit");
  await wait(1500);

  const spaces = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM haex_spaces WHERE name = ?1 LIMIT 1`,
    [spaceName],
  );
  expect(spaces.length).toBe(1);
  return spaces[0].id;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

test.describe("storage: P2P file visibility after QUIC invite accept", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let spaceId: string;
  let inviteTokenId: string;
  const shareName = "SharedDocs";
  const testDir = `/tmp/e2e-share-vis-${Date.now()}`;
  let ucanTokenForB: string;

  // ─── Setup / Teardown ────────────────────────────────────────────────────

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      if (spaceId) {
        try { await v.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* ignore */ }
      }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
    try {
      await vaultA.invokeTauriCommand("filesystem_remove", { path: testDir, recursive: true });
    } catch { /* best effort */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1 — Ensure vaults are open
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A is open (set up by global-setup)", async () => {
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("Vault B has an open vault", async () => {
    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "ShareVis Test Vault B",
        key: "test-password-b",
        spaceId: null,
      });
    } catch {
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>(
        "list_vaults", {},
      );
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", {
          vaultPath: vaults[0].path,
          key: "test-password-b",
        });
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2 — Start P2P endpoints on both vaults
  // ═══════════════════════════════════════════════════════════════════════════

  test("start P2P endpoint on Vault A", async () => {
    const status = await vaultA.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    if (status.running) {
      nodeIdA = status.nodeId;
      // Re-invoke to get the relay URL (status doesn't expose it)
      const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>(
        "peer_storage_start", {},
      ).catch(() => null);
      relayUrlA = info?.relayUrl ?? null;
    } else {
      const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
      nodeIdA = info.nodeId;
      relayUrlA = info.relayUrl;
    }
    expect(nodeIdA).toBeTruthy();
    console.log(`[SHARE-VIS] Vault A: nodeId=${nodeIdA.slice(0, 16)}…`);
  });

  test("start P2P endpoint on Vault B", async () => {
    const status = await vaultB.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    if (status.running) {
      nodeIdB = status.nodeId;
    } else {
      const info = await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
      nodeIdB = info.nodeId;
    }
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
    console.log(`[SHARE-VIS] Vault B: nodeId=${nodeIdB.slice(0, 16)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3 — Load identities
  // ═══════════════════════════════════════════════════════════════════════════

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

    expect(identityA.did).toContain("did:key:");
    expect(identityB.did).toContain("did:key:");
    console.log(`[SHARE-VIS] A: ${identityA.did.slice(0, 24)}…  B: ${identityB.did.slice(0, 24)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4 — Create the shared space on Vault A with real test files
  // ═══════════════════════════════════════════════════════════════════════════

  test("create shared space on Vault A with test files and share", async () => {
    // Create the space via UI so the vault initializes the owner's admin UCAN
    // (raw SQL insertion would skip UCAN generation, causing local_delivery_create_invite
    // to fail with "No admin UCAN found for space").
    const spaceName = `ShareVis-${Date.now()}`;
    spaceId = await createLocalSpaceViaUI(vaultA, spaceName);

    // Register Vault A's device (required for local_delivery_start leader election)
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices
              (id, space_id, device_endpoint_id, device_name, relay_url)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [crypto.randomUUID(), spaceId, nodeIdA, "VaultA", relayUrlA],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    // Start local delivery leader so Vault A can respond to ClaimInvite requests
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
    await wait(1000); // let the QUIC accept loop bind

    // Create test files Vault B will browse after the invite
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: testDir });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/hello.txt`,
      data: Buffer.from("Hello from Vault A!").toString("base64"),
    });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/notes.txt`,
      data: Buffer.from("Some shared notes").toString("base64"),
    });

    // Attach the share
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares (id, space_id, device_endpoint_id, name, local_path)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [crypto.randomUUID(), spaceId, nodeIdA, shareName, testDir],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    console.log(`[SHARE-VIS] Space ${spaceId.slice(0, 8)}… ready on Vault A`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5 — Create a targeted invite token on Vault A for identityB
  //
  // local_delivery_create_invite (with target_did) signs a UCAN using Vault A's
  // admin identity and stores the token in haex_invite_tokens. Vault B then
  // claims this token via local_delivery_claim_invite (QUIC roundtrip to Vault A).
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A creates invite token for Vault B's identity", async () => {
    inviteTokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      {
        spaceId,
        targetDid: identityB.did,
        capability: "space/read",
        maxUses: 1,
        expiresInSeconds: 3600,
        includeHistory: true,
      },
    );
    expect(inviteTokenId).toBeTruthy();
    console.log(`[SHARE-VIS] Invite token: ${inviteTokenId.slice(0, 8)}…`);

    // Verify token was stored in DB
    const tokens = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_invite_tokens WHERE id = ?1`,
      [inviteTokenId],
    );
    expect(tokens.length).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6 — Deliver the invite to Vault B
  //
  // Simulates the QUIC PushInvite delivery by inserting a haex_pending_invites
  // row directly on Vault B. This bypasses the iroh relay delivery (which is
  // tested in quic-invite-flow.spec.ts) and focuses on what happens at accept.
  //
  // The row structure mirrors what local_delivery_push_invite creates on the
  // receiver side (see push_invite::handle_push_invite in Rust).
  // ═══════════════════════════════════════════════════════════════════════════

  test("deliver invite to Vault B (simulated, skips relay delivery)", async () => {
    // Vault B needs Vault A's identity row to call local_delivery_claim_invite
    // (Rust requires it before the QUIC roundtrip to avoid an expensive dial
    // when the invite was already declined).
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_identities (id, did, private_key) VALUES (?1, ?2, NULL)`,
      params: [crypto.randomUUID(), identityA.did],
    });

    // Create the pending invite row
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_pending_invites
              (id, space_id, space_name, space_type, inviter_did, inviter_label,
               token_id, capabilities, status, space_endpoints)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      params: [
        crypto.randomUUID(),
        spaceId,
        `ShareVis-${spaceId.slice(0, 8)}`,
        "local",
        identityA.did,
        "Vault A",
        inviteTokenId,
        JSON.stringify(["space/read"]),
        "pending",
        JSON.stringify([nodeIdA]),
      ],
    });

    const invites = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBe(1);
    console.log(`[SHARE-VIS] Pending invite created on Vault B`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7 — Accept the invite on Vault B
  //
  // Triggers acceptLocalInviteAsync from the Pinia spacesStore. This function
  // (src/stores/spaces/invites.ts) does the full ClaimInvite roundtrip and,
  // with our fix, calls registerDeviceInSpaceAsync for the new space.
  // ═══════════════════════════════════════════════════════════════════════════

  test("accept invite on Vault B via spacesStore", async () => {
    // Read the pending invite ID first
    const invites = await sqlQuery<{
      id: string; space_id: string; space_name: string; space_type: string;
      inviter_did: string; inviter_label: string; token_id: string;
      capabilities: string; space_endpoints: string;
    }>(
      vaultB,
      `SELECT id, space_id, space_name, space_type, inviter_did, inviter_label,
              token_id, capabilities, space_endpoints
       FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending' LIMIT 1`,
      [spaceId],
    );
    expect(invites.length).toBe(1);
    const invite = invites[0];

    // Fire-and-forget via executeScript — the async call to claim the invite
    // (QUIC roundtrip to Vault A) continues in the background. We poll the DB
    // below to wait for the accept to complete.
    await vaultB.executeScript(`
      (async () => {
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const spacesStore = pinia?._s?.get('haexSpacesStore');
        if (!spacesStore?.acceptLocalInviteAsync) {
          throw new Error('[SHARE-VIS] spacesStore or acceptLocalInviteAsync unavailable — Pinia store not mounted');
        }
        try {
          await spacesStore.acceptLocalInviteAsync(${JSON.stringify(invite)});
        } catch (e) {
          console.error('[SHARE-VIS] acceptLocalInviteAsync error:', e?.message || String(e));
        }
      })()
    `);

    // Poll until the invite is marked accepted (the QUIC ClaimInvite roundtrip
    // completes and the space is persisted)
    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ status: string }>(
          vaultB,
          `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
          [spaceId],
        );
        return rows.length > 0 && rows[0].status === "accepted";
      },
      { timeout: 45_000, interval: 1_000, label: "invite accepted on Vault B" },
    );

    console.log(`[SHARE-VIS] Invite accepted on Vault B`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 8 — Key regression assertion: Vault B's device is in haex_space_devices
  //
  // Before the fix, claimPendingLocalInviteAsync never called
  // registerDeviceInSpaceAsync for the newly joined space. This meant Vault A's
  // allowed_peers never included Vault B for that space. Vault B could see the
  // share folder at root (no auth check) but listing files inside the share
  // failed because find_share_and_subpath filtered by allowed_spaces (built
  // from allowed_peers loaded from haex_space_devices).
  //
  // The fix adds the registerDeviceInSpaceAsync call, which inserts the row
  // immediately during accept — no sync roundtrip needed for this assertion.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B's nodeId is in haex_space_devices for the accepted space", async () => {
    const devices = await sqlQuery<{ device_endpoint_id: string }>(
      vaultB,
      `SELECT device_endpoint_id FROM haex_space_devices WHERE space_id = ?1`,
      [spaceId],
    );
    console.log(
      `[SHARE-VIS] haex_space_devices on Vault B (space ${spaceId.slice(0, 8)}…): [${
        devices.map((d) => d.device_endpoint_id.slice(0, 12)).join(", ")
      }]`,
    );

    const ownRegistered = devices.some((d) => d.device_endpoint_id === nodeIdB);
    if (!ownRegistered) {
      throw new Error(
        `Regression: Vault B's nodeId ${nodeIdB.slice(0, 16)}… not in haex_space_devices for space ${spaceId.slice(0, 8)}… — ` +
        `acceptLocalInviteAsync must call registerDeviceInSpaceAsync for the accepted space`,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9 — CRDT sync: Vault A receives Vault B's device registration
  //
  // Vault B's sync loop (started in acceptLocalInviteAsync) pushes the new
  // haex_space_devices row to Vault A. Vault A's sync handler calls
  // peer_storage_reload_shares which rebuilds allowed_peers to include Vault B
  // for this space.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A receives Vault B's device_endpoint_id via CRDT sync", async () => {
    const t0 = Date.now();
    await pollUntil(
      async () => {
        const devices = await sqlQuery<{ device_endpoint_id: string }>(
          vaultA,
          `SELECT device_endpoint_id FROM haex_space_devices WHERE space_id = ?1`,
          [spaceId],
        );
        const found = devices.some((d) => d.device_endpoint_id === nodeIdB);
        if (!found && Date.now() - t0 > 10_000) {
          console.log(
            `[SHARE-VIS] Still waiting for sync — A devices: [${
              devices.map((d) => d.device_endpoint_id.slice(0, 12)).join(", ")
            }]`,
          );
        }
        return found;
      },
      { timeout: 60_000, interval: 2_000, label: "Vault B endpoint synced to Vault A haex_space_devices" },
    );
    console.log(`[SHARE-VIS] Vault B's device synced to Vault A after ${Date.now() - t0}ms ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 10 — Retrieve the UCAN token stored during the invite claim
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B has a UCAN token for the space after accept", async () => {
    const rows = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2 LIMIT 1`,
      [spaceId, identityB.did],
    );
    expect(rows.length).toBeGreaterThan(0);
    ucanTokenForB = rows[0].token as string;
    expect(ucanTokenForB).toBeTruthy();
    console.log(`[SHARE-VIS] UCAN token on Vault B ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 11 — P2P baseline: Vault B can list root shares
  //
  // Root "/" listing skips allowed_peers (find_space_for_path returns None).
  // This worked even before the fix — it's here as a connectivity sanity check.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B can list root shares from Vault A (baseline)", async () => {
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      { nodeId: nodeIdA, relayUrl: relayUrlA, path: "/", ucanToken: ucanTokenForB },
    );
    console.log(
      `[SHARE-VIS] Root listing: ${entries.map((e) => e.name).join(", ")}`,
    );

    const shareEntry = entries.find((e) => e.name === shareName);
    expect(shareEntry).toBeDefined();
    expect(shareEntry!.isDir).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 12 — P2P regression: Vault B can list files INSIDE the share
  //
  // This was the failing case. Vault B called peer_storage_remote_list with
  // path "/SharedDocs" and Vault A's handler hit find_share_and_subpath, which
  // filters shares by allowed_spaces (derived from allowed_peers loaded from
  // haex_space_devices WHERE device_endpoint_id != own_id).
  //
  // Before the fix: Vault B's endpoint was absent from haex_space_devices →
  //   allowed_peers for this space was empty → share not found → error.
  //
  // After the fix: Vault B registered itself during accept → Vault A received
  //   the row via CRDT sync → allowed_peers includes Vault B → listing succeeds.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B can list files inside the share after invite (regression)", async () => {
    // Ensure Vault A has reloaded allowed_peers after receiving the CRDT row
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    const t0 = Date.now();
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      { nodeId: nodeIdA, relayUrl: relayUrlA, path: `/${shareName}`, ucanToken: ucanTokenForB },
    );
    console.log(
      `[SHARE-VIS] Sub-folder listing took ${Date.now() - t0}ms, entries: ${
        entries.map((e) => `${e.name}(${e.size}B)`).join(", ")
      }`,
    );

    expect(entries.length).toBeGreaterThanOrEqual(2); // hello.txt + notes.txt

    const hello = entries.find((e) => e.name === "hello.txt");
    expect(hello).toBeDefined();
    expect(hello!.isDir).toBe(false);
    expect(hello!.size).toBe(19); // "Hello from Vault A!" = 19 bytes

    const notes = entries.find((e) => e.name === "notes.txt");
    expect(notes).toBeDefined();
    expect(notes!.isDir).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 13 — P2P download: confirm content is accessible end-to-end
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B can download a file from inside the share", async () => {
    const saveTo = `/tmp/e2e-share-vis-hello-${Date.now()}.txt`;

    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: `/${shareName}/hello.txt`,
      saveTo,
      ucanToken: ucanTokenForB,
    });

    expect(localPath).toBe(saveTo);

    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file", { path: localPath },
    );
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    expect(decoded).toBe("Hello from Vault A!");

    try {
      await vaultB.invokeTauriCommand("filesystem_remove", { path: saveTo });
    } catch { /* best effort */ }
  });
});
