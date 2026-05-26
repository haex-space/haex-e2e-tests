import * as crypto from "crypto";
import { expect, test } from "../../../fixtures";
import { pollUntil, sqlQuery } from "../quic-helpers/utils";
import {
  acceptInviteViaUI,
  createLocalSpaceViaUI,
  declineInviteViaUI,
  sendInviteViaUI,
} from "../quic-helpers/ui-spaces";
import { openSettingsCategory } from "../quic-helpers/ui-vault";
import { wait } from "../quic-helpers/utils";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 3 — Local-space create + share + invite/decline/re-invite/accept.
 *
 * Builds on the setup phase: Vault A creates a new local space, attaches a
 * peer share to it, then sends two invites to Vault B (the first declined,
 * the second accepted with write capability). Mirrors the user flow that
 * brought the inviter-attribution + UCAN regressions to light.
 *
 * Mutates `state.spaceId` and `state.shareId`.
 */
export function registerLocalSpacePhase(state: QuicTestState): void {
  const { spaceName, contactLabel, shareName, shareLocalPath } = QUIC_CONSTANTS;

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5 — Create local space on Vault A via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("create local space on Vault A via UI", async () => {
    state.spaceId = await createLocalSpaceViaUI(state.vaultA!, spaceName);
    expect(state.spaceId).toBeTruthy();
    console.log(`[QUIC] Space created: ${state.spaceId.slice(0, 8)}…`);
  });

  test("ensure Vault A device is registered in space", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;

    // The UI might auto-register the device; if not, do it manually.
    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    if (!devices.some((d) => d.endpoint_id === nodeIdA)) {
      const ownDeviceRows = await sqlQuery<{ id: string }>(
        vaultA,
        "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
        [nodeIdA],
      );
      expect(ownDeviceRows.length).toBe(1);
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        params: [crypto.randomUUID(), spaceId, ownDeviceRows[0].id, nodeIdA, "Vault A Desktop", "desktop", identityA.did],
      });
    }

    const updated = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_space_devices WHERE space_id = ?1",
      [spaceId],
    );
    expect(updated.some((d) => d.endpoint_id === nodeIdA)).toBe(true);

    // No stale-data cleanup — test expects fresh vault containers.

    // Start leader for the newly created space on Vault A
    try {
      await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
      console.log(`[QUIC] Started leader for space ${spaceId.slice(0, 8)}…`);
    } catch { /* already running */ }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5b — Vault A attaches a peer share BEFORE inviting Vault B
  //
  // This models the real-world flow: the space owner adds a folder/file,
  // then invites a collaborator. The invitee should see the share after
  // accepting the invite (known open bug — see
  // haex-vault/.claude/plans/share-visibility-after-accept.md).
  //
  // We bypass the OS file picker (unreachable from WebDriver) by writing the
  // row directly via `sql_execute_with_crdt`. This uses the same code path
  // as `peerStorageStore.addShareAsync`, so CRDT triggers fire identically.
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault A attaches a folder share to the space before inviting", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;

    state.shareId = crypto.randomUUID();
    // device_id must be the real haex_devices.id for Vault A's own device
    // (Phase 2 FK + UNIQUE(endpoint_id) — a random UUID would make the
    // ensure-refs trigger collide on the existing own row's endpoint_id).
    const ownDeviceRows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      [nodeIdA],
    );
    expect(ownDeviceRows.length).toBe(1);

    // The share folder MUST exist on disk before the row is attached:
    // when Vault B accepts, its device row syncs to Vault A and triggers
    // `peer_storage_reload_shares`, whose `reload_state_from_db` skips any
    // share whose `local_path` is missing on disk. A share attached to a
    // not-yet-created folder would silently drop out of Vault A's in-memory
    // `shares` map and never be served — root listing on B comes back empty.
    // (The working peer-connectivity spec creates its folder first for the
    // same reason; Phase 5 only adds a marker file inside this folder.)
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: shareLocalPath });

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares
              (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [state.shareId, spaceId, ownDeviceRows[0].id, nodeIdA, shareName, shareLocalPath, identityA.did],
    });

    // Mirror `peerStorageStore.addShareAsync`, which calls
    // peer_storage_reload_shares after the insert. The raw-SQL path above
    // fires the CRDT triggers but NOT this reload, so without it Vault A's
    // in-memory `shares` map wouldn't pick up the new share until the next
    // incidental reload — leaving the leader unable to serve it.
    await vaultA.invokeTauriCommand("peer_storage_reload_shares");

    const rows = await sqlQuery<{ id: string; name: string; endpoint_id: string }>(
      vaultA,
      "SELECT id, name, endpoint_id FROM haex_peer_shares WHERE space_id = ?1",
      [spaceId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.id === state.shareId && r.name === shareName && r.endpoint_id === nodeIdA))
      .toBe(true);
    console.log(`[QUIC] Share attached on Vault A: id=${state.shareId.slice(0, 8)}… name="${shareName}"`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 6 — Send invite from A → B via SpaceInviteDialog
  // ═══════════════════════════════════════════════════════════════════════════

  test("send invite from Vault A to Vault B via UI", async () => {
    await sendInviteViaUI(state.vaultA!, spaceName, contactLabel);

    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          state.vaultB!,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [state.spaceId!],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, interval: 2_000, label: "invite delivery to Vault B" },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 7 — Verify pending invite is visible in Vault B's Spaces UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B shows pending invite in Spaces UI", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;
    await openSettingsCategory(vaultB, "spaces");
    await wait(1000);

    // Hard-fail the UI check: previously this was wrapped in `.catch(() => false)`
    // which silently swallowed rendering regressions (e.g. the listener plugin
    // not reloading the spaces store, or the SpaceDetail component skipping
    // pending-invite cards for already-active space IDs). A DB row that's
    // invisible to the user is the exact bug this suite must catch.
    await pollUntil(
      () => vaultB.executeScript<boolean>(`
        const items = [...document.querySelectorAll('[class*="rounded-lg"]')];
        return items.some(el =>
          el.textContent?.includes(${JSON.stringify(spaceName)})
          && (el.textContent?.includes('Pending') || el.textContent?.includes('Ausstehend')
              || el.className?.includes('dashed'))
        );
      `),
      { timeout: 10_000, label: "pending invite visible in UI" },
    );

    // Also verify via DB (use only columns guaranteed to exist across migrations)
    const invites = await sqlQuery<{
      id: string; space_id: string; inviter_did: string; capabilities: string; status: string;
    }>(
      vaultB,
      `SELECT id, space_id, inviter_did, capabilities, status
       FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThanOrEqual(1);
    expect(invites[0].space_id).toBe(spaceId);
    expect(invites[0].inviter_did).toBe(state.identityA!.did);
    expect(invites[0].status).toBe("pending");
  });

  test("Vault B space entry depends on invite handling strategy", async () => {
    // After receiving a PushInvite, Vault B may or may not create a space entry.
    // The handler might create a placeholder space for the pending invite.
    // We just verify the pending invite exists and is in 'pending' status.
    const invites = await sqlQuery<{ status: string }>(
      state.vaultB!,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1`,
      [state.spaceId!],
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites.some((i) => i.status === "pending")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 8 — Decline the first invite via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("decline invite on Vault B via UI", async () => {
    const spaceId = state.spaceId!;
    await declineInviteViaUI(state.vaultB!, spaceName, spaceId);

    // Verify: no more pending invites for this space
    const remaining = await sqlQuery<{ id: string }>(
      state.vaultB!,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(remaining.length).toBe(0);
  });

  test("Vault A space is still active after B declined", async () => {
    const spaces = await sqlQuery<{ id: string; status: string; name: string }>(
      state.vaultA!,
      `SELECT id, status, name FROM haex_spaces WHERE id = ?1`,
      [state.spaceId!],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].status).toBe("active");
    expect(spaces[0].name).toBe(spaceName);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 9 — Send second invite (with write capability) and accept
  // ═══════════════════════════════════════════════════════════════════════════

  test("send second invite with write capability via UI", async () => {
    const spaceId = state.spaceId!;
    await sendInviteViaUI(state.vaultA!, spaceName, contactLabel, true);

    // Wait for arrival on Vault B
    await pollUntil(
      async () => {
        const invites = await sqlQuery<{ id: string }>(
          state.vaultB!,
          `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
          [spaceId],
        );
        return invites.length > 0;
      },
      { timeout: 60_000, label: "second invite delivery" },
    );

    // Verify capabilities include both read and write
    const invites = await sqlQuery<{ capabilities: string }>(
      state.vaultB!,
      `SELECT capabilities FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBe(1);
    const caps = JSON.parse(invites[0].capabilities);
    expect(caps).toContain("space/read");
    expect(caps).toContain("space/write");
  });

  test("accept invite on Vault B via UI", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;

    // Flake-B state snapshot: diff against the stable sibling test at line
    // 1050 ("accept Personal space invite on Vault B"). Differences in
    // pending-invite counts, leftover MLS welcomes, or space-member rows
    // point to distinct fixes (selector ambiguity vs. welcome race vs.
    // pure timing). See docs/plans/2026-04-20-fix-e2e-flakes.md in haex-vault.
    const pending = await sqlQuery<{ id: string; space_id: string; status: string; space_name: string }>(
      vaultB,
      `SELECT id, space_id, status, space_name FROM haex_pending_invites ORDER BY created_at DESC LIMIT 10`,
    );
    const mlsWelcomes = await sqlQuery<{ id: string; space_id: string; source: string }>(
      vaultB,
      `SELECT id, space_id, source FROM haex_mls_pending_welcomes_no_sync`,
    );
    const members = await sqlQuery<{ space_id: string; identity_id: string }>(
      vaultB,
      `SELECT space_id, identity_id FROM haex_space_members`,
    );
    console.log(`[FLAKE-B] pending=${JSON.stringify(pending.map(p => ({ id: p.id.slice(0, 8), sp: p.space_id.slice(0, 8), st: p.status, n: p.space_name })))}`);
    console.log(`[FLAKE-B] mls_welcomes=${mlsWelcomes.length} members=${members.length}`);

    await acceptInviteViaUI(vaultB, spaceName, spaceId);

    // Verify: invite status changed to 'accepted'
    const invites = await sqlQuery<{ status: string }>(
      vaultB,
      `SELECT status FROM haex_pending_invites WHERE space_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId],
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].status).toBe("accepted");
  });

  test("accepted space exists on Vault B with status active", async () => {
    // This is the critical test: after accepting a QUIC invite, a real space
    // entry must exist in haex_spaces. If acceptLocalInviteAsync only does
    // UPDATE without INSERT, this fails — which is exactly the bug we found.
    const spaceId = state.spaceId!;
    const spaces = await sqlQuery<{ id: string; status: string; name: string; type: string }>(
      state.vaultB!,
      `SELECT id, status, name, type FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spaces.length).toBe(1);
    expect(spaces[0].id).toBe(spaceId);
    expect(spaces[0].status).toBe("active");
    expect(spaces[0].name).toBe(spaceName);
    expect(spaces[0].type).toBe("local");
    console.log(`[QUIC] Space on Vault B after accept: id=${spaces[0].id.slice(0, 8)}… status=${spaces[0].status}`);
  });
}
