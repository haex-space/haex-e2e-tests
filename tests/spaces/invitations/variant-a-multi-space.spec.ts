/**
 * Variante A · Schritt 3.2 — Multi-Space-Stress: 3 sequentielle Invites.
 *
 * Hypothese: der User-Bug ("No valid UCAN token for this peer's space") triggert
 * sich naturalistisch, wenn Vault B in MEHRERE Spaces hintereinander invited
 * wird und sich die UCAN-Cache-Einträge / shares.value-State zwischen den
 * Spaces gegenseitig contaminieren. variant-a-race.spec.ts hat bewiesen, dass
 * Class 1 (shares.value-stale) und Class 2 (ucanCache-miss) mechanisch valide
 * Auslöser sind — aber beide nur durch hardcoded Injection. Dieser Test ist
 * der naturalistische Stresser: kein clearen, nur 3 echte invite/accept-Loops
 * + 3 subpath-listings. Wenn EINER der drei subpaths fehlschlägt, haben wir
 * den production-Bug ohne Injection reproduziert.
 *
 * Wenn alle 3 GREEN: starker Hinweis dass der naturalistische Pfad sauber
 * läuft. Dann bleibt nur 3.4 (fresh-state stress + container restart) ODER
 * der User-side manuelle Repro übrig.
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
 * Run the full per-space invite+accept loop body. Mirrors the
 * "Vault A creates local space" + "mints invite" + "accepts" + "wait for
 * share row" sequence from phase5-isolated.spec.ts, condensed into one
 * helper so the multi-space loop stays readable.
 */
async function setupSpaceWithInvite(
  vaultA: VaultAutomation,
  vaultB: VaultAutomation,
  nodeIdA: string,
  identityA: { did: string },
  identityB: { did: string },
  cfg: { spaceName: string; shareName: string; shareLocalPath: string },
): Promise<SpaceContext> {
  // 1. Space + leader on A
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
  } catch (e) {
    console.log(`[MULTI] local_delivery_start errored (likely already running): ${(e as Error).message?.slice(0, 80)}`);
  }

  // 2. Share folder + marker + row
  await vaultA.invokeTauriCommand("filesystem_mkdir", { path: cfg.shareLocalPath });
  await vaultA.invokeTauriCommand("filesystem_write_file", {
    path: `${cfg.shareLocalPath}/multi-marker.txt`,
    data: Buffer.from(`multi-space-marker-${cfg.spaceName}`).toString("base64"),
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

  // 3. Mint invite on A + inject pending on B
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

  // 4. Force spaces.vue to re-mount so its onMounted-driven loadInvitesAsync
  //    picks up the SQL-injected pending row. useSpaceInvites is a
  //    composable (not a Pinia store), so each spaces.vue instance owns its
  //    own pendingInvites ref — we can't refresh it from outside without a
  //    remount. The first iteration's nav opens spaces fresh (mount fires
  //    loadInvitesAsync); for subsequent iterations we navigate to
  //    "general" then back to "spaces" to force a fresh mount.
  await openSettingsCategory(vaultB, "general");
  await openSettingsCategory(vaultB, "spaces");
  await pollUntil(
    () => vaultB.executeScript<boolean>(`
      const card = document.querySelector('[data-testid="space-card-' + ${JSON.stringify(spaceId)} + '"]');
      if (!card) return false;
      return card.getAttribute('data-space-status') === 'pending';
    `),
    { timeout: 15_000, interval: 500, label: `pending invite card visible on Vault B for ${cfg.spaceName}` },
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

  // 5. Wait for share row to sync to B
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

  console.log(`[MULTI] Space ready: name="${cfg.spaceName}" spaceId=${spaceId.slice(0, 8)}… shareId=${shareId.slice(0, 8)}… tokenId=${tokenId.slice(0, 8)}…`);
  return { ...cfg, spaceId, shareId, tokenId };
}

test.describe("Variante A · 3.2 — Multi-Space-Stress (3 sequential invites)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  const state: QuicTestState = {};
  const runStamp = Date.now();
  const N_SPACES = 3;
  const cfgs = Array.from({ length: N_SPACES }, (_, i) => ({
    spaceName: `MultiSpace ${runStamp}-${i + 1}`,
    shareName: `MultiShare ${runStamp}-${i + 1}`,
    shareLocalPath: `/tmp/haex-e2e-multi-${runStamp}-${i + 1}`,
  }));
  const setupResults: SpaceContext[] = [];

  registerSetupPhase(state);

  test("re-arm console interceptor on both vaults", async () => {
    for (const [label, vault] of [["A", state.vaultA!], ["B", state.vaultB!]] as const) {
      const res = await vault.executeScript<{ ok: boolean; deviceId?: string; error?: string }>(`
        try {
          const app = document.getElementById('__nuxt')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          const deviceStore = pinia?._s?.get('vaultDeviceStore');
          const deviceId = deviceStore?.deviceId;
          if (!deviceId) return { ok: false, error: 'deviceStore.deviceId missing' };
          const setter = app?.config?.globalProperties?.$setConsoleLoggerDeviceId;
          if (!setter) return { ok: false, deviceId, error: '$setConsoleLoggerDeviceId not provided' };
          setter(deviceId);
          console.warn('[UCAN-DIAG-MULTI-REARM-PROBE] after re-arm');
          return { ok: true, deviceId };
        } catch (e) {
          return { ok: false, error: e?.message ?? String(e) };
        }
      `);
      console.log(`[MULTI] Vault ${label} console interceptor re-arm: ok=${res.ok} deviceId=${res.deviceId?.slice(0, 12)} error=${res.error ?? '-'}`);
    }
  });

  // ─── Setup N spaces sequentially. One test() per space so test-output
  //     shows progress and a failure pinpoints which iteration broke.
  for (let i = 0; i < N_SPACES; i++) {
    test(`Setup space ${i + 1}/${N_SPACES} — invite + accept + share sync`, async () => {
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

  // ─── Subpath assertions: walk into each space's share and verify the
  //     resolver picks the correct spaceId. THIS is where the production
  //     bug would surface — if shares.value or ucanCache state got
  //     contaminated between invites, one of these subpath calls will throw
  //     "No valid UCAN token" naturalistisch.
  test(`All ${N_SPACES} subpath listings resolve to correct spaceId`, async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    expect(setupResults.length).toBe(N_SPACES);

    const results: Array<{
      ix: number;
      shareName: string;
      expectedSpaceId: string;
      ok: boolean;
      resolvedSpaceId: string | null;
      message: string;
      entryNames: string[];
    }> = [];

    for (let i = 0; i < setupResults.length; i++) {
      const ctx = setupResults[i];
      const result = await vaultB.executeScript<{
        ok: boolean;
        message: string;
        resolvedSpaceId: string | null;
        entryNames: string[];
      }>(`
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const peerStore = pinia?._s?.get('peerStorageStore');
        if (!peerStore) return { ok: false, message: 'peerStorageStore not found', resolvedSpaceId: null, entryNames: [] };
        await peerStore.loadSharesAsync('variant-a-multi-${i}');
        const matched = peerStore.shares.find(s =>
          s.endpointId === ${JSON.stringify(nodeIdA)}
          && s.name === ${JSON.stringify(ctx.shareName)}
        );
        try {
          const entries = await peerStore.remoteListAsync(
            ${JSON.stringify(nodeIdA)},
            '/' + ${JSON.stringify(ctx.shareName)},
          );
          return {
            ok: true,
            message: '',
            resolvedSpaceId: matched?.spaceId ?? null,
            entryNames: entries.map(e => e.name),
          };
        } catch (e) {
          return {
            ok: false,
            message: e?.message ?? String(e),
            resolvedSpaceId: matched?.spaceId ?? null,
            entryNames: [],
          };
        }
      `);
      results.push({
        ix: i + 1,
        shareName: ctx.shareName,
        expectedSpaceId: ctx.spaceId,
        ...result,
      });
      console.log(`[MULTI] Subpath ${i + 1}/${N_SPACES} share="${ctx.shareName}" ok=${result.ok} resolvedSpaceId=${result.resolvedSpaceId?.slice(0, 8)} expected=${ctx.spaceId.slice(0, 8)} entries=[${result.entryNames.slice(0, 5).join(",")}] message="${result.message.slice(0, 200)}"`);
    }

    // Aggregate the per-space outcomes for a single readable failure block.
    const failures = results.filter(r => !r.ok || r.resolvedSpaceId !== r.expectedSpaceId);
    if (failures.length > 0) {
      console.log(`[MULTI] FAILURE SUMMARY (${failures.length}/${results.length}):`);
      for (const f of failures) {
        console.log(`  · #${f.ix} share="${f.shareName}" ok=${f.ok} resolvedSpaceId=${f.resolvedSpaceId ?? "null"} expected=${f.expectedSpaceId} message="${f.message.slice(0, 300)}"`);
      }
    }

    for (const r of results) {
      expect(r.ok, `space ${r.ix} subpath threw: ${r.message}`).toBe(true);
      expect(r.entryNames, `space ${r.ix} subpath returned wrong entries`).toContain("multi-marker.txt");
      expect(r.resolvedSpaceId, `space ${r.ix} resolved to wrong spaceId`).toBe(r.expectedSpaceId);
    }
  });

  test.afterAll(async () => {
    for (const [label, vault] of [["A", state.vaultA], ["B", state.vaultB]] as const) {
      if (!vault) continue;
      try {
        const ucanLogs = await sqlQuery<{ timestamp: string; level: string; message: string }>(
          vault,
          `SELECT timestamp, level, message FROM haex_logs
           WHERE message LIKE '%UCAN-DIAG%'
             AND timestamp >= datetime('now', '-10 minutes')
           ORDER BY timestamp ASC LIMIT 1000`,
        );
        console.log(`[MULTI] ── Vault ${label} UCAN-DIAG logs (last 10 min, ${ucanLogs.length}) ──`);
        for (const l of ucanLogs) {
          console.log(`  [${l.timestamp}] [${l.level}] ${l.message}`);
        }
      } catch (err) {
        console.log(`[MULTI] Vault ${label} log dump failed: ${(err as Error)?.message}`);
      }
    }
  });
});
