// Fixtures for shared-space delete-propagation e2e specs.
//
// These specs drive the vault's *local* apply-loop for shared-space delete
// signals via the feature-gated Tauri command `test_seed_shared_space_delete_log_entry`
// (haex-vault src-tauri/src/crdt/commands/apply/e2e_hooks.rs, gated behind
// `--features e2e-hooks`; the Docker vault build passes this flag).
//
// The seed hook exercises the vault's register-check gate (C4 positive gate)
// and the resurrection-suppression check for a single vault in isolation —
// no P2P, no sync-server, no multi-peer setup is required. The forger, the
// unshare, the legit push, etc. are all modeled by the DB state we place
// *on this vault* before calling the hook.
//
// Task 1a (cross-space shadow-map suppression) is NOT covered by this
// helper: it requires the real apply-loop (`apply_remote_changes_to_db`)
// to build a shadow-map from multiple concurrent events, which the seed
// hook does not exercise. That task needs a different driver.

import type { VaultAutomation } from "../fixtures";
import { sqlQuery } from "./ui/utils";

// ============================================================================
// Types — mirror the vault's ts-rs bindings for `TestSeedDeleteLogReport` etc.
// Source: haex-vault/src-tauri/bindings/{TestSeedDeleteLogReport,
// TestPropagationOutcome, TestSharedSpaceRowSnapshot}.ts
// Kept inline to avoid a build-time dependency on the vault repo.
// ============================================================================

export type TestSharedSpaceRowSnapshot = {
  targetSpaceRegistered: boolean;
  anySpaceRegistered: boolean;
  businessRowExists: boolean;
};

export type TestPropagationOutcome =
  | { kind: "notRun" }
  | { kind: "appliedFullDelete" }
  | { kind: "appliedRegisterOnly" }
  | { kind: "notSharedInSpaceForgery" }
  | { kind: "unshareRace" }
  | { kind: "resurrectionSuppressed" }
  | { kind: "unknown" };

export type TestSeedDeleteLogReport = {
  deleteLogId: string;
  propagated: boolean;
  outcome: TestPropagationOutcome;
  before: TestSharedSpaceRowSnapshot;
  after: TestSharedSpaceRowSnapshot;
};

// ============================================================================
// The stub-extension business table.
//
// A dedicated, isolated table so specs never clash with real extension data.
// PK is a single TEXT column named `id` — that keeps the canonical row_pks
// JSON encoding trivial (`{"id":"<row-id>"}`). Composite PKs would require
// PK-definition-order iteration; not needed here.
// ============================================================================

export const STUB_EXT_TABLE = "ext_e2e_delete_propagation";

/** Canonical row_pks_json for a single-column TEXT PK named `id`.
 *
 * Matches the vault-side writer contract (SQLite `json_object('id', OLD."id")`
 * → `{"id":"<value>"}`, no whitespace, PK-definition order). See haex-vault
 * src-tauri/src/crdt/trigger.rs L610-621. `JSON.stringify` with no `space`
 * argument produces the same byte sequence for TEXT PKs.
 */
export function rowPksJsonForId(id: string): string {
  return JSON.stringify({ id });
}

// ============================================================================
// Setup — create the stub-extension business table.
// Idempotent (safe to call multiple times per vault).
// ============================================================================

/** Ensure the stub-extension table exists on this vault.
 *
 * Uses `sql_execute` (raw, non-CRDT) because CREATE TABLE is a DDL statement
 * and does not need CRDT plumbing. The seed hook + propagate function read
 * the business row via a plain SELECT; they don't require CRDT triggers on
 * this table.
 */
export async function ensureStubExtensionTable(vault: VaultAutomation): Promise<void> {
  await vault.invokeTauriCommand("sql_execute", {
    sql: `CREATE TABLE IF NOT EXISTS ${STUB_EXT_TABLE} (
      id TEXT PRIMARY KEY NOT NULL,
      body TEXT,
      haex_hlc TEXT
    )`,
    params: [],
  });
}

// ============================================================================
// Business-row helpers.
// ============================================================================

export type SeedBusinessRowArgs = {
  id: string;
  body?: string;
  /** Empty string keeps the row absent from `derive_outcome`'s resurrection
   * check (which only fires when the row's HLC is *newer* than the delete
   * HLC). Provide a specific HLC for `ResurrectionSuppressed` tests. */
  haexHlc?: string;
};

/** INSERT a stub-extension business row.
 *
 * Uses `sql_execute` (raw, non-CRDT). If a row with the same id already
 * exists, the INSERT fails; specs should choose fresh row-ids per test.
 */
export async function insertBusinessRow(
  vault: VaultAutomation,
  args: SeedBusinessRowArgs,
): Promise<void> {
  await vault.invokeTauriCommand("sql_execute", {
    sql: `INSERT INTO ${STUB_EXT_TABLE} (id, body, haex_hlc) VALUES (?1, ?2, ?3)`,
    params: [args.id, args.body ?? "hello", args.haexHlc ?? "1/aaa"],
  });
}

/** DELETE a stub-extension business row (best-effort cleanup helper). */
export async function deleteBusinessRow(
  vault: VaultAutomation,
  id: string,
): Promise<void> {
  await vault.invokeTauriCommand("sql_execute", {
    sql: `DELETE FROM ${STUB_EXT_TABLE} WHERE id = ?1`,
    params: [id],
  });
}

/** Check whether a stub-extension business row is present. */
export async function businessRowExists(
  vault: VaultAutomation,
  id: string,
): Promise<boolean> {
  const rows = await sqlQuery<{ id: string }>(
    vault,
    `SELECT id FROM ${STUB_EXT_TABLE} WHERE id = ?1`,
    [id],
  );
  return rows.length > 0;
}

// ============================================================================
// Register helpers — INSERT / DELETE directly on `haex_shared_space_sync`.
//
// The register-cascade path in the vault (SQLite trigger) writes this table
// on business-row DELETE. For test setup we insert directly, simulating
// "this row is registered in space S from a prior legit share".
// ============================================================================

export type RegisterRow = {
  /** Unique register-row id (arbitrary; the register PK is `id`). */
  registerId: string;
  spaceId: string;
  tableName: string;
  rowPksJson: string;
  /** HLC assigned to the register entry. Not directly consulted by the
   * gate but stored so the register looks like a real one. */
  haexHlc?: string;
};

/** INSERT a register row so `(table, row_pks, space)` looks shared. */
export async function insertRegisterRow(
  vault: VaultAutomation,
  row: RegisterRow,
): Promise<void> {
  await vault.invokeTauriCommand("sql_execute", {
    sql: `INSERT INTO haex_shared_space_sync
          (id, space_id, table_name, row_pks, haex_hlc)
          VALUES (?1, ?2, ?3, ?4, ?5)`,
    params: [
      row.registerId,
      row.spaceId,
      row.tableName,
      row.rowPksJson,
      row.haexHlc ?? "1/aaa",
    ],
  });
}

/** Read the register row for `(table, row_pks, space)`; null if absent. */
export async function queryRegisterRow(
  vault: VaultAutomation,
  args: { spaceId: string; tableName: string; rowPksJson: string },
): Promise<{ id: string; space_id: string; haex_hlc: string | null } | null> {
  const rows = await sqlQuery<{
    id: string;
    space_id: string;
    haex_hlc: string | null;
  }>(
    vault,
    `SELECT id, space_id, haex_hlc FROM haex_shared_space_sync
     WHERE table_name = ?1 AND row_pks = ?2 AND space_id = ?3
     LIMIT 1`,
    [args.tableName, args.rowPksJson, args.spaceId],
  );
  return rows[0] ?? null;
}

/** DELETE all register rows for `(table, row_pks)` across all spaces
 * (cleanup helper — the fanout trigger will fire and emit delete-log
 * entries, so tests that care about the delete-log should assert *before*
 * calling this). */
export async function deleteRegisterRowsAllSpaces(
  vault: VaultAutomation,
  args: { tableName: string; rowPksJson: string },
): Promise<void> {
  await vault.invokeTauriCommand("sql_execute", {
    sql: `DELETE FROM haex_shared_space_sync
          WHERE table_name = ?1 AND row_pks = ?2`,
    params: [args.tableName, args.rowPksJson],
  });
}

// ============================================================================
// The main driver — feature-gated Tauri command.
//
// The vault must be built with `--features e2e-hooks` (the Docker image
// carries this via haex-e2e-tests docker/Dockerfile). If the command is
// missing, invokeTauriCommand rejects with "command not found" — that
// signals the Docker image is not on the e2e-hooks-enabled build.
// ============================================================================

export type SeedDeleteLogArgs = {
  spaceId: string;
  tableName: string;
  rowPksJson: string;
  hlc: string;
  runPropagation: boolean;
};

/** Feature-gated hook — see haex-vault e2e_hooks.rs.
 *
 * Seeds one row into `haex_shared_space_deleted_rows` and, if
 * `runPropagation` is true, immediately drives
 * `propagate_shared_space_deleted_rows_to_target_tables` for that entry.
 * Returns before/after snapshots and a derived outcome.
 */
export async function seedSharedSpaceDeleteLogEntry(
  vault: VaultAutomation,
  args: SeedDeleteLogArgs,
): Promise<TestSeedDeleteLogReport> {
  return vault.invokeTauriCommand<TestSeedDeleteLogReport>(
    "test_seed_shared_space_delete_log_entry",
    args,
  );
}

// ============================================================================
// Assertion helpers.
// ============================================================================

/** Assert the outcome kind matches (readable error on mismatch). */
export function expectOutcome(
  report: TestSeedDeleteLogReport,
  expected: TestPropagationOutcome["kind"],
): void {
  const actual = report.outcome.kind;
  if (actual !== expected) {
    throw new Error(
      `Expected outcome '${expected}' but got '${actual}'.\n` +
        `Report: ${JSON.stringify(report, null, 2)}`,
    );
  }
}
