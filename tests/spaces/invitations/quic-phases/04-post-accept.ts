import { expect, test } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../../helpers/ui/utils";
import { openSettingsCategory } from "../../../helpers/ui/ui-vault";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 4 — Post-accept assertions.
 *
 * After Vault B has accepted Vault A's invite to the local space, verify
 * three increasingly user-visible behaviors:
 *   1. Inviter attribution: owner_identity_id + UCAN issuer/audience must
 *      reflect Vault A as the inviter, not Vault B as a self-claimer.
 *   2. Spaces list UI shows the joined space as `active`, not `pending`.
 *   3. The share row attached by Vault A in phase 3 propagates to B via
 *      CRDT and renders in the space detail view.
 *
 * Read-only — does not mutate `state`.
 */
export function registerPostAcceptPhase(state: QuicTestState): void {
  const { spaceName, shareName } = QUIC_CONSTANTS;

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9b — Inviter attribution after accept (regression: owner_identity_id
  // previously pointed to the claimant's own identity, making shared spaces
  // appear self-owned in the UI)
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B space.owner_identity_id points to inviter's identity row, not claimant's", async () => {
    const spaceId = state.spaceId!;
    const identityA = state.identityA!;
    const identityB = state.identityB!;

    const spaces = await sqlQuery<{ owner_identity_id: string }>(
      state.vaultB!,
      `SELECT owner_identity_id FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    const ownerId = spaces[0].owner_identity_id;
    expect(ownerId).toBeTruthy();

    // The owner identity row must exist on Vault B and carry Vault A's DID —
    // not Vault B's own DID. This is exactly the Rust-side
    // resolve_owner_identity_id regression.
    const owner = await sqlQuery<{ id: string; did: string; private_key: string | null }>(
      state.vaultB!,
      `SELECT id, did, private_key FROM haex_identities WHERE id = ?1`,
      [ownerId],
    );
    expect(owner.length).toBe(1);
    expect(owner[0].did).toBe(identityA.did);
    expect(owner[0].did).not.toBe(identityB.did);

    // The mirrored inviter identity on Vault B has no private key — it's a
    // remote party, not a local own-identity.
    expect(owner[0].private_key).toBeNull();
    console.log(`[QUIC] Owner attribution: space.owner=${owner[0].did.slice(0, 24)}… (inviter) ✓`);
  });

  test("Vault B's UCAN for the shared space has issuer=inviter, audience=claimant", async () => {
    const spaceId = state.spaceId!;
    const identityA = state.identityA!;
    const identityB = state.identityB!;

    // Regression: the old local-claim path stored issuer_did = claimant DID
    // ("self-issued for local claims"), which misrepresented the delegation
    // chain signed by the inviter and confused CRDT fan-out on the admin side.
    const rows = await sqlQuery<{ issuer_did: string; audience_did: string; capabilities: string }>(
      state.vaultB!,
      `SELECT issuer_did, audience_did, capabilities
       FROM haex_ucan_tokens
       WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(rows.length).toBeGreaterThan(0);

    // Every row delegated to Vault B must be issued by Vault A.
    for (const row of rows) {
      expect(row.audience_did).toBe(identityB.did);
      expect(row.issuer_did).toBe(identityA.did);
      expect(row.issuer_did).not.toBe(identityB.did);
    }
    console.log(`[QUIC] UCAN delegation shape: ${rows.length} row(s) with issuer=A, audience=B ✓`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9d — Post-accept user-visible behavior
  //
  // Previous tests verify backend state (haex_spaces row, UCAN shape). These
  // three tests model what the USER actually sees:
  //   1. The joined space appears in the Spaces list UI (not just the DB).
  //   2. The pre-attached peer_share row from Vault A propagates to Vault B.
  //   3. The share is visible when the user opens the space detail view.
  //
  // #2 is the regression documented in
  // haex-vault/.claude/plans/share-visibility-after-accept.md — if CRDT
  // sync after accept doesn't pull history, the row never arrives.
  // #3 catches a separate class of bug: row present but UI filters it out
  // (e.g. if SpaceShares only renders shares authored on the local device).
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B shows the accepted space as active (non-pending) in the Spaces list", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;

    await openSettingsCategory(vaultB, "spaces");
    await wait(1500);

    // Pending vs. active is exposed via `data-space-status` on SpaceListItem
    // (see haex-vault/src/components/haex/system/settings/spaces/SpaceListItem.vue).
    // This is the stable contract for invitee-side visibility — the CSS
    // dashed-border heuristic previously used here was ambiguous because
    // [class*="rounded-lg"] also matched outer layout containers.
    //
    // Budget: locally this resolves in ~2s, but CI saw >15s-timeouts on the
    // first post-merge run. The store-refresh after QUIC accept is currently
    // only triggered in the Online accept branch (useSpaceInvites.ts:116) —
    // the QUIC path relies on implicit refresh inside acceptLocalInviteAsync.
    // 45s matches the CRDT-sync budget for the adjacent peer_share test.
    const pollStart = Date.now();
    try {
      await pollUntil(
        () => vaultB.executeScript<boolean>(`
          const target = ${JSON.stringify(spaceId)};
          const card = document.querySelector('[data-testid="space-card-' + target + '"]');
          if (!card) return false;
          const status = card.getAttribute('data-space-status');
          return status === 'active';
        `),
        { timeout: 45_000, interval: 500, label: "accepted space card visible (non-pending) on Vault B" },
      );
      console.log(`[QUIC-DEBUG 1426] Card became active after ${Date.now() - pollStart}ms`);
    } catch (err) {
      // Three-layer diagnostic dump: DOM, DB, URL/settings-panel. Lets us tell
      // stale-store vs. data-testid mismatch vs. wrong settings panel apart
      // in a single failing run. Each block is best-effort — if a diagnostic
      // call itself throws (e.g. vaultB disconnected), we still surface the
      // original pollUntil timeout rather than masking it with a secondary
      // error.
      console.log(`[QUIC-DEBUG 1426] Target spaceId=${spaceId}`);

      try {
        const uiState = await vaultB.executeScript<{
          url: string;
          cards: Array<{ testId: string | null; status: string | null; text: string }>;
          cardCount: number;
          createTriggerVisible: boolean;
          activeRoute: string | null;
          bodyHeadings: string[];
        }>(`
          const cards = [...document.querySelectorAll('[data-testid^="space-card-"]')].map(el => ({
            testId: el.getAttribute('data-testid'),
            status: el.getAttribute('data-space-status'),
            text: (el.textContent ?? '').trim().slice(0, 120).replace(/\\s+/g, ' '),
          }));
          const createBtn = document.querySelector('[data-testid="spaces-create-trigger"]');
          const activeTab = document.querySelector('[role="tab"][aria-selected="true"], [data-state="active"][role="tab"]');
          const headings = [...document.querySelectorAll('h1, h2, h3')].map(h => (h.textContent ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 6);
          return {
            url: location.href,
            cards,
            cardCount: cards.length,
            createTriggerVisible: !!createBtn && (createBtn.offsetParent !== null),
            activeRoute: activeTab?.textContent?.trim() ?? null,
            bodyHeadings: headings,
          };
        `);
        console.log(`[QUIC-DEBUG 1426] UI state: ${JSON.stringify(uiState, null, 2)}`);
      } catch (diagErr) {
        console.log(`[QUIC-DEBUG 1426] ui-state diagnostics failed: ${(diagErr as Error)?.message ?? String(diagErr)}`);
      }

      try {
        const dbSpaces = await sqlQuery<{ id: string; status: string; name: string; type: string; owner_identity_id: string | null }>(
          vaultB,
          `SELECT id, status, name, type, owner_identity_id FROM haex_spaces ORDER BY created_at DESC LIMIT 10`,
        );
        console.log(`[QUIC-DEBUG 1426] haex_spaces (B): ${JSON.stringify(dbSpaces.map(s => ({ id: s.id?.slice(0, 8), status: s.status, name: s.name, type: s.type, owner: s.owner_identity_id?.slice(0, 8) ?? null })))}`);

        const targetSpace = dbSpaces.find(s => s.id === spaceId);
        console.log(`[QUIC-DEBUG 1426] Target space row on B: ${targetSpace ? JSON.stringify(targetSpace) : "MISSING"}`);
      } catch (diagErr) {
        console.log(`[QUIC-DEBUG 1426] db-spaces diagnostics failed: ${(diagErr as Error)?.message ?? String(diagErr)}`);
      }

      try {
        const dbInvites = await sqlQuery<{ id: string; space_id: string; status: string }>(
          vaultB,
          `SELECT id, space_id, status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 5`,
          [spaceId],
        );
        console.log(`[QUIC-DEBUG 1426] haex_pending_invites[${spaceId.slice(0, 8)}]: ${JSON.stringify(dbInvites.map(i => ({ id: i.id?.slice(0, 8), status: i.status })))}`);
      } catch (diagErr) {
        console.log(`[QUIC-DEBUG 1426] db-invites diagnostics failed: ${(diagErr as Error)?.message ?? String(diagErr)}`);
      }

      throw err;
    }
    console.log(`[QUIC] Vault B spaces list shows "${spaceName}" as active ✓`);
  });

  test("Vault A's peer_share row propagates to Vault B via CRDT sync", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const spaceId = state.spaceId!;
    const shareId = state.shareId!;

    // The share row was inserted on Vault A at Step 5b (before the invite).
    // After Vault B accepts, `local_delivery_connect` starts a peer sync loop;
    // haex_peer_shares is CRDT-synced (no _no_sync suffix) so the row must
    // eventually land on Vault B's DB.
    //
    // Budget: CRDT sync after an invite-accept can take tens of seconds on
    // slow CI (initial MLS epoch export + UCAN token persist + first pull
    // loop iteration). 60s is the same envelope used for invite delivery.
    try {
      await pollUntil(
        async () => {
          // Nudge Vault B's sync loop on every tick so the next pull cycle
          // starts immediately rather than waiting up to POLL_INTERVAL (5s)
          // on the backend. force_sync is a no-op when the loop has not
          // been created yet or the command isn't available, so the .catch
          // keeps this safe across vault versions.
          await vaultB
            .invokeTauriCommand("local_delivery_force_sync", { spaceId })
            .catch(() => { /* loop may not exist yet, or command absent */ });
          const rows = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
            vaultB,
            `SELECT id, name, endpoint_id FROM haex_peer_shares
             WHERE space_id = ?1 AND id = ?2`,
            [spaceId, shareId],
          );
          return rows.length === 1
            && rows[0].name === shareName
            && rows[0].endpoint_id === nodeIdA;
        },
        { timeout: 90_000, interval: 500, label: "peer_share row synced to Vault B" },
      );
      console.log(`[QUIC] Vault A's share synced to Vault B: id=${shareId.slice(0, 8)}… ✓`);
    } catch (err) {
      // Diagnostic dump on failure — we read both vaults' state PLUS
      // the synced `haex_logs` table (haex-vault writes sync-loop / pull /
      // membership events there because tauri-driver mutes stderr in the
      // Docker rig). The combination tells us:
      //   - did the sync loop on B start? (LocalDeliveryConnect / SyncLoop logs on B)
      //   - did A's leader receive the Announce/SyncPull? (Announce / SyncPull logs on A)
      //   - did the leader return rows or reject for capability/membership? (SyncPull served vs rejected)
      //   - did rows land on B but with mismatched values?
      try {
        const sharesA = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
          vaultA, `SELECT id, name, endpoint_id FROM haex_peer_shares WHERE space_id = ?1`, [spaceId],
        );
        const sharesB = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
          vaultB, `SELECT id, name, endpoint_id FROM haex_peer_shares WHERE space_id = ?1`, [spaceId],
        );
        const devicesB = await sqlQuery<{ endpoint_id: string }>(
          vaultB, `SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1`, [spaceId],
        );
        const membersB = await sqlQuery<{ identity_id: string; role: string }>(
          vaultB, `SELECT identity_id, role FROM haex_space_members WHERE space_id = ?1`, [spaceId],
        );
        const ucansB = await sqlQuery<{ audience_did: string; capabilities: string; expires_at: number }>(
          vaultB, `SELECT audience_did, capabilities, expires_at FROM haex_ucan_tokens WHERE space_id = ?1`, [spaceId],
        );
        const membersA = await sqlQuery<{ identity_id: string; role: string }>(
          vaultA, `SELECT identity_id, role FROM haex_space_members WHERE space_id = ?1`, [spaceId],
        );
        console.log(`[QUIC-DEBUG 1523] sharesA=${JSON.stringify(sharesA.map(s => ({ id: s.id.slice(0, 8), name: s.name, dev: s.endpoint_id.slice(0, 12) })))}`);
        console.log(`[QUIC-DEBUG 1523] sharesB=${JSON.stringify(sharesB.map(s => ({ id: s.id.slice(0, 8), name: s.name, dev: s.endpoint_id.slice(0, 12) })))}`);
        console.log(`[QUIC-DEBUG 1523] devicesB=${JSON.stringify(devicesB.map(d => d.endpoint_id.slice(0, 12)))}`);
        console.log(`[QUIC-DEBUG 1523] membersB=${membersB.length} membersA=${membersA.length} ucansB=${JSON.stringify(ucansB.map(u => ({ aud: u.audience_did.slice(0, 24), caps: u.capabilities, exp: u.expires_at })))}`);
      } catch (diagErr) {
        console.log(`[QUIC-DEBUG 1523] state dump failed: ${(diagErr as Error)?.message ?? String(diagErr)}`);
      }

      try {
        const logsB = await sqlQuery<{ timestamp: string; level: string; source: string; message: string }>(
          vaultB,
          `SELECT timestamp, level, source, message FROM haex_logs
           WHERE source IN ('SyncLoop', 'LocalDeliveryConnect', 'SyncPull', 'Announce', 'PeerSession', 'ClaimInvite', 'MultiLeader')
           ORDER BY timestamp DESC LIMIT 40`,
        );
        console.log(`[QUIC-DEBUG 1523] B logs (${logsB.length}):`);
        for (const l of logsB) {
          console.log(`  [${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`);
        }

        const logsA = await sqlQuery<{ timestamp: string; level: string; source: string; message: string }>(
          vaultA,
          `SELECT timestamp, level, source, message FROM haex_logs
           WHERE source IN ('SyncPull', 'Announce', 'MultiLeader', 'ClaimInvite')
           ORDER BY timestamp DESC LIMIT 40`,
        );
        console.log(`[QUIC-DEBUG 1523] A logs (${logsA.length}):`);
        for (const l of logsA) {
          console.log(`  [${l.timestamp}] [${l.level}] [${l.source}] ${l.message}`);
        }
      } catch (diagErr) {
        console.log(`[QUIC-DEBUG 1523] log dump failed: ${(diagErr as Error)?.message ?? String(diagErr)}`);
      }
      throw err;
    }
  });

  test("Vault B shows Vault A's share in the space detail view", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;

    await openSettingsCategory(vaultB, "spaces");
    await wait(1000);

    // Click the accepted space card via stable testid.
    // Previous attempt with `[class*="rounded-lg"]` matched outer layout
    // wrappers that also contain the space name transitively (via
    // descendant textContent), resulting in clicks on non-handled
    // container elements and the detail view never opening.
    const clicked = await vaultB.executeScript<boolean>(`
      const card = document.querySelector('[data-testid="space-card-' + ${JSON.stringify(spaceId)} + '"]');
      if (!card) return false;
      if (card.getAttribute('data-space-status') !== 'active') return false;
      card.click();
      return true;
    `);
    console.log(`[QUIC] Space-card click (testid): clicked=${clicked}`);
    expect(clicked).toBe(true);
    await wait(2000);

    // Verify we're actually in the detail view — the list's "Create" button
    // is gone and a back-button surfaces. Without this, a failing share
    // assertion is ambiguous (UI never navigated vs. share filtered out).
    const inDetail = await vaultB.executeScript<{ createVisible: boolean; backVisible: boolean; title: string }>(`
      const create = document.querySelector('[data-testid="spaces-create-trigger"]');
      const back = [...document.querySelectorAll('button')].find(b => {
        const a = b.getAttribute('aria-label') ?? '';
        return a.toLowerCase().includes('back') || a.toLowerCase().includes('zurück');
      });
      const h = document.querySelector('h1, h2, [class*="text-xl"], [class*="font-semibold"]');
      return {
        createVisible: !!create && (create.offsetParent !== null),
        backVisible: !!back,
        title: (h?.textContent ?? '').slice(0, 80),
      };
    `);
    console.log(`[QUIC] Detail-view state: create_btn_visible=${inDetail.createVisible} back_btn=${inDetail.backVisible} header="${inDetail.title}"`);
    // The list-view's "Create" button vanishes once we're in the detail
    // view; this is a reliable signal that the navigation actually happened
    // (independent of i18n / button-label changes). The back-button check
    // was intentionally dropped — its aria-label is locale-dependent and
    // gave too many false negatives on real UI flows.
    expect(inDetail.createVisible).toBe(false);

    // SpaceShares renders shares grouped by device. The share's `name`
    // appears as visible text somewhere in the detail view. Poll a
    // generous window — the component mounts async and runs
    // `peerStore.loadSharesAsync()` in onMounted.
    await pollUntil(
      () => vaultB.executeScript<boolean>(`
        const target = ${JSON.stringify(shareName)};
        return (document.body.textContent ?? '').includes(target);
      `),
      { timeout: 30_000, interval: 500, label: `share "${shareName}" visible in Vault B space detail` },
    ).catch(async (err) => {
      // On timeout, dump peerStore state + DB sanity-check so the failure
      // carries actionable context instead of just "not visible".
      const diag = await vaultB.executeScript<{
        shares: unknown;
        nodeId: string | null;
        currentTextSample: string;
      }>(`
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const peerStore = pinia?._s?.get('peerStorage');
        const allShares = peerStore?.shares ?? [];
        const filtered = allShares.filter(s => s.spaceId === ${JSON.stringify(spaceId)});
        return {
          shares: filtered.map(s => ({
            id: (s.id ?? '').slice(0, 8),
            name: s.name,
            dev: (s.endpointId ?? '').slice(0, 12),
          })),
          nodeId: peerStore?.nodeId ?? null,
          currentTextSample: (document.body.textContent ?? '').slice(0, 300),
        };
      `);
      console.log(`[QUIC-DEBUG] share-UI failure context: peerStore.shares(for this space)=${JSON.stringify(diag.shares)} self_nodeId=${String(diag.nodeId).slice(0, 12)} domSample="${diag.currentTextSample}"`);
      throw err;
    });
    console.log(`[QUIC] Vault B space detail shows Vault A's share "${shareName}" ✓`);
  });
}
