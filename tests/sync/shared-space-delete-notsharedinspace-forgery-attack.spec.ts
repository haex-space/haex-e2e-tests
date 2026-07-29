/**
 * Shared-space delete-propagation: NotSharedInSpace forgery attack.
 *
 * ADR-0002 §6.5 — Positive register-gate (C4 fix in haex-vault PR #738).
 *
 * Threat model:
 *   Attacker (member of SPACE_X) crafts a shared-space delete-log entry
 *   for a row R that the victim actually shares in SPACE_Y — but NOT in
 *   SPACE_X. Attacker's message claims `(table=T, row_pks=R, space=SPACE_X)`.
 *
 * Correct behavior (post-#738):
 *   Receiver's positive register-gate lookup for `(T, R, SPACE_X)` returns
 *   *no register entry*. The fallback lookup `(T, R, *)` finds a register
 *   entry in SPACE_Y → classified as `notSharedInSpaceForgery`. Business
 *   row R is NOT deleted; SPACE_Y register entry is untouched.
 *
 * Pre-fix behavior (would-have-been-vulnerable):
 *   Without the positive gate, the receiver applied the delete-log
 *   unconditionally, deleting the business row and (via cascade) any
 *   remaining register entries.
 *
 * Verify-red obligation:
 *   To confirm this spec captures the bug, rebuild the vault at
 *   `HAEX_VAULT_REF=e0a6e8b2` (pre-C4-fix per the shipped-plan doc
 *   `docs/plans/2026-07-29-shared-space-delete-propagation-coverage.md`
 *   §Verify-red obligation), rerun this spec — the business-row assertion
 *   should FAIL (row was deleted). Then rebuild against `develop` (or the
 *   PR #738 merge commit `ace9eeff`), the assertion passes.
 *
 * Driver:
 *   Uses the feature-gated Tauri command `test_seed_shared_space_delete_log_entry`
 *   from haex-vault PR #739 (only available when the Docker vault image is
 *   built with `--features e2e-hooks`; see haex-e2e-tests docker/Dockerfile).
 *   No P2P, no sync-server — the attacker's delete-log is injected directly
 *   into the vault's apply-path.
 */

import { test, expect, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import {
  ensureStubExtensionTable,
  insertBusinessRow,
  deleteBusinessRow,
  businessRowExists,
  insertRegisterRow,
  deleteRegisterRowsAllSpaces,
  queryRegisterRow,
  seedSharedSpaceDeleteLogEntry,
  expectOutcome,
  rowPksJsonForId,
  STUB_EXT_TABLE,
} from "../helpers/shared-space-delete-fixtures";

test.describe("sync: shared-space delete NotSharedInSpace forgery attack", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  test.setTimeout(60_000);

  let vault: VaultAutomation;

  // Two distinct space ids for the test — SPACE_Y is where the victim
  // actually shares row R; SPACE_X is what the attacker's crafted
  // delete-log claims (the forgery axis).
  const SPACE_Y = "space-y-victim-real";
  const SPACE_X = "space-x-attacker-claim";

  // Unique per-suite row id + register id so the spec is idempotent
  // across reruns on the same persistent vault. If left over from a
  // previous run they get cleaned in beforeAll.
  const rowId = "notshared-forgery-row-a";
  const rowPksJson = rowPksJsonForId(rowId);
  const registerIdY = "notshared-forgery-reg-y";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    await initializeVaultViaUI(vault, "Delete Propagation Test", "test-pw");

    // Ensure the stub-extension business table exists on this vault.
    await ensureStubExtensionTable(vault);

    // Best-effort cleanup of any residual state from a prior run.
    await deleteBusinessRow(vault, rowId);
    await deleteRegisterRowsAllSpaces(vault, {
      tableName: STUB_EXT_TABLE,
      rowPksJson,
    });
  });

  test("business row survives + SPACE_Y register untouched under forged SPACE_X delete", async () => {
    // Setup: victim shares row R in SPACE_Y only.
    await insertBusinessRow(vault, { id: rowId, body: "victim's row" });
    await insertRegisterRow(vault, {
      registerId: registerIdY,
      spaceId: SPACE_Y,
      tableName: STUB_EXT_TABLE,
      rowPksJson,
      haexHlc: "10/victim",
    });

    // Sanity: before the attack, the row exists locally and the SPACE_Y
    // register is present.
    expect(await businessRowExists(vault, rowId)).toBe(true);
    expect(
      await queryRegisterRow(vault, {
        spaceId: SPACE_Y,
        tableName: STUB_EXT_TABLE,
        rowPksJson,
      }),
    ).not.toBeNull();

    // Attack: attacker (a member of SPACE_X) seeds a delete-log entry
    // claiming (T, R, SPACE_X). runPropagation=true drives the vault's
    // register-gate immediately so the assertion observes the gate
    // decision, not a queued state.
    const report = await seedSharedSpaceDeleteLogEntry(vault, {
      spaceId: SPACE_X,
      tableName: STUB_EXT_TABLE,
      rowPksJson,
      hlc: "20/attacker",
      runPropagation: true,
    });

    // Assertion 1: the gate classifies as NotSharedInSpaceForgery.
    // (Pre-fix vaults produced `appliedFullDelete` or similar and the
    // business-row assertion below caught the regression instead — but
    // asserting the outcome directly gives a much clearer failure signal
    // when the gate itself regresses.)
    expectOutcome(report, "notSharedInSpaceForgery");

    // Assertion 2: business row survives.
    expect(report.after.businessRowExists).toBe(true);
    expect(await businessRowExists(vault, rowId)).toBe(true);

    // Assertion 3: SPACE_Y register entry is intact. The gate MUST NOT
    // touch the other-space register when it declines the DELETE.
    const spaceYReg = await queryRegisterRow(vault, {
      spaceId: SPACE_Y,
      tableName: STUB_EXT_TABLE,
      rowPksJson,
    });
    expect(spaceYReg).not.toBeNull();
    expect(spaceYReg?.id).toBe(registerIdY);

    // Assertion 4: snapshot report matches — before had (any=true,
    // target=false), after unchanged.
    expect(report.before.targetSpaceRegistered).toBe(false);
    expect(report.before.anySpaceRegistered).toBe(true);
    expect(report.before.businessRowExists).toBe(true);
    expect(report.after.targetSpaceRegistered).toBe(false);
    expect(report.after.anySpaceRegistered).toBe(true);
  });

  test.afterAll(async () => {
    if (!vault) return;
    try {
      await deleteBusinessRow(vault, rowId);
    } catch {
      /* best effort */
    }
    try {
      await deleteRegisterRowsAllSpaces(vault, {
        tableName: STUB_EXT_TABLE,
        rowPksJson,
      });
    } catch {
      /* best effort */
    }
  });
});
