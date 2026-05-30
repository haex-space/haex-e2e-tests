import { expect, test } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../../helpers/ui/utils";
import { acceptInviteViaUI, sendInviteViaUI } from "../quic-helpers/ui-spaces";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 6 — Data-consistency regression guards.
 *
 * Each test in this phase covers a regression in `haex-vault` PR #356
 * ("fix(space-delivery): plug attribution, UCAN, and relay-URL gaps in
 * invite/leave flow"). The user-visible symptom was: after a leave + re-invite
 * cycle, the invitee's file browser showed the shared folder's name but no
 * files inside, while `[PEER_STORAGE] remoteListAllSharesAsync: leader rejected
 * space … connection lost` appeared in the console. Live DB inspection
 * surfaced four independent bugs that chained into that one failure:
 *
 *   1. `haex_peer_shares.authored_by_did` was NULL on the local-author side.
 *      `validate_and_attribute` only re-injects the column on SyncPush; on
 *      SyncPull the leader serves rows raw, so peers ended up with NULL
 *      too — which also disabled the `haex_peer_shares_ensure_refs` trigger
 *      (`WHEN NEW.authored_by_did IS NOT NULL`) and left the FK dangling.
 *
 *   2. Same for `haex_space_devices.authored_by_did` on locally-published
 *      device rows.
 *
 *   3. The inviter's `relay_url` did not travel with the PushInvite payload,
 *      so the invitee's seeded `haex_space_devices` stub carried NULL until
 *      the inviter's authoritative CRDT row arrived. The first sync round
 *      after Accept had to rely on mDNS / hole-punching alone.
 *
 *   4. A self-leave kept the UCAN row alive (the LEAVING-state sync loop
 *      needed it). On a re-invite within the 30-day cleanup window, the
 *      new UCAN was inserted alongside the old one — potentially with
 *      different capabilities. `persist_claimed_ucan` now wipes prior rows
 *      for `(space_id, audience_did)` before inserting the fresh one.
 *
 * Runs after phase 5 (UCAN subpath regression) so the local-space, peer share,
 * inviter stub, and second-invite UCAN are all in place. Runs **before**
 * phase 7 (edge-cases) because that phase deletes the local space at the end.
 */
export function registerDataConsistencyPhase(state: QuicTestState): void {
  const { spaceName, contactLabel } = QUIC_CONSTANTS;

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 1 — authored_by_did on locally-inserted rows
  //
  // The Author's *own* peer_shares row was missing `authored_by_did` because
  // `addShareAsync` didn't write the column on local insert. Same for
  // `registerDeviceInSpaceAsync` and `haex_space_devices`.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A's own peer_shares row has authored_by_did = identityA.did", async () => {
    const vaultA = state.vaultA!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;
    const shareId = state.shareId!;

    const rows = await sqlQuery<{ id: string; authored_by_did: string | null; endpoint_id: string }>(
      vaultA,
      `SELECT id, authored_by_did, endpoint_id FROM haex_peer_shares
       WHERE space_id = ?1 AND id = ?2`,
      [spaceId, shareId],
    );
    expect(rows.length).toBe(1);
    // Regression bait: this used to be NULL because the local insert path
    // never set it. With NULL, the `haex_peer_shares_ensure_refs` trigger
    // (WHEN NEW.authored_by_did IS NOT NULL) doesn't fire, so the FK parent
    // stub never gets created — only visible to peers when they pull the
    // row via SyncPull and try to follow `device_id`.
    expect(rows[0].authored_by_did).toBe(identityA.did);
    console.log(`[QUIC] Vault A peer_shares.authored_by_did = ${rows[0].authored_by_did?.slice(0, 24)}… ✓`);
  });

  test("Vault A's own space_devices row has authored_by_did = identityA.did", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;

    const rows = await sqlQuery<{ authored_by_did: string | null; endpoint_id: string }>(
      vaultA,
      `SELECT authored_by_did, endpoint_id FROM haex_space_devices
       WHERE space_id = ?1 AND endpoint_id = ?2`,
      [spaceId, nodeIdA],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].authored_by_did).toBe(identityA.did);
    console.log(`[QUIC] Vault A space_devices.authored_by_did = ${rows[0].authored_by_did?.slice(0, 24)}… ✓`);
  });

  test("Vault B's CRDT-replicated peer_shares row has authored_by_did = identityA.did", async () => {
    const vaultB = state.vaultB!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;
    const shareId = state.shareId!;

    // Polled because the row arrives via SyncPull and there's no
    // synchronous ACK that tells the test the apply has happened. Phase 4
    // already proved the row's metadata propagates; we just re-confirm
    // here and add the attribution assertion.
    const row = (await pollUntil(
      async () => {
        const rows = await sqlQuery<{ authored_by_did: string | null }>(
          vaultB,
          `SELECT authored_by_did FROM haex_peer_shares
           WHERE space_id = ?1 AND id = ?2`,
          [spaceId, shareId],
        );
        return rows.length === 1 && rows[0].authored_by_did ? rows[0] : null;
      },
      { timeout: 30_000, interval: 500, label: "peer_shares.authored_by_did synced to Vault B" },
    ))!;
    // SyncPush would re-inject from the UCAN audience, but the leader (A)
    // serves SyncPull rows raw — so without the author-side fix, this would
    // be NULL on B too.
    expect(row.authored_by_did).toBe(identityA.did);
    console.log(`[QUIC] Vault B peer_shares.authored_by_did = ${row.authored_by_did?.slice(0, 24)}… ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 3 — inviter's relay_url propagates into the invitee's space_devices
  //         stub (seeded synchronously from the PushInvite payload, no wait
  //         for the inviter's authoritative CRDT row).
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B's space_devices stub for the inviter carries a relay_url", async () => {
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const spaceId = state.spaceId!;

    // The stub is seeded synchronously inside `acceptLocalInvite` once the
    // ClaimInvite RPC returns. By the time post-accept assertions completed
    // (phase 4), it must exist. We poll only to absorb the moment when the
    // inviter's *authoritative* row arrives via CRDT and HLC-merges with the
    // stub — either source is acceptable as long as relay_url ends up set.
    const row = (await pollUntil(
      async () => {
        const rows = await sqlQuery<{ endpoint_id: string; relay_url: string | null }>(
          vaultB,
          `SELECT endpoint_id, relay_url FROM haex_space_devices
           WHERE space_id = ?1 AND endpoint_id = ?2`,
          [spaceId, nodeIdA],
        );
        return rows.length === 1 && rows[0].relay_url ? rows[0] : null;
      },
      { timeout: 30_000, interval: 500, label: "inviter's relay_url on Vault B's stub" },
    ))!;
    // The exact URL depends on the test rig's configured relay; we only
    // assert it's a non-empty string starting with http(s)://. Before the
    // fix, this column was NULL because the invite payload didn't carry it
    // and the stub used the receiver-side configured relay only as a
    // best-effort fallback.
    expect(row.relay_url).toBeTruthy();
    expect(typeof row.relay_url).toBe("string");
    expect(row.relay_url!).toMatch(/^https?:\/\//);
    console.log(`[QUIC] Vault B inviter-stub relay_url = ${row.relay_url} ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bug 4 — UCAN cleanup on local-leave + re-invite replacement
  //
  // Reproduces the exact symptom the user reported: leave + re-invite
  // produced two UCAN rows for the same (space_id, audience_did). Before the
  // fix:
  //   - leave kept the UCAN alive for up to 30 days (LEAVE_GIVE_UP_AFTER_MS)
  //   - re-invite ran `persist_claimed_ucan` which only INSERTed
  // After:
  //   - leave deletes the UCAN row immediately (deleteUcans: true)
  //   - `persist_claimed_ucan` runs DELETE before INSERT defensively
  //
  // Both paths converge on "exactly one row after re-invite". We exercise
  // both: assert table is empty right after leave, then assert exactly one
  // row after the new ClaimInvite — and confirm it's the freshly-issued
  // token, not the stale one.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B's UCAN rows for the space are gone after local self-leave", async () => {
    const vaultB = state.vaultB!;
    const identityB = state.identityB!;
    const spaceId = state.spaceId!;

    // Snapshot the current UCAN tokens so the post-leave assertion is
    // meaningful (and so a CI run that already starts with an empty
    // ucan_tokens table fails loudly instead of passing trivially).
    const before = await sqlQuery<{ token: string }>(
      vaultB,
      `SELECT token FROM haex_ucan_tokens
       WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(before.length).toBeGreaterThanOrEqual(1);
    const tokenBefore = before[0].token;

    // Drive the leave through the Pinia store directly. There's no stable
    // UI button for "leave a local space" in the current build, and the
    // store action is the same code path the future UI button would call.
    // The local-leave branch runs `removeSelfFromSpace(..., { deleteUcans: true })`
    // after the fix — that's what we're verifying.
    const result = await vaultB.executeScript<{ ok: boolean; error: string | null }>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const spacesStore = pinia?._s?.get('spacesStore');
      if (!spacesStore) {
        return { ok: false, error: 'spacesStore not found in pinia' };
      }
      try {
        // originUrl='' triggers the LOCAL branch in leaveSpaceAsync (a
        // truthy originUrl would attempt a remote DELETE that requires the
        // home server to be online).
        await spacesStore.leaveSpaceAsync('', ${JSON.stringify(spaceId)}, null);
        return { ok: true, error: null };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    `);
    expect(result.ok, `leaveSpaceAsync failed: ${result.error}`).toBe(true);

    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ token: string }>(
          vaultB,
          `SELECT token FROM haex_ucan_tokens
           WHERE space_id = ?1 AND audience_did = ?2`,
          [spaceId, identityB.did],
        );
        return rows.length === 0;
      },
      { timeout: 10_000, interval: 500, label: "UCAN row deleted after leave" },
    );
    console.log(`[QUIC] Vault B UCAN cleared on leave (was: ${tokenBefore.slice(0, 24)}…) ✓`);
  });

  test("re-invite to same space results in exactly one UCAN row (not two)", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const identityB = state.identityB!;
    const spaceId = state.spaceId!;

    // After Vault B left, A's CRDT still has B's old member row in
    // haex_deleted_rows — but the *active* members table no longer holds
    // B. A re-invite goes through the same outbox + PushInvite path as
    // the original invite. We re-use the helper with `withWrite=true` so
    // the new UCAN's capability matches phase 3's second invite and the
    // downstream edge-cases assertions (which check capabilities on B)
    // continue to pass.
    await sendInviteViaUI(vaultA, spaceName, contactLabel, true);

    // Wait for the new invite to land on Vault B as a pending row. The
    // outbox processor can take a couple of seconds because invite policy
    // ack + QUIC roundtrip happen async.
    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string; status: string }>(
          vaultB,
          `SELECT id, status FROM haex_pending_invites
           WHERE space_id = ?1 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
          [spaceId],
        );
        return invites.length === 1;
      },
      { timeout: 60_000, interval: 1_000, label: "re-invite delivery to Vault B" },
    );

    // Accept the new invite via UI. After acceptInviteViaUI returns, the
    // ClaimInvite RPC has persisted the new UCAN row.
    await acceptInviteViaUI(vaultB, spaceName, spaceId);

    // The actual assertion: exactly one UCAN for (space, B). Before the
    // fix this was 2 — the stale one + the new one. The poll waits for the
    // freshly-claimed row to arrive, then a settle window absorbs the case
    // where the stale duplicate lands a moment AFTER the new one — without
    // the settle, the test could see the transient single-row state and
    // pass even though the regression is reproducing. ClaimInvite writes
    // are async wrt. the UI confirmation, so the late-duplicate race is
    // real (it's the exact bug we are guarding against).
    await pollUntil(
      async () => {
        const r = await sqlQuery<{ token: string }>(
          vaultB,
          `SELECT token FROM haex_ucan_tokens
           WHERE space_id = ?1 AND audience_did = ?2`,
          [spaceId, identityB.did],
        );
        return r.length >= 1;
      },
      { timeout: 30_000, interval: 500, label: "new UCAN row after re-invite" },
    );
    // Settle so a late duplicate insert/replication has a chance to surface
    // before we assert "exactly one". 2s matches the upper bound of
    // ClaimInvite's UCAN-write tail observed on CI.
    await wait(2_000);
    const rows = await sqlQuery<{ token: string; issued_at: number; capability: string }>(
      vaultB,
      `SELECT token, issued_at, capability FROM haex_ucan_tokens
       WHERE space_id = ?1 AND audience_did = ?2
       ORDER BY issued_at DESC`,
      [spaceId, identityB.did],
    );

    // The bug we are guarding against: two coexisting rows for the same
    // (space_id, audience_did) — the stale leftover from before the leave
    // and the freshly-claimed one. `persist_claimed_ucan` now writes the
    // new row first and then DELETEs older rows for the same audience.
    expect(rows.length).toBe(1);
    console.log(`[QUIC] Vault B UCAN count after re-invite = ${rows.length} (capability=${rows[0].capability}) ✓`);

    // Wait briefly for the spaces store to reflect the re-accept (status
    // back to 'active' and member row reinstated) so any later phase that
    // reads B's state sees the post-rejoin shape, not the transient
    // post-leave one. Without this, phase 7 capability checks can land in
    // the gap between "left" and "rejoined" on slow CI.
    await pollUntil(
      async () => {
        const spaces = await sqlQuery<{ status: string }>(
          vaultB,
          `SELECT status FROM haex_spaces WHERE id = ?1`,
          [spaceId],
        );
        return spaces.length === 1 && spaces[0].status === "active";
      },
      { timeout: 15_000, interval: 500, label: "Vault B space back to active after re-invite" },
    );
    // Small settle window so the downstream sync loop has registered the
    // new UCAN before the next phase's tests probe peer-storage state.
    await wait(500);
  });
}
