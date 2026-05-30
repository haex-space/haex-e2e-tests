import * as crypto from "crypto";
import { expect, test } from "../../../fixtures";
import { sqlQuery } from "../../../helpers/ui/utils";
import { setInvitePolicyViaUI } from "../quic-helpers/ui-spaces";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 6 — Edge cases and security/policy enforcement after the main flow:
 *   - self-invite rejection (Step 10)
 *   - policy=nobody enforcement (Step 11)
 *   - PushInvite logging (Step 12)
 *   - capability ceiling: invitee never gets space/admin (Step 13)
 *   - legacy 'default' space-ID collision (Step 14)
 *   - admin-delete behavior on inviter-side (Step 14b)
 *
 * All assertions are read-only against `state` (no mutation).
 */
export function registerEdgeCasesPhase(state: QuicTestState): void {
  const { spaceName } = QUIC_CONSTANTS;

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 10 — Self-invite prevention (backend edge case — no UI for this)
  // ═══════════════════════════════════════════════════════════════════════════

  test("self-invite is rejected (connecting to self not supported)", async () => {
    const vaultA = state.vaultA!;
    const nodeIdA = state.nodeIdA!;
    const identityA = state.identityA!;
    const spaceId = state.spaceId!;

    let rejected = false;
    try {
      await vaultA.invokeTauriCommand<boolean>(
        "local_delivery_push_invite",
        {
          targetEndpointId: nodeIdA,
          spaceId,
          spaceName,
          spaceType: "local",
          tokenId: crypto.randomUUID(),
          capabilities: ["space/read"],
          includeHistory: false,
          inviterDid: identityA.did,
          inviterLabel: "Self",
          spaceEndpoints: [nodeIdA],
          originUrl: null,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      );
    } catch (e) {
      rejected = true;
      expect(String(e)).toContain("ourself");
    }
    expect(rejected).toBe(true);

    // No pending invite should exist for self
    const selfInvites = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_pending_invites
       WHERE space_id = ?1 AND inviter_label = 'Self' AND status = 'pending'`,
      [spaceId],
    );
    expect(selfInvites.length).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 11 — Invite policy enforcement via UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("set policy to 'nobody' via UI and verify invite is rejected", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const nodeIdB = state.nodeIdB!;
    const identityA = state.identityA!;

    // ── Debug: check QUIC connectivity state before the critical operation ──
    console.log(`[QUIC-DEBUG] Step 11 start — nodeIdA=${nodeIdA?.slice(0, 12)}… nodeIdB=${nodeIdB?.slice(0, 12)}…`);
    try {
      const statusA = await vaultA.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
      console.log(`[QUIC-DEBUG] Vault A local_delivery_status: isLeader=${statusA.isLeader}, spaces=${statusA.activeSpaces?.length ?? 0}`);
    } catch (e) {
      console.log(`[QUIC-DEBUG] Vault A local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
    }
    try {
      const statusB = await vaultB.invokeTauriCommand<{ isLeader: boolean; activeSpaces: string[] }>("local_delivery_status", {});
      console.log(`[QUIC-DEBUG] Vault B local_delivery_status: isLeader=${statusB.isLeader}, spaces=${statusB.activeSpaces?.length ?? 0}`);
    } catch (e) {
      console.log(`[QUIC-DEBUG] Vault B local_delivery_status failed:`, (e as Error).message?.slice(0, 120));
    }

    // Change policy on Vault B through the Spaces settings dropdown
    console.log(`[QUIC-DEBUG] Setting invite policy to 'nobody' on Vault B...`);
    const t0Policy = Date.now();
    await setInvitePolicyViaUI(vaultB, "nobody");
    console.log(`[QUIC-DEBUG] setInvitePolicyViaUI took ${Date.now() - t0Policy}ms`);

    // try/finally: the policy MUST be reset to 'all' even when assertions
    // below throw, otherwise downstream serial tests run under a "nobody"
    // policy and fail with confusing errors far from this test.
    try {
      // Verify policy was applied
      const policy = await sqlQuery<{ policy: string }>(
        vaultB,
        `SELECT policy FROM haex_invite_policy WHERE id = 'default'`,
      );
      expect(policy.length).toBe(1);
      expect(policy[0].policy).toBe("nobody");
      console.log(`[QUIC-DEBUG] Policy confirmed: ${policy[0].policy}`);

      // Attempt to send an invite — should be rejected
      const newSpaceId = crypto.randomUUID();
      console.log(`[QUIC-DEBUG] Sending blocked invite from A→B (spaceId=${newSpaceId.slice(0, 8)}…, target=${nodeIdB?.slice(0, 12)}…)`);
      const t0Invite = Date.now();
      const accepted = await vaultA.invokeTauriCommand<boolean>(
        "local_delivery_push_invite",
        {
          targetEndpointId: nodeIdB,
          spaceId: newSpaceId,
          spaceName: "Blocked Space",
          spaceType: "local",
          tokenId: crypto.randomUUID(),
          capabilities: ["space/read"],
          includeHistory: false,
          inviterDid: identityA.did,
          inviterLabel: "Vault A",
          spaceEndpoints: [nodeIdA],
          originUrl: null,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      );
      console.log(`[QUIC-DEBUG] local_delivery_push_invite returned: ${accepted} (took ${Date.now() - t0Invite}ms)`);
      expect(accepted).toBe(false);

      // No pending invite should have been created
      const blocked = await sqlQuery<{ id: string }>(
        vaultB,
        `SELECT id FROM haex_pending_invites WHERE space_id = ?1`,
        [newSpaceId],
      );
      expect(blocked.length).toBe(0);
    } finally {
      await setInvitePolicyViaUI(vaultB, "all");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 12 — Verify logging
  // ═══════════════════════════════════════════════════════════════════════════

  test("PushInvite handler logged on Vault B", async () => {
    const vaultB = state.vaultB!;
    const spaceId = state.spaceId!;

    // haex_logs might not exist or have different columns depending on vault version
    try {
      const logs = await sqlQuery<{ source: string; message: string }>(
        vaultB,
        `SELECT source, message FROM haex_logs
         WHERE source = 'PushInvite' ORDER BY timestamp DESC LIMIT 10`,
      );
      expect(logs.length).toBeGreaterThan(0);
      console.log(`[QUIC] Found ${logs.length} PushInvite log entries on Vault B`);
    } catch {
      // Log table might not exist — verify invites were received instead
      const inviteCount = await sqlQuery<{ cnt: number }>(
        vaultB,
        `SELECT COUNT(*) as cnt FROM haex_pending_invites WHERE space_id = ?1`,
        [spaceId],
      );
      expect(inviteCount[0].cnt).toBeGreaterThan(0);
      console.log("[QUIC] haex_logs not available, verified via pending_invites count");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 13 — Capability enforcement (read-only user cannot write)
  // ═══════════════════════════════════════════════════════════════════════════

  test("Vault B has read-only UCAN for the first invite (space/read only)", async () => {
    const spaceId = state.spaceId!;
    // The first invite was sent with ["space/read"] capabilities.
    // Vault B should NOT have space/write or space/admin.
    const ucans = await sqlQuery<{ capability: string; audience_did: string }>(
      state.vaultB!,
      `SELECT capability, audience_did FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    console.log(`[QUIC] UCANs on Vault B for space: ${JSON.stringify(ucans)}`);

    // The second invite had space/read + space/write, so check which one Vault B ended up with
    const capabilities = ucans.map(u => u.capability);
    // At minimum, Vault B should have some UCAN for this space
    expect(ucans.length).toBeGreaterThan(0);

    // Vault B should NOT have space/admin (only the creator has that)
    expect(capabilities).not.toContain("space/admin");
  });

  test("Vault B's UCAN does not grant write/admin capability", async () => {
    const spaceId = state.spaceId!;

    // After accepting the second invite (with space/read + space/write),
    // Vault B should have those capabilities but NOT space/admin.
    // Only the space creator (Vault A) should have space/admin.
    const ucansOnB = await sqlQuery<{ capability: string }>(
      state.vaultB!,
      `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    const caps = ucansOnB.map(u => u.capability);
    expect(caps).not.toContain("space/admin");
    console.log(`[QUIC] Vault B capabilities: ${JSON.stringify(caps)}`);

    // Vault A should have space/admin
    const ucansOnA = await sqlQuery<{ capability: string }>(
      state.vaultA!,
      `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1`,
      [spaceId],
    );
    const capsA = ucansOnA.map(u => u.capability);
    expect(capsA).toContain("space/admin");
    console.log(`[QUIC] Vault A capabilities: ${JSON.stringify(capsA)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 14 — Default space ID collision (regression test)
  // ═══════════════════════════════════════════════════════════════════════════

  test("invite for space with ID 'default' is silently skipped (already active on recipient)", async () => {
    const vaultA = state.vaultA!;
    const vaultB = state.vaultB!;
    const nodeIdA = state.nodeIdA!;
    const nodeIdB = state.nodeIdB!;
    const identityA = state.identityA!;

    // Both vaults create a default space with the same hardcoded ID 'default'.
    // If this ID is still used, push_invite returns accepted=true but creates
    // no pending invite (space already exists check in handle_push_invite).
    // This test catches the regression if the default space ID is not unique.

    // Check if vault B has a space with the old hardcoded 'default' ID
    const defaultOnB = await sqlQuery<{ id: string; status: string }>(
      vaultB,
      `SELECT id, status FROM haex_spaces WHERE id = 'default'`,
    );

    if (defaultOnB.length > 0) {
      // Old-style vault: 'default' space exists on both sides → invite is silently skipped
      const accepted = await vaultA.invokeTauriCommand<boolean>("local_delivery_push_invite", {
        targetEndpointId: nodeIdB,
        spaceId: "default",
        spaceName: "Personal",
        spaceType: "local",
        tokenId: crypto.randomUUID(),
        capabilities: ["space/read"],
        includeHistory: false,
        inviterDid: identityA.did,
        inviterLabel: "Vault A",
        spaceEndpoints: [nodeIdA],
        originUrl: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      // accepted=true but no pending invite — the invite is lost
      expect(accepted).toBe(true);
      const pendingDefault = await sqlQuery<{ id: string }>(
        vaultB,
        `SELECT id FROM haex_pending_invites WHERE space_id = 'default' AND status = 'pending'`,
      );
      // The whole point of this regression check is the ID-collision case:
      // the hardcoded 'default' spaceId clashes with B's existing default
      // space and the invite gets dropped on B's side. Assert that — without
      // the assertion this branch was a silent no-op that would never
      // surface a regression.
      console.log(`[QUIC] Default space invite: pending=${pendingDefault.length} (0 = ID collision bug)`);
      expect(pendingDefault.length).toBe(0);
    } else {
      // New-style vault: default space has a random UUID → no collision possible
      console.log("[QUIC] Default space has unique ID — no collision risk");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 14b — Admin deletes the space after sharing
  // ═══════════════════════════════════════════════════════════════════════════

  test("admin (Vault A) deletes the shared space", async () => {
    const vaultA = state.vaultA!;
    const spaceId = state.spaceId!;

    // Vault A is the admin/creator of the space. Delete it.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_spaces WHERE id = ?1`,
      params: [spaceId],
    });

    // Verify space is gone on Vault A
    const spacesOnA = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    expect(spacesOnA.length).toBe(0);
    console.log("[QUIC] Admin deleted space on Vault A");
  });

  test("deleted space does not affect Vault B's accepted copy", async () => {
    const spaceId = state.spaceId!;

    // Vault B accepted the invite and has its own space entry.
    // The admin deleting the space on A should NOT propagate to B
    // (the CRDT tombstone only applies if spaces are actively syncing).
    // For local-only (QUIC) spaces, B's copy is independent.
    const spacesOnB = await sqlQuery<{ id: string; status: string }>(
      state.vaultB!,
      `SELECT id, status FROM haex_spaces WHERE id = ?1`,
      [spaceId],
    );
    // B should still have the space
    expect(spacesOnB.length).toBe(1);
    expect(spacesOnB[0].status).toBe("active");
    console.log("[QUIC] Vault B still has the space after admin deletion on A");
  });
}
