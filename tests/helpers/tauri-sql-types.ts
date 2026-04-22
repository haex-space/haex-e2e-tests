// tests/helpers/tauri-sql-types.ts
//
// TypeScript Types for Tauri SQL Commands
//
// This module provides type definitions for haex-vault's SQL commands,
// documenting their purpose, parameters, and behavior.

// =============================================================================
// Parameter and Result Types
// =============================================================================

/**
 * Valid SQL parameter types (matches rusqlite's ToSql trait)
 */
export type SqlParamValue = string | number | boolean | null;

/**
 * SQL parameters array
 */
export type SqlParams = SqlParamValue[];

/**
 * Row returned from SELECT queries - array of column values in SELECT order
 */
export type SqlRowResult = unknown[];

/**
 * Result set from SELECT queries - array of rows
 */
export type SqlSelectResult = SqlRowResult[];

/**
 * Result from non-SELECT queries (typically empty or RETURNING data)
 */
export type SqlExecuteResult = SqlSelectResult;

// =============================================================================
// Command Input Types
// =============================================================================

/**
 * Input for all SQL commands
 */
export interface SqlCommandInput {
  /** The SQL statement to execute */
  sql: string;
  /** Parameters for prepared statement placeholders (?) */
  params: SqlParams;
}

// =============================================================================
// Tauri SQL Command Definitions
// =============================================================================

/**
 * Available Tauri SQL commands with their characteristics
 *
 * Use this as a reference when choosing which command to use:
 *
 * | Command                 | CRDT Transform | Delete Semantics      | Use Case                          |
 * |------------------------|----------------|-----------------------|-----------------------------------|
 * | sql_select             | No             | N/A                   | Raw SELECT, debug, PRAGMA         |
 * | sql_execute            | No             | Physical, no logging  | Raw DDL, test cleanup             |
 * | sql_select_with_crdt   | No             | N/A                   | SELECT with CRDT read-path        |
 * | sql_execute_with_crdt  | Yes            | N/A                   | CREATE TABLE with CRDT columns    |
 * | sql_with_crdt          | Auto           | Physical + delete-log | Unified proxy for app use         |
 */
export const TAURI_SQL_COMMANDS = {
  /**
   * Raw SELECT without any CRDT transformation
   *
   * - No CRDT column transformation
   * - Use for debugging, PRAGMA queries, or direct inspection of CRDT metadata
   *
   * @example
   * ```typescript
   * // Inspect HLC metadata
   * await vault.invokeTauriCommand("sql_select", {
   *   sql: "SELECT id, haex_hlc FROM users WHERE id = ?",
   *   params: ["user1"]
   * });
   *
   * // Run PRAGMA
   * await vault.invokeTauriCommand("sql_select", {
   *   sql: "PRAGMA table_info(users)",
   *   params: []
   * });
   * ```
   */
  SQL_SELECT: "sql_select" as const,

  /**
   * Raw execute (non-SELECT) without any CRDT transformation
   *
   * - No CRDT column additions for CREATE TABLE
   * - DELETE removes rows silently: the command transactionally flips
   *   `triggers_enabled='0'` for the duration of the operation, so the
   *   BEFORE-DELETE trigger does not fire and no row is appended to
   *   `haex_deleted_rows`. Use when the test must not produce sync traffic
   *   (e.g. cleanup, resetting fixtures).
   *
   * @example
   * ```typescript
   * // Hard delete for test cleanup
   * await vault.invokeTauriCommand("sql_execute", {
   *   sql: "DELETE FROM test_table WHERE id = ?",
   *   params: ["test-id"]
   * });
   *
   * // Create no-sync table
   * await vault.invokeTauriCommand("sql_execute", {
   *   sql: "CREATE TABLE my_table_no_sync (id TEXT PRIMARY KEY)",
   *   params: []
   * });
   * ```
   */
  SQL_EXECUTE: "sql_execute" as const,

  /**
   * SELECT through the CRDT read-path
   *
   * - Identical result shape to sql_select in the delete-log model (gelöschte
   *   Rows sind physisch weg, daher gibt es nichts zu filtern)
   * - Kept for API symmetry and potential future CRDT-aware read transformations
   *
   * @example
   * ```typescript
   * await vault.invokeTauriCommand("sql_select_with_crdt", {
   *   sql: "SELECT * FROM users",
   *   params: []
   * });
   * ```
   */
  SQL_SELECT_WITH_CRDT: "sql_select_with_crdt" as const,

  /**
   * Execute with CRDT transformation
   *
   * - CREATE TABLE: Adds CRDT columns (haex_hlc, haex_column_hlcs)
   * - Sets up BEFORE-DELETE trigger that logs deletes into haex_deleted_rows
   * - Only transforms tables without "_no_sync" suffix
   *
   * @example
   * ```typescript
   * // Create CRDT-enabled table
   * await vault.invokeTauriCommand("sql_execute_with_crdt", {
   *   sql: `CREATE TABLE users (
   *     id TEXT PRIMARY KEY NOT NULL,
   *     name TEXT NOT NULL,
   *     email TEXT
   *   )`,
   *   params: []
   * });
   * // Results in table with: id, name, email, haex_hlc, haex_column_hlcs
   * ```
   */
  SQL_EXECUTE_WITH_CRDT: "sql_execute_with_crdt" as const,

  /**
   * Unified SQL proxy with automatic CRDT handling
   *
   * Routes to appropriate handler based on statement type:
   * - SELECT: Uses sql_select_with_crdt
   * - INSERT: Adds CRDT HLC and per-column HLCs
   * - UPDATE: Updates CRDT HLC and per-column HLCs
   * - DELETE: Physically removes the row; BEFORE-DELETE trigger logs the delete
   *   into haex_deleted_rows, which is itself CRDT-synced
   * - Other (CREATE, DROP, etc.): Uses raw sql_execute (no CRDT)
   *
   * IMPORTANT: For CREATE TABLE, use sql_execute_with_crdt instead!
   * sql_with_crdt uses raw execute for DDL and won't add CRDT columns.
   *
   * @example
   * ```typescript
   * // Insert with CRDT (adds HLCs)
   * await vault.invokeTauriCommand("sql_with_crdt", {
   *   sql: "INSERT INTO users (id, name) VALUES (?, ?)",
   *   params: ["user1", "Alice"]
   * });
   *
   * // Select
   * await vault.invokeTauriCommand("sql_with_crdt", {
   *   sql: "SELECT * FROM users WHERE active = ?",
   *   params: [1]
   * });
   *
   * // Delete (physical; delete-log populated by trigger)
   * await vault.invokeTauriCommand("sql_with_crdt", {
   *   sql: "DELETE FROM users WHERE id = ?",
   *   params: ["user1"]
   * });
   * ```
   */
  SQL_WITH_CRDT: "sql_with_crdt" as const,

  /**
   * Query with CRDT (alias/variant of sql_with_crdt)
   *
   * Similar to sql_with_crdt but may have slightly different routing logic.
   * Prefer sql_with_crdt for consistency.
   */
  SQL_QUERY_WITH_CRDT: "sql_query_with_crdt" as const,
} as const;

export type TauriSqlCommand =
  (typeof TAURI_SQL_COMMANDS)[keyof typeof TAURI_SQL_COMMANDS];

// =============================================================================
// Helper Type Guards
// =============================================================================

/**
 * Check if a command is a raw (non-CRDT) command
 */
export function isRawSqlCommand(command: string): boolean {
  return command === "sql_select" || command === "sql_execute";
}

/**
 * Check if a command transforms DDL (adds CRDT columns to CREATE TABLE)
 */
export function transformsDdl(command: string): boolean {
  return command === "sql_execute_with_crdt";
}

// =============================================================================
// Decision Helper
// =============================================================================

/**
 * Recommend which SQL command to use based on the operation
 *
 * @example
 * ```typescript
 * const command = recommendSqlCommand("CREATE TABLE", { withCrdt: true });
 * // Returns: "sql_execute_with_crdt"
 *
 * const command = recommendSqlCommand("DELETE", { bypassDeleteLog: true });
 * // Returns: "sql_execute"
 * ```
 */
export function recommendSqlCommand(
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE TABLE" | "DROP TABLE" | "OTHER",
  options: {
    /** Should use CRDT transformations? */
    withCrdt?: boolean;
    /** For DELETE: bypass the delete-log trigger (test cleanup, no sync traffic)? */
    bypassDeleteLog?: boolean;
  } = {}
): TauriSqlCommand {
  const { withCrdt = true, bypassDeleteLog = false } = options;

  switch (operation) {
    case "SELECT":
      if (!withCrdt) return TAURI_SQL_COMMANDS.SQL_SELECT;
      return TAURI_SQL_COMMANDS.SQL_WITH_CRDT;

    case "INSERT":
    case "UPDATE":
      if (!withCrdt) return TAURI_SQL_COMMANDS.SQL_EXECUTE;
      return TAURI_SQL_COMMANDS.SQL_WITH_CRDT;

    case "DELETE":
      if (bypassDeleteLog || !withCrdt) return TAURI_SQL_COMMANDS.SQL_EXECUTE;
      return TAURI_SQL_COMMANDS.SQL_WITH_CRDT;

    case "CREATE TABLE":
      if (withCrdt) return TAURI_SQL_COMMANDS.SQL_EXECUTE_WITH_CRDT;
      return TAURI_SQL_COMMANDS.SQL_EXECUTE;

    case "DROP TABLE":
    case "OTHER":
      return TAURI_SQL_COMMANDS.SQL_EXECUTE;
  }
}

// =============================================================================
// Documentation Constants
// =============================================================================

/**
 * CRDT columns automatically added by sql_execute_with_crdt
 */
export const CRDT_COLUMNS = {
  /** Transaction-scope HLC for the last write that touched the row */
  HLC: "haex_hlc",
  /** JSON object mapping column names to their HLC timestamps */
  COLUMN_HLCS: "haex_column_hlcs",
} as const;

/**
 * Name of the delete-log table that all CRDT-tracked deletes are appended to
 * via BEFORE-DELETE triggers. Propagated as a regular CRDT table over sync.
 */
export const DELETED_ROWS_TABLE = "haex_deleted_rows";

/**
 * Tables with this suffix are excluded from CRDT transformation
 */
export const NO_SYNC_SUFFIX = "_no_sync";

/**
 * Check if a table name indicates a no-sync table
 */
export function isNoSyncTable(tableName: string): boolean {
  return tableName.endsWith(NO_SYNC_SUFFIX);
}
