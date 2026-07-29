/**
 * Shared-space delete-propagation: unshare-keeps-row invariant.
 *
 * ADR-0002 §6.5 — Absent-register semantics (C4 fix in haex-vault PR #738).
 *
 * Scenario:
 *   Peer A originally shared row R into SPACE_X. Peer A then unshared it
 *   (locally deleted the register entry). The register-DELETE propagated
 *   to peer B and, via the fanout trigger, generated a delete-log entry
 *   for `(T, R, SPACE_X)`. Peer B receives this delete-log entry AFTER
 *   its own register for R is already gone (the register-DELETE arrived
 *   first — or peer B was never in any space that registered R).
 *
 * Correct behavior (post-#738):
 *   The receiver's positive register-gate sees NO register anywhere for
 *   `(T, R, *)` — classified as `unshareRace`. The business row survives.
 *   Rationale: unshare removes the SHARING, not the row itself (per ADR
 *   §6.5). An unshare must NEVER hard-delete a peer's local copy of a
 *   row they still have visible via the extension.
 *
 * Pre-fix behavior (would-have-been-broken):
 *   Without the positive gate, receiver applied the delete-log
 *   unconditionally and deleted peer B's business row. This lost data
 *   on every unshare round-trip.
 *
 * Verify-red obligation:
 *   To confirm this spec captures the bug, rebuild the vault at
 *   `HAEX_VAULT_REF=e0a6e8b2` (pre-C4-fix per
 *   `docs/plans/2026-07-29-shared-space-delete-propagation-coverage.md`
 *   §Verify-red obligation), rerun this spec — the business-row assertion
 *   should FAIL (row was deleted). Then rebuild against `develop` (or the
 *   PR #738 merge commit `ace9eeff`), assertion passes.
 *
 * Driver:
 *   Uses the feature-gated Tauri command `test_seed_shared_space_delete_log_entry`
 *   from haex-vault PR #739. Single vault: the "delete-log arrives with no
 *   local register" state is modeled by inserting only the business row
 *   and skipping the register-INSERT step, then calling the seed hook.
 */

import { test, expect, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import {
  ensureStubExtensionTable,
  insertBusinessRow,
  deleteBusinessRow,
  businessRowExists,
  deleteRegisterRowsAllSpaces,
  queryRegisterRow,
  seedSharedSpaceDeleteLogEntry,
  expectOutcome,
  rowPksJsonForId,
  STUB_EXT_TABLE,
} from "../helpers/shared-space-delete-fixtures";

test.describe("sync: shared-space unshare keeps row (delete-log with no local register)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  test.setTimeout(60_000);

  let vault: VaultAutomation;

  const SPACE_X = "space-x-unshare-race";

  const rowId = "unshare-race-row-a";
  const rowPksJson = rowPksJsonForId(rowId);

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    await initializeVaultViaUI(vault, "Delete Propagation Test", "test-pw");

    await ensureStubExtensionTable(vault);

    // Best-effort cleanup from prior runs.
    await deleteBusinessRow(vault, rowId);
    await deleteRegisterRowsAllSpaces(vault, {
      tableName: STUB_EXT_TABLE,
      rowPksJson,
    });
  });

  test("business row survives when delete-log arrives with no local register", async () => {
    // Setup: business row exists locally. NO register entry — the
    // register-DELETE from the unshare has already propagated
    // ("absent register" state).
    await insertBusinessRow(vault, { id: rowId, body: "peer B's row" });

    // Sanity: business row present, no register anywhere.
    expect(await businessRowExists(vault, rowId)).toBe(true);
    expect(
      await queryRegisterRow(vault, {
        spaceId: SPACE_X,
        tableName: STUB_EXT_TABLE,
        rowPksJson,
      }),
    ).toBeNull();

    // Receive the follow-on delete-log entry emitted by the unshare
    // fanout trigger. runPropagation=true drives the gate immediately.
    const report = await seedSharedSpaceDeleteLogEntry(vault, {
      spaceId: SPACE_X,
      tableName: STUB_EXT_TABLE,
      rowPksJson,
      hlc: "20/former-owner",
      runPropagation: true,
    });

    // Assertion 1: the gate classifies as UnshareRace (absent-register
    // path). Pre-fix vaults ran the DELETE without this gate and produced
    // AppliedFullDelete — either the outcome mismatch OR the business-row
    // assertion would fail on the regression.
    expectOutcome(report, "unshareRace");

    // Assertion 2: business row survives (the invariant this spec guards).
    expect(report.after.businessRowExists).toBe(true);
    expect(await businessRowExists(vault, rowId)).toBe(true);

    // Assertion 3: register still absent (nothing to clean up).
    expect(report.before.anySpaceRegistered).toBe(false);
    expect(report.after.anySpaceRegistered).toBe(false);
    expect(
      await queryRegisterRow(vault, {
        spaceId: SPACE_X,
        tableName: STUB_EXT_TABLE,
        rowPksJson,
      }),
    ).toBeNull();
  });

  test.afterAll(async () => {
    if (!vault) return;
    try {
      await deleteBusinessRow(vault, rowId);
    } catch {
      /* best effort */
    }
  });
});
