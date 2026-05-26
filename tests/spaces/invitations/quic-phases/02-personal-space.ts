import * as crypto from "crypto";
import { expect, test } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "../quic-helpers/utils";
import {
  acceptInviteViaUI,
  declineInviteViaUI,
  sendInviteViaUI,
} from "../quic-helpers/ui-spaces";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 2 — Personal space invite/decline/re-invite/accept cycle.
 *
 * The "Personal" space is auto-created on first vault open. We exercise the
 * full invite lifecycle on it BEFORE creating a separate local space: it
 * proves the invite pipeline works even when the inviter is sending out of
 * the auto-created default space (whose ID is a per-vault UUID since the
 * device-identity refactor — see Step 14 for the legacy 'default' regression).
 *
 * Mutates `state.personalSpaceId`.
 */
export function registerPersonalSpacePhase(state: QuicTestState): void {
  const { contactLabel } = QUIC_CONSTANTS;

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4b — Invite to Personal space (auto-created default space)
  // ═══════════════════════════════════════════════════════════════════════════

  test("find Personal space on Vault A", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;

    const spaces = await sqlQuery<{ id: string; name: string }>(
      vaultA,
      `SELECT id, name FROM haex_spaces WHERE name = 'Personal' AND status = 'active' LIMIT 1`,
    );
    expect(spaces.length).toBe(1);
    state.personalSpaceId = spaces[0].id;
    console.log(`[QUIC] Personal space: ${state.personalSpaceId.slice(0, 8)}…`);

    // Ensure device is registered in Personal space
    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [state.personalSpaceId],
    );
    if (!devices.some((d) => d.endpoint_id === nodeIdA)) {
      // device_id must point at the real haex_devices row of this vault.
      // Phase 2 added a SQL FK on haex_devices.id; passing a random UUID here
      // would make the ensure-refs trigger try to create a stub that
      // collides with the own row on UNIQUE(endpoint_id).
      const ownDeviceRows = await sqlQuery<{ id: string }>(
        vaultA,
        "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
        [nodeIdA],
      );
      expect(ownDeviceRows.length).toBe(1);
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        params: [crypto.randomUUID(), state.personalSpaceId, ownDeviceRows[0].id, nodeIdA, "Vault A Desktop", "desktop", identityA.did],
      });
    }

    // No cleanup — test expects fresh vault containers. If Vault B already has
    // this space active from a prior run, the PushInvite handler correctly skips
    // it (accepted: true, no pending invite created) which is by design.
  });

  test("send invite to Personal space from Vault A to Vault B", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const nodeIdB = state.nodeIdB!;
    const personalSpaceId = state.personalSpaceId!;

    // Reset Vault B's state for this specific personalSpaceId. On a fresh
    // vault this is a no-op; on a persistent app (Playwright retries or
    // earlier specs in the same shard) B may already have an accepted
    // entry for A's Personal space — in that case the PushInvite handler
    // correctly skips and never writes haex_pending_invites, and the poll
    // below would time out by design. Cleaning state restores the test's
    // precondition so each run sees a fresh delivery.
    //
    // The DELETEs must succeed — silently swallowing a failure here would
    // leave stale rows that satisfy the poll for the *previous* invite,
    // hiding genuine PushInvite delivery regressions. The `local_delivery_stop`
    // call is best-effort because the sync loop may not be running yet.
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_pending_invites WHERE space_id = ?1`,
      params: [personalSpaceId],
    });
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_spaces WHERE id = ?1`,
      params: [personalSpaceId],
    });
    try { await vaultB.invokeTauriCommand("local_delivery_stop", { spaceId: personalSpaceId }); } catch { /* ok */ }
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_invite_outbox WHERE space_id = ?1`,
      params: [personalSpaceId],
    });

    // Confirm the precondition holds before sending the new invite — if a
    // stale pending row is still around the poll below would just observe it
    // and return spurious success.
    const stalePending = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1`,
      [personalSpaceId],
    );
    expect(stalePending.length).toBe(0);

    // Debug: check QUIC connectivity before invite
    console.log(`[QUIC-DEBUG] Personal space invite — nodeIdA=${nodeIdA?.slice(0, 12)}… nodeIdB=${nodeIdB?.slice(0, 12)}…`);
    for (const [label, vault] of [["A", vaultA], ["B", vaultB]] as const) {
      try {
        const st = await vault.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
        console.log(`[QUIC-DEBUG] Vault ${label} local_delivery: is_leader=${st.isLeader}, spaces=${st.activeSpaces?.length ?? 0}`);
      } catch (e) {
        console.log(`[QUIC-DEBUG] Vault ${label} local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
      }
    }

    const t0 = Date.now();
    await sendInviteViaUI(vaultA, "Personal", contactLabel);
    console.log(`[QUIC-DEBUG] sendInviteViaUI took ${Date.now() - t0}ms`);

    // Check outbox status on Vault A — the invite should be queued or delivered
    await wait(3000);
    const outbox = await sqlQuery<{ id: string; status: string; retry_count: number; target_endpoint_id: string; space_id: string; created_at: string }>(
      vaultA,
      `SELECT id, status, retry_count, target_endpoint_id, space_id, created_at FROM haex_invite_outbox WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 3`,
      [personalSpaceId],
    );
    console.log(`[QUIC-DEBUG] Outbox for Personal space: ${JSON.stringify(outbox.map(o => ({ status: o.status, retries: o.retry_count, target: o.target_endpoint_id?.slice(0, 12), created: o.created_at })))}`);

    // Check ALL pending invites on Vault B (without space_id filter)
    const allPendingB = await sqlQuery<{ id: string; space_id: string; status: string; space_name: string }>(
      vaultB,
      `SELECT id, space_id, status, space_name FROM haex_pending_invites ORDER BY created_at DESC LIMIT 10`,
    );
    console.log(`[QUIC-DEBUG] Vault B ALL pending invites: ${JSON.stringify(allPendingB.map(i => ({ spaceId: i.space_id?.slice(0, 8), status: i.status, name: i.space_name })))}`);

    // Also check haex_spaces on Vault B for any new entries
    const spacesB = await sqlQuery<{ id: string; name: string; type: string; status: string }>(
      vaultB,
      `SELECT id, name, type, status FROM haex_spaces ORDER BY created_at DESC LIMIT 5`,
    );
    console.log(`[QUIC-DEBUG] Vault B spaces: ${JSON.stringify(spacesB.map(s => ({ id: s.id?.slice(0, 8), name: s.name, type: s.type, status: s.status })))}`);

    // Delivery path: Vault A's outbox processor → QUIC dial via iroh-relay →
    // Vault B's accept loop → insert into haex_pending_invites.
    //
    // Under CI load iroh's dial+handshake occasionally needs more than a minute
    // to settle (observed: outbox drained in ~9s but B sees nothing for 70s+).
    // Bumping the timeout to 120s + tightening the interval from 2s to 1s
    // triples poll density and tolerates slower relay round-trips. The debug
    // log throttle stays every-5th-poll so noise doesn't explode.
    let pollCount = 0;
    const lastOutbox = { status: null as string | null, retries: -1 };
    await pollUntil(
      async () => {
        pollCount++;
        const invites = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [personalSpaceId],
        );
        // Transition tracker for flake-C analysis: log whenever outbox status
        // or retry_count changes, so classification (stuck-queued vs.
        // stuck-delivering vs. delivered-but-B-silent) is unambiguous across
        // CI runs. Cheap: single-row SELECT per poll.
        const ob = await sqlQuery<{ status: string; retry_count: number }>(
          vaultA,
          `SELECT status, retry_count FROM haex_invite_outbox ORDER BY created_at DESC LIMIT 1`,
        );
        if (ob.length > 0) {
          const { status, retry_count } = ob[0];
          if (status !== lastOutbox.status || retry_count !== lastOutbox.retries) {
            console.log(`[FLAKE-C] outbox@${Date.now() - t0}ms ${lastOutbox.status}→${status} retries ${lastOutbox.retries}→${retry_count} invitesOnB=${invites.length}`);
            lastOutbox.status = status;
            lastOutbox.retries = retry_count;
          }
        }
        if (pollCount % 10 === 1) {
          console.log(`[QUIC-DEBUG] Poll #${pollCount} (${Date.now() - t0}ms): invites=${invites.length}`);
        }
        return invites.length > 0;
      },
      { timeout: 120_000, interval: 1_000, label: "Personal space invite delivery to Vault B" },
    );
    console.log(`[QUIC-DEBUG] Invite delivered after ${Date.now() - t0}ms (${pollCount} polls)`);
  });

  test("decline Personal space invite on Vault B", async () => {
    const personalSpaceId = state.personalSpaceId!;
    await declineInviteViaUI(state.vaultB!, "Personal", personalSpaceId);

    const remaining = await sqlQuery<{ id: string }>(
      state.vaultB!,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [personalSpaceId],
    );
    expect(remaining.length).toBe(0);
  });

  test("Vault A Personal space still active after decline", async () => {
    const spaces = await sqlQuery<{ id: string; status: string }>(
      state.vaultA!,
      `SELECT id, status FROM haex_spaces WHERE id = ?1`,
      [state.personalSpaceId!],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].status).toBe("active");
  });

  test("re-invite to Personal space after decline", async () => {
    const personalSpaceId = state.personalSpaceId!;
    await sendInviteViaUI(state.vaultA!, "Personal", contactLabel);

    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          state.vaultB!,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [personalSpaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "Personal space re-invite delivery" },
    );
  });

  test("accept Personal space invite on Vault B", async () => {
    const personalSpaceId = state.personalSpaceId!;

    // Debug: inspect the pending invite to verify spaceEndpoints is populated
    const inviteData = await sqlQuery<{ id: string; space_endpoints: string; token_id: string; space_name: string }>(
      state.vaultB!,
      `SELECT id, space_endpoints, token_id, space_name FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending' LIMIT 1`,
      [personalSpaceId],
    );
    console.log(`[QUIC-DEBUG] Invite data before accept: ${JSON.stringify(inviteData.map(i => ({ id: i.id?.slice(0, 8), endpoints: i.space_endpoints, token: i.token_id?.slice(0, 8), name: i.space_name })))}`);

    await acceptInviteViaUI(state.vaultB!, "Personal", personalSpaceId);

    const invites = await sqlQuery<{ status: string }>(
      state.vaultB!,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      [personalSpaceId],
    );

    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].status).toBe("accepted");
  });

  test("Vault B has Personal space after accepting", async () => {
    const personalSpaceId = state.personalSpaceId!;
    const spaces = await sqlQuery<{ id: string; name: string; status: string }>(
      state.vaultB!,
      `SELECT id, name, status FROM haex_spaces WHERE id = ?1`,
      [personalSpaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("Personal");
    console.log(`[QUIC] Vault B joined Personal space: ${spaces[0].status}`);
  });
}
