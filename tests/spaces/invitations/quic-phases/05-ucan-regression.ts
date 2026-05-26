import { expect, test } from "../../../fixtures";
import { pollUntil, sqlQuery } from "../quic-helpers/utils";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 5 — Regression guard: navigating INTO a share (subpath listing).
 *
 * The "share visible in detail view" assertion in phase 4 only proves that
 * the share ROW reached Vault B via CRDT. It does NOT exercise the
 * per-request UCAN resolver inside peer-storage. The resolver looks up
 * `shares.value` by (endpointId, shareName) and the cached UCAN by spaceId —
 * *both* are required for any non-root path. If either is missing, the
 * resolver returns `{ ucanToken: null }` and `remoteListAsync` throws
 * "No valid UCAN token for this peer's space".
 *
 * Real-world regression observed after the device-identity refactor:
 * root listing on the invitee side worked (no share lookup) but the moment
 * the user clicked into a share, the resolver threw. This phase calls
 * `peerStore.remoteListAsync` directly so it does not depend on any
 * specific file-browser UI flow.
 */
export function registerUcanRegressionPhase(state: QuicTestState): void {
  const { shareName, shareLocalPath } = QUIC_CONSTANTS;

  test("Vault B can navigate INTO the share without 'No valid UCAN token' error", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const nodeIdB = state.nodeIdB!;
    const spaceId = state.spaceId!;
    const shareId = state.shareId!;

    // 1. Create the share folder + a marker file on Vault A's filesystem so
    //    the leader can actually serve a listing. The folder didn't have to
    //    exist for the share-ROW propagation test — but it MUST exist for a
    //    real subpath read to succeed (otherwise the leader returns
    //    "Not a directory" and we can't distinguish from the UCAN error).
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: shareLocalPath });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${shareLocalPath}/ucan-regression-marker.txt`,
      data: Buffer.from("ucan-subpath-marker").toString("base64"),
    });

    // 2. Belt-and-braces: re-confirm the share row is on Vault B (mirrors the
    //    earlier CRDT-propagation test; cheap enough to repeat so a failure
    //    here points unambiguously at "row not synced" instead of leaving the
    //    next assertion holding the bag).
    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_peer_shares WHERE space_id = ?1 AND id = ?2`,
          [spaceId, shareId],
        );
        return rows.length === 1;
      },
      { timeout: 30_000, interval: 500, label: "share row present on Vault B (subpath prereq)" },
    );

    // 3. Verify the invitee's UCAN token row landed in haex_ucan_tokens.
    //    Without this row, `ucanCache` (in-memory) can never be populated
    //    and EVERY remoteListAsync would fail — including root listing.
    //    Failing here means the bug is on the Rust persist_claimed_ucan path,
    //    not the TS resolver.
    const ucanRows = await sqlQuery<{ token: string; capability: string }>(
      vaultB,
      `SELECT token, capability FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    expect(ucanRows.length).toBeGreaterThanOrEqual(1);
    console.log(`[QUIC] Vault B has UCAN for space (capability=${ucanRows[0].capability}) ✓`);

    // 3b. CRITICAL PRECONDITION — Vault B's device row must reach Vault A.
    //
    //     The leader (Vault A) only serves a share to Vault B if A's
    //     `allowed_peers[B]` contains the share's space. allowed_peers is
    //     built from `haex_space_devices WHERE endpoint_id != self`, so it
    //     needs Vault B's device row for this space to have propagated to A
    //     via CRDT SyncPush. Invite-accept alone does NOT guarantee this:
    //     B's local_delivery sync loop must be active and have pushed at
    //     least once. Without this wait the root listing below races the
    //     propagation and comes back empty (or "access denied") — this is the
    //     same precondition the cross-vault-file-sharing spec waits on.
    //
    //     A's leader calls reload_allowed_peers synchronously when the
    //     SyncPush carrying B's device row lands, so once the row is on A,
    //     A is ready to authorize B with no extra step.
    await vaultB
      .invokeTauriCommand("local_delivery_start", { spaceId })
      .catch(() => { /* already running / absent on older vault */ });
    await pollUntil(
      async () => {
        const status = await vaultB.invokeTauriCommand<{ activeSpaces?: string[] }>(
          "local_delivery_status", {},
        );
        return (status.activeSpaces ?? []).includes(spaceId);
      },
      { timeout: 60_000, interval: 1_000, label: "Vault B local_delivery active for space" },
    );
    await pollUntil(
      async () => {
        await vaultB
          .invokeTauriCommand("local_delivery_force_sync", { spaceId })
          .catch(() => { /* command absent on older vault */ });
        const rows = await sqlQuery<{ endpoint_id: string }>(
          vaultA, `SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1`, [spaceId],
        );
        return rows.some((r) => r.endpoint_id === nodeIdB);
      },
      { timeout: 90_000, interval: 500, label: "Vault B device row on Vault A" },
    );
    console.log(`[QUIC] Vault B device row reached Vault A — leader can authorize B ✓`);

    // 4. Sanity check: root listing must NOT throw AND must include the
    //    share. If this fails, the regression is even worse than the user
    //    reported (no UCAN at all, not just for the subpath case).
    //
    //    Polled because the share row reaches Vault B via CRDT, but the
    //    leader on Vault A also needs its in-memory `shares` cache to
    //    reflect the new row — which is asynchronous on both sides. A
    //    one-shot `loadSharesAsync()` on B can fire before A's cache
    //    catches up; we poll the leader's response instead.
    let lastRootResult: { ok: boolean; data: string } = { ok: false, data: 'no attempt' };
    const rootResult = (await pollUntil(
      async () => {
        const r = await vaultB.executeScript<{ ok: boolean; data: string }>(`
          const app = document.getElementById('__nuxt')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          // Pinia store id is 'peerStorageStore' (see usePeerStorageStore in
          // src/stores/peer-storage.ts). Earlier diagnostic blocks in phase 4
          // use 'peerStorage' which silently returns undefined — works there
          // because the assertions look at DOM text, not the store value.
          const peerStore = pinia?._s?.get('peerStorageStore');
          if (!peerStore) {
            return { ok: false, data: 'peerStorageStore not found in pinia' };
          }
          try {
            await peerStore.loadSharesAsync();
            const entries = await peerStore.remoteListAsync(${JSON.stringify(nodeIdA)}, '/');
            return { ok: true, data: entries.map(e => e.name).join(',') };
          } catch (e) {
            return { ok: false, data: e?.message ?? String(e) };
          }
        `);
        lastRootResult = r;
        return r.ok && r.data.includes(shareName) ? r : null;
      },
      { timeout: 30_000, interval: 1_000, label: `root listing on Vault B contains "${shareName}"` },
    ).catch((err) => {
      console.log(`[QUIC-DIAG] root listing never contained share. Last result: ok=${lastRootResult.ok} data="${lastRootResult.data}"`);
      throw err;
    }))!;
    console.log(`[QUIC] Vault B root listing result: ok=${rootResult.ok} data="${rootResult.data}"`);
    expect(rootResult.ok).toBe(true);
    expect(rootResult.data).toContain(shareName);

    // 5. THE REGRESSION REPRO — navigate INTO the share. With the bug
    //    present this throws synchronously inside `remoteListAsync` with
    //    "No valid UCAN token for this peer's space". With the fix the
    //    leader returns the marker file we wrote in step 1.
    //
    //    Polled for the same reason as root listing above: the leader's
    //    in-memory share cache and Vault B's UCAN-cache hydration race
    //    against the test rig. Once the marker file is visible at the
    //    subpath, the regression is unambiguously not present.
    //
    //    UCAN failures are surfaced explicitly (returning `null` would let
    //    the test silently time out with a generic message); pollUntil
    //    returns the result the moment the assertion would pass.
    const subpathResult = (await pollUntil(
      async () => {
        const r = await vaultB.executeScript<{ ok: boolean; data: string }>(`
          const app = document.getElementById('__nuxt')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          const peerStore = pinia?._s?.get('peerStorageStore');
          if (!peerStore) {
            return { ok: false, data: 'peerStorageStore not found in pinia' };
          }
          try {
            await peerStore.loadSharesAsync();
            const entries = await peerStore.remoteListAsync(
              ${JSON.stringify(nodeIdA)},
              '/' + ${JSON.stringify(shareName)},
            );
            return { ok: true, data: entries.map(e => e.name).join(',') };
          } catch (e) {
            return { ok: false, data: e?.message ?? String(e) };
          }
        `);
        // Fail fast on the UCAN error — polling won't change the verdict
        // because the resolver throws synchronously on (endpointId, share)
        // misses, and that's the regression we're hunting.
        if (!r.ok && r.data.includes("No valid UCAN token")) return r;
        return r.ok && r.data.includes("ucan-regression-marker.txt") ? r : null;
      },
      { timeout: 30_000, interval: 1_000, label: `subpath listing on Vault B contains marker file` },
    ))!;
    console.log(`[QUIC] Vault B subpath listing result: ok=${subpathResult.ok} data="${subpathResult.data}"`);

    // The specific regression assertion — fails the moment the resolver
    // returns a null UCAN token for the (endpointId, shareName) pair.
    expect(subpathResult.data).not.toContain("No valid UCAN token");
    expect(subpathResult.ok).toBe(true);
    expect(subpathResult.data).toContain("ucan-regression-marker.txt");
    console.log(`[QUIC] Subpath navigation into share works on Vault B ✓`);
  });
}
