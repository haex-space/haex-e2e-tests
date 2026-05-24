/**
 * Variante A — automatisierter Race-Injection-Repro für den UCAN-Subpath-Bug.
 *
 * Hypothese: Der User-Bug ("No valid UCAN token for this peer's space" beim
 * Navigieren in einen Share nach QUIC-Invite-Accept) wird durch eine der
 * folgenden Race-Conditions im Resolver ausgelöst:
 *
 *   Race A — shares.value-Stale: `resolveRequestContext` sieht keine
 *            matchingShare-Zeile, weil der Sync-Push der Share-Row im
 *            File-Browser-Click-Pfad noch nicht durchschlug. Hardcoded
 *            Reproduktion: `peerStore.shares.length = 0` direkt vor dem
 *            `remoteListAsync('/share')`-Call.
 *
 *   Race B — ucanCache-Miss: matchingShare gefunden, aber der ucanCache
 *            für die spaceId ist leer (z.B. weil loadUcansFromDbAsync nicht
 *            erfolgreich war). Hardcoded Reproduktion:
 *            `window.__ucanCacheDebug.clear(spaceId)` (Hook in
 *            haex-vault auf debug/ucan-subpath-logging).
 *
 * phase5-isolated hat 15/15 GREEN gezeigt: im naturalistischen Happy-Path
 * triggert keiner dieser Pfade. Dieser Test BEWEIST, dass die Fehlerklassen
 * existieren, wenn die jeweilige Vorbedingung erfüllt ist — das ist die
 * Grundlage für einen späteren Fix-Plan.
 *
 * Setup wird 1:1 von phase5-isolated übernommen (real Phase 1 Setup + Phase 3+4
 * via Tauri/SQL-direct, kein flaky PushInvite). Race A + B werden DANACH
 * gegen den fresh-State injiziert.
 */

import * as crypto from "crypto";
import { expect, test } from "../../fixtures";
import { pollUntil, sqlQuery } from "./quic-helpers/utils";
import { acceptInviteViaUI, createLocalSpaceViaUI } from "./quic-helpers/ui-spaces";
import { openSettingsCategory } from "./quic-helpers/ui-vault";
import { type QuicTestState } from "./quic-phases/state";
import { registerSetupPhase } from "./quic-phases/01-setup";

test.describe("Variante A — Race-Injection for UCAN subpath bug", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  const state: QuicTestState = {};
  let mintedTokenId = "";

  // Run-stamped names so this test never collides with stale rows from
  // earlier runs in the same container (same rationale as phase5-isolated).
  const runStamp = Date.now();
  const isolatedSpaceName = `Variant-A Test ${runStamp}`;
  const isolatedShareName = `Variant-A Share ${runStamp}`;
  const isolatedShareLocalPath = `/tmp/haex-e2e-variant-a-${runStamp}`;

  // ─── Phase 1 (real) ────────────────────────────────────────────────────
  registerSetupPhase(state);

  // ─── Re-arm console interceptor (see phase5-isolated for rationale) ────
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
          console.warn('[UCAN-DIAG-VARIANT-A-REARM-PROBE] after re-arm');
          return { ok: true, deviceId };
        } catch (e) {
          return { ok: false, error: e?.message ?? String(e) };
        }
      `);
      console.log(`[VARIANT-A] Vault ${label} console interceptor re-arm: ok=${res.ok} deviceId=${res.deviceId?.slice(0, 12)} error=${res.error ?? '-'}`);
    }
  });

  // ─── Verify the test-only window hook is present (debug/ucan-subpath-logging) ──
  test("Vault B exposes __ucanCacheDebug window hook", async () => {
    const probe = await state.vaultB!.executeScript<{ hasHook: boolean; size?: number; keysSample?: string[] }>(`
      const hook = window.__ucanCacheDebug;
      if (!hook) return { hasHook: false };
      const keys = hook.keys();
      return { hasHook: true, size: hook.size(), keysSample: keys.slice(0, 5).map(k => k.slice(0, 8)) };
    `);
    console.log(`[VARIANT-A] __ucanCacheDebug hook on B: present=${probe.hasHook} cacheSize=${probe.size} sampleKeys=${JSON.stringify(probe.keysSample ?? [])}`);
    expect(probe.hasHook).toBe(true);
  });

  // ─── Fast-track Phase 3+4 (same shape as phase5-isolated) ──────────────

  test("Vault A creates local space + attaches share + starts leader", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;

    state.spaceId = await createLocalSpaceViaUI(vaultA, isolatedSpaceName);
    expect(state.spaceId).toBeTruthy();

    const ownDeviceA = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      [nodeIdA],
    );
    expect(ownDeviceA.length).toBe(1);

    const existingDevices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [state.spaceId],
    );
    if (!existingDevices.some((d) => d.endpoint_id === nodeIdA)) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices
              (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        params: [
          crypto.randomUUID(),
          state.spaceId,
          ownDeviceA[0].id,
          nodeIdA,
          "Vault A Desktop",
          "desktop",
          identityA.did,
        ],
      });
    }

    try {
      await vaultA.invokeTauriCommand("local_delivery_start", { spaceId: state.spaceId });
    } catch (e) {
      console.log(`[VARIANT-A] local_delivery_start errored (likely already running): ${(e as Error).message?.slice(0, 80)}`);
    }

    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: isolatedShareLocalPath });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${isolatedShareLocalPath}/variant-a-marker.txt`,
      data: Buffer.from("variant-a-race-marker").toString("base64"),
    });

    state.shareId = crypto.randomUUID();
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares
            (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [
        state.shareId,
        state.spaceId,
        ownDeviceA[0].id,
        nodeIdA,
        isolatedShareName,
        isolatedShareLocalPath,
        identityA.did,
      ],
    });

    const reloadCount = await vaultA.invokeTauriCommand<number>("peer_storage_reload_shares", {});
    console.log(`[VARIANT-A] Vault A ready: spaceId=${state.spaceId.slice(0, 8)}… shareId=${state.shareId.slice(0, 8)}… reload=${reloadCount}`);
  });

  test("Vault A mints invite token; Vault B SQL-injects pending invite", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;
    const identityB = state.identityB!;
    const spaceId = state.spaceId!;

    const tokenId = await vaultA.invokeTauriCommand<string>("local_delivery_create_invite", {
      spaceId,
      targetDid: identityB.did,
      capability: "space/write",
      maxUses: 1,
      expiresInSeconds: 3600,
      includeHistory: true,
    });
    expect(tokenId).toBeTruthy();
    mintedTokenId = tokenId;

    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_pending_invites
            (id, space_id, space_name, space_type, inviter_did, capabilities,
             include_history, token_id, space_endpoints, status, created_at)
            VALUES (?1, ?2, ?3, 'local', ?4, ?5, 1, ?6, ?7, 'pending', datetime('now'))`,
      params: [
        crypto.randomUUID(),
        spaceId,
        isolatedSpaceName,
        identityA.did,
        JSON.stringify(["space/read", "space/write"]),
        tokenId,
        JSON.stringify([nodeIdA]),
      ],
    });

    const pending = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND token_id = ?2`,
      [spaceId, tokenId],
    );
    expect(pending.length).toBe(1);
    console.log(`[VARIANT-A] Invite minted + injected: tokenId=${tokenId.slice(0, 8)}…`);
  });

  test("Vault B accepts invite by UI click", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;
    const tokenId = mintedTokenId;

    await openSettingsCategory(vaultB, "spaces");
    await pollUntil(
      () => vaultB.executeScript<boolean>(`
        const card = document.querySelector('[data-testid="space-card-' + ${JSON.stringify(spaceId)} + '"]');
        if (!card) return false;
        return card.getAttribute('data-space-status') === 'pending';
      `),
      { timeout: 15_000, interval: 500, label: "pending invite card visible on Vault B" },
    );

    await acceptInviteViaUI(vaultB, isolatedSpaceName, spaceId);

    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ status: string }>(
          vaultB,
          `SELECT status FROM haex_pending_invites WHERE space_id = ?1 AND token_id = ?2`,
          [spaceId, tokenId],
        );
        return rows[0]?.status === "accepted";
      },
      { timeout: 45_000, interval: 500, label: "pending invite flipped to accepted on B" },
    );

    const ucanRows = await sqlQuery<{ issuer_did: string; audience_did: string }>(
      vaultB,
      `SELECT issuer_did, audience_did FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    expect(ucanRows.length).toBeGreaterThanOrEqual(1);
    console.log(`[VARIANT-A] UCAN row landed on B ✓`);
  });

  test("Wait for share row to land on B via CRDT", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const spaceId = state.spaceId!;
    const shareId = state.shareId!;

    await pollUntil(
      async () => {
        await vaultB
          .invokeTauriCommand("local_delivery_force_sync", { spaceId })
          .catch(() => { /* loop may not exist yet */ });
        const rows = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
          vaultB,
          `SELECT id, name, endpoint_id FROM haex_peer_shares
           WHERE space_id = ?1 AND id = ?2`,
          [spaceId, shareId],
        );
        return rows.length === 1
          && rows[0].name === isolatedShareName
          && rows[0].endpoint_id === nodeIdA;
      },
      { timeout: 90_000, interval: 500, label: "share row synced to B (variant-a)" },
    );
    console.log("[VARIANT-A] Share row present on B after CRDT sync ✓");
  });

  // ─── Sanity baseline: in the happy path the subpath listing succeeds. ──
  //     This is the same assertion phase5-isolated runs — establishing the
  //     baseline before we inject races, so a race-injection failure can
  //     be cleanly attributed to the race (not to broken Phase 4 state).
  test("Baseline: subpath listing succeeds before race injection", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const result = await vaultB.executeScript<{ ok: boolean; data: string; resolvedSpaceId?: string | null }>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const peerStore = pinia?._s?.get('peerStorageStore');
      if (!peerStore) return { ok: false, data: 'peerStorageStore not found' };
      try {
        await peerStore.loadSharesAsync('variant-a-baseline');
        const matched = peerStore.shares.find(s =>
          s.endpointId === ${JSON.stringify(nodeIdA)}
          && s.name === ${JSON.stringify(isolatedShareName)}
        );
        const entries = await peerStore.remoteListAsync(
          ${JSON.stringify(nodeIdA)},
          '/' + ${JSON.stringify(isolatedShareName)},
        );
        return {
          ok: true,
          data: entries.map(e => e.name).join(','),
          resolvedSpaceId: matched?.spaceId ?? null,
        };
      } catch (e) {
        return { ok: false, data: e?.message ?? String(e), resolvedSpaceId: null };
      }
    `);
    console.log(`[VARIANT-A] Baseline subpath — ok=${result.ok} resolvedSpaceId=${result.resolvedSpaceId} data="${result.data.slice(0, 200)}"`);
    expect(result.ok).toBe(true);
    expect(result.data).toContain("variant-a-marker.txt");
    expect(result.resolvedSpaceId).toBe(state.spaceId);
  });

  // ─── Race A: clear shares.value → resolver returns matchingShare-undefined ──
  test("Race A — shares.value emptied → resolver throws 'No valid UCAN token'", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const result = await vaultB.executeScript<{
      sharesBefore: number;
      sharesAfter: number;
      sharesRestored: number;
      thrown: boolean;
      errorMessage: string;
      matchingFreshSharePresent: boolean;
    }>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const peerStore = pinia?._s?.get('peerStorageStore');
      if (!peerStore) {
        return { sharesBefore: -1, sharesAfter: -1, sharesRestored: -1, thrown: true, errorMessage: 'peerStorageStore not found', matchingFreshSharePresent: false };
      }

      // Make sure the fresh share row IS in shares.value before we wipe it.
      await peerStore.loadSharesAsync('variant-a-race-a-prep');
      const sharesBefore = peerStore.shares.length;
      const matchingFreshSharePresent = peerStore.shares.some(s =>
        s.endpointId === ${JSON.stringify(nodeIdA)}
        && s.name === ${JSON.stringify(isolatedShareName)}
      );

      // Snapshot so we can restore for subsequent tests in the suite.
      const sharesBackup = peerStore.shares.map(s => ({ ...s }));

      // Race-Injection: wipe shares.value. The ucanCache stays warm; only
      // the shares.value lookup in resolveRequestContext gets stale-view.
      peerStore.shares.length = 0;
      const sharesAfter = peerStore.shares.length;

      let thrown = false;
      let errorMessage = '';
      try {
        await peerStore.remoteListAsync(
          ${JSON.stringify(nodeIdA)},
          '/' + ${JSON.stringify(isolatedShareName)},
        );
      } catch (e) {
        thrown = true;
        errorMessage = e?.message ?? String(e);
      }

      // Restore so the next test doesn't inherit empty shares.value.
      peerStore.shares.push(...sharesBackup);
      const sharesRestored = peerStore.shares.length;

      return { sharesBefore, sharesAfter, sharesRestored, thrown, errorMessage, matchingFreshSharePresent };
    `);
    console.log(`[VARIANT-A] Race A — sharesBefore=${result.sharesBefore} freshSharePresent=${result.matchingFreshSharePresent} sharesAfterClear=${result.sharesAfter} thrown=${result.thrown} restored=${result.sharesRestored} message="${result.errorMessage.slice(0, 200)}"`);

    expect(result.matchingFreshSharePresent).toBe(true);
    expect(result.thrown).toBe(true);
    expect(result.errorMessage).toContain("No valid UCAN token");
  });

  // ─── Race B: clear ucanCache for spaceId → resolver returns ucan-cache-miss ──
  test("Race B — ucanCache emptied for spaceId → resolver throws 'No valid UCAN token'", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const spaceId = state.spaceId!;
    const result = await vaultB.executeScript<{
      cacheBefore: number;
      cacheAfter: number;
      keysContainSpaceBefore: boolean;
      keysContainSpaceAfter: boolean;
      thrown: boolean;
      errorMessage: string;
    }>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const peerStore = pinia?._s?.get('peerStorageStore');
      const hook = window.__ucanCacheDebug;
      if (!peerStore || !hook) {
        return { cacheBefore: -1, cacheAfter: -1, keysContainSpaceBefore: false, keysContainSpaceAfter: false, thrown: true, errorMessage: 'precondition missing: peerStore=' + !!peerStore + ' hook=' + !!hook };
      }

      // Make sure shares.value is freshly populated — we want Race B to fail
      // ONLY on the ucanCache miss, not on a stale shares.value.
      await peerStore.loadSharesAsync('variant-a-race-b-prep');
      const cacheBefore = hook.size();
      const keysContainSpaceBefore = hook.keys().includes(${JSON.stringify(spaceId)});

      // Race-Injection: drop the UCAN entry for this specific space.
      hook.clear(${JSON.stringify(spaceId)});
      const cacheAfter = hook.size();
      const keysContainSpaceAfter = hook.keys().includes(${JSON.stringify(spaceId)});

      let thrown = false;
      let errorMessage = '';
      try {
        await peerStore.remoteListAsync(
          ${JSON.stringify(nodeIdA)},
          '/' + ${JSON.stringify(isolatedShareName)},
        );
      } catch (e) {
        thrown = true;
        errorMessage = e?.message ?? String(e);
      }

      return { cacheBefore, cacheAfter, keysContainSpaceBefore, keysContainSpaceAfter, thrown, errorMessage };
    `);
    console.log(`[VARIANT-A] Race B — cacheBefore=${result.cacheBefore} containsSpaceBefore=${result.keysContainSpaceBefore} cacheAfter=${result.cacheAfter} containsSpaceAfter=${result.keysContainSpaceAfter} thrown=${result.thrown} message="${result.errorMessage.slice(0, 200)}"`);

    expect(result.keysContainSpaceBefore).toBe(true);
    expect(result.keysContainSpaceAfter).toBe(false);
    expect(result.thrown).toBe(true);
    expect(result.errorMessage).toContain("No valid UCAN token");
  });

  // ─── Diagnostic dump: pull UCAN-DIAG logs so the resolver's outcome
  //     classes are visible in the test output. Runs even on failure.
  test.afterAll(async () => {
    for (const [label, vault] of [["A", state.vaultA], ["B", state.vaultB]] as const) {
      if (!vault) continue;
      try {
        const ucanLogs = await sqlQuery<{ timestamp: string; level: string; message: string }>(
          vault,
          `SELECT timestamp, level, message FROM haex_logs
           WHERE message LIKE '%UCAN-DIAG%'
             AND timestamp >= datetime('now', '-5 minutes')
           ORDER BY timestamp ASC LIMIT 500`,
        );
        console.log(`[VARIANT-A] ── Vault ${label} UCAN-DIAG logs (last 5 min, ${ucanLogs.length}) ──`);
        for (const l of ucanLogs) {
          console.log(`  [${l.timestamp}] [${l.level}] ${l.message}`);
        }
      } catch (err) {
        console.log(`[VARIANT-A] Vault ${label} log dump failed: ${(err as Error)?.message}`);
      }
    }
  });
});
