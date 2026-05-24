/**
 * Regression test for `peerStore.remoteListAllSharesAsync`.
 *
 * Backstory: `peerStore.remoteListAsync(peerId, '/')` always returns only the
 * shares of ONE space — the one whose UCAN happened to be picked by
 * `resolveRequestContext` (FIRST device-row match in `haex_space_devices`).
 * When Vault B shares MULTIPLE spaces with Vault A, the file-browser-root
 * view consequently shows only one space's shares.
 *
 * Fix: `peerStore.remoteListAllSharesAsync(remoteNodeId)` fans out one
 * parallel `peer_storage_remote_list` per space the peer is registered in,
 * each scoped to that space's UCAN, and merges the results.
 *
 * This spec sets up 2 spaces with unique share names between A and B, then
 * calls `remoteListAllSharesAsync` from B and asserts that BOTH share names
 * appear in the merged result.
 */

import * as crypto from "crypto";
import { expect, type VaultAutomation, test } from "../../fixtures";
import { pollUntil, sqlQuery } from "./quic-helpers/utils";
import { acceptInviteViaUI, createLocalSpaceViaUI } from "./quic-helpers/ui-spaces";
import { openSettingsCategory } from "./quic-helpers/ui-vault";
import { type QuicTestState } from "./quic-phases/state";
import { registerSetupPhase } from "./quic-phases/01-setup";

interface SpaceContext {
  spaceName: string;
  shareName: string;
  shareLocalPath: string;
  spaceId: string;
  shareId: string;
  tokenId: string;
}

/**
 * Per-space invite+accept loop body (Vault A creates space + leader + share,
 * mints invite; Vault B SQL-injects the pending invite + accepts via UI;
 * waits for the share row to CRDT-sync to B).
 */
async function setupSpaceWithInvite(
  vaultA: VaultAutomation,
  vaultB: VaultAutomation,
  nodeIdA: string,
  identityA: { did: string },
  identityB: { did: string },
  cfg: { spaceName: string; shareName: string; shareLocalPath: string },
): Promise<SpaceContext> {
  const spaceId = await createLocalSpaceViaUI(vaultA, cfg.spaceName);
  expect(spaceId).toBeTruthy();

  const ownDeviceA = await sqlQuery<{ id: string }>(
    vaultA,
    "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
    [nodeIdA],
  );
  expect(ownDeviceA.length).toBe(1);

  const existingDevices = await sqlQuery<{ endpoint_id: string }>(
    vaultA,
    "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
    [spaceId],
  );
  if (!existingDevices.some((d) => d.endpoint_id === nodeIdA)) {
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices
            (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [
        crypto.randomUUID(),
        spaceId,
        ownDeviceA[0].id,
        nodeIdA,
        "Vault A Desktop",
        "desktop",
        identityA.did,
      ],
    });
  }

  try {
    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
  } catch {
    // idempotent — already-running is fine
  }

  await vaultA.invokeTauriCommand("filesystem_mkdir", { path: cfg.shareLocalPath });
  await vaultA.invokeTauriCommand("filesystem_write_file", {
    path: `${cfg.shareLocalPath}/marker.txt`,
    data: Buffer.from(`marker-${cfg.spaceName}`).toString("base64"),
  });

  const shareId = crypto.randomUUID();
  await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
    sql: `INSERT INTO haex_peer_shares
          (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    params: [
      shareId,
      spaceId,
      ownDeviceA[0].id,
      nodeIdA,
      cfg.shareName,
      cfg.shareLocalPath,
      identityA.did,
    ],
  });

  await vaultA.invokeTauriCommand<number>("peer_storage_reload_shares", {});

  const tokenId = await vaultA.invokeTauriCommand<string>("local_delivery_create_invite", {
    spaceId,
    targetDid: identityB.did,
    capability: "space/write",
    maxUses: 1,
    expiresInSeconds: 3600,
    includeHistory: true,
  });
  expect(tokenId).toBeTruthy();

  await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
    sql: `INSERT INTO haex_pending_invites
          (id, space_id, space_name, space_type, inviter_did, capabilities,
           include_history, token_id, space_endpoints, status, created_at)
          VALUES (?1, ?2, ?3, 'local', ?4, ?5, 1, ?6, ?7, 'pending', datetime('now'))`,
    params: [
      crypto.randomUUID(),
      spaceId,
      cfg.spaceName,
      identityA.did,
      JSON.stringify(["space/read", "space/write"]),
      tokenId,
      JSON.stringify([nodeIdA]),
    ],
  });

  // Trigger spaces.vue to re-mount so its onMounted-driven loadInvitesAsync
  // picks up the SQL-injected pending row. useSpaceInvites is a composable
  // (not a Pinia store), so each spaces.vue instance owns its own
  // pendingInvites ref — we can't refresh it from outside without a remount.
  // The first SQL inject works because spaces.vue mounts for the first time
  // on navigation; for subsequent injects in the same test run we navigate
  // away to "general" and back to "spaces" to force a fresh mount.
  await openSettingsCategory(vaultB, "general");
  await openSettingsCategory(vaultB, "spaces");
  await pollUntil(
    () => vaultB.executeScript<boolean>(`
      const card = document.querySelector('[data-testid="space-card-' + ${JSON.stringify(spaceId)} + '"]');
      if (!card) return false;
      return card.getAttribute('data-space-status') === 'pending';
    `),
    { timeout: 15_000, interval: 500, label: `pending invite card visible for ${cfg.spaceName}` },
  );

  await acceptInviteViaUI(vaultB, cfg.spaceName, spaceId);

  await pollUntil(
    async () => {
      const rows = await sqlQuery<{ status: string }>(
        vaultB,
        `SELECT status FROM haex_pending_invites WHERE space_id = ?1 AND token_id = ?2`,
        [spaceId, tokenId],
      );
      return rows[0]?.status === "accepted";
    },
    { timeout: 45_000, interval: 500, label: `pending invite flipped to accepted for ${cfg.spaceName}` },
  );

  await pollUntil(
    async () => {
      await vaultB
        .invokeTauriCommand("local_delivery_force_sync", { spaceId })
        .catch(() => { /* loop may not exist yet */ });
      const rows = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
        vaultB,
        `SELECT id, name, endpoint_id FROM haex_peer_shares WHERE space_id = ?1 AND id = ?2`,
        [spaceId, shareId],
      );
      return rows.length === 1 && rows[0].name === cfg.shareName && rows[0].endpoint_id === nodeIdA;
    },
    { timeout: 90_000, interval: 500, label: `share row synced to B for ${cfg.spaceName}` },
  );

  console.log(`[ROOT-LIST] Space ready: name="${cfg.spaceName}" spaceId=${spaceId.slice(0, 8)}… shareId=${shareId.slice(0, 8)}…`);
  return { ...cfg, spaceId, shareId, tokenId };
}

test.describe("peerStore.remoteListAllSharesAsync — root listing merges shares from all shared spaces", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  const state: QuicTestState = {};
  const runStamp = Date.now();
  const cfgs = [1, 2].map(i => ({
    spaceName: `Root-Multi ${runStamp}-${i}`,
    shareName: `Root-Multi-Share ${runStamp}-${i}`,
    shareLocalPath: `/tmp/haex-e2e-root-multi-${runStamp}-${i}`,
  }));
  const setupResults: SpaceContext[] = [];

  registerSetupPhase(state);

  // Two sequential invites — each ends with the share row CRDT-synced to B.
  for (let i = 0; i < cfgs.length; i++) {
    test(`Setup space ${i + 1}/${cfgs.length}`, async () => {
      const ctx = await setupSpaceWithInvite(
        state.vaultA!,
        state.vaultB!,
        state.nodeIdA!,
        state.identityA!,
        state.identityB!,
        cfgs[i],
      );
      setupResults.push(ctx);
    });
  }

  test("remoteListAllSharesAsync returns shares from BOTH spaces", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    expect(setupResults.length).toBe(cfgs.length);

    const result = await vaultB.executeScript<{
      ok: boolean;
      message: string;
      entryNames: string[];
      spaceCount: number;
      hasMethod: boolean;
    }>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const peerStore = pinia?._s?.get('peerStorageStore');
      if (!peerStore) return { ok: false, message: 'peerStorageStore not found', entryNames: [], spaceCount: 0, hasMethod: false };
      if (typeof peerStore.remoteListAllSharesAsync !== 'function') {
        return { ok: false, message: 'remoteListAllSharesAsync not exported', entryNames: [], spaceCount: 0, hasMethod: false };
      }
      await peerStore.loadSharesAsync();
      await peerStore.loadSpaceDevicesAsync();
      // Count how many distinct spaces B sees this peer in
      const peerSpaces = new Set(
        peerStore.spaceDevices
          .filter(d => d.endpointId === ${JSON.stringify(nodeIdA)})
          .map(d => d.spaceId)
      );
      try {
        const entries = await peerStore.remoteListAllSharesAsync(${JSON.stringify(nodeIdA)});
        return {
          ok: true,
          message: '',
          entryNames: entries.map(e => e.name),
          spaceCount: peerSpaces.size,
          hasMethod: true,
        };
      } catch (e) {
        return {
          ok: false,
          message: e?.message ?? String(e),
          entryNames: [],
          spaceCount: peerSpaces.size,
          hasMethod: true,
        };
      }
    `);
    console.log(`[ROOT-LIST] Result — ok=${result.ok} hasMethod=${result.hasMethod} spaceCount=${result.spaceCount} entries=[${result.entryNames.slice(0, 20).join(",")}] message="${result.message.slice(0, 200)}"`);

    expect(result.hasMethod, "remoteListAllSharesAsync must be exported on peerStore").toBe(true);
    expect(result.ok, `remoteListAllSharesAsync threw: ${result.message}`).toBe(true);
    expect(result.spaceCount).toBeGreaterThanOrEqual(2);
    for (const cfg of cfgs) {
      expect(result.entryNames, `expected ${cfg.shareName} in merged listing`).toContain(cfg.shareName);
    }
  });
});
