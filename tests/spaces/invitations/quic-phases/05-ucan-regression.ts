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

    // 4. Sanity check: root listing must NOT throw. If this fails, the
    //    regression is even worse than the user reported (no UCAN at all,
    //    not just for the subpath case).
    const rootResult = await vaultB.executeScript<{ ok: boolean; data: string }>(`
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
        // Make sure the in-memory shares list reflects the DB before the
        // resolver runs. The orchestrator's CRDT subscription does this
        // automatically when the share row arrives, but the test rig races
        // with that subscription so a manual reload removes the flake.
        await peerStore.loadSharesAsync();
        const entries = await peerStore.remoteListAsync(${JSON.stringify(nodeIdA)}, '/');
        return { ok: true, data: entries.map(e => e.name).join(',') };
      } catch (e) {
        return { ok: false, data: e?.message ?? String(e) };
      }
    `);
    console.log(`[QUIC] Vault B root listing result: ok=${rootResult.ok} data="${rootResult.data}"`);
    expect(rootResult.ok).toBe(true);
    expect(rootResult.data).toContain(shareName);

    // 5. THE REGRESSION REPRO — navigate INTO the share. With the bug
    //    present this throws synchronously inside `remoteListAsync` with
    //    "No valid UCAN token for this peer's space". With the fix the
    //    leader returns the marker file we wrote in step 1.
    const subpathResult = await vaultB.executeScript<{ ok: boolean; data: string }>(`
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
    console.log(`[QUIC] Vault B subpath listing result: ok=${subpathResult.ok} data="${subpathResult.data}"`);

    // The specific regression assertion — fails the moment the resolver
    // returns a null UCAN token for the (endpointId, shareName) pair.
    expect(subpathResult.data).not.toContain("No valid UCAN token");
    expect(subpathResult.ok).toBe(true);
    expect(subpathResult.data).toContain("ucan-regression-marker.txt");
    console.log(`[QUIC] Subpath navigation into share works on Vault B ✓`);
  });
}
