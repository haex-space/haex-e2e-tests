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
 * | Command                 | CRDT Transform | Tombstone Filter | Use Case                          |
 * |------------------------|----------------|------------------|-----------------------------------|
 * | sql_select             | No             | No               | Raw SELECT, debug, PRAGMA         |
 * | sql_execute            | No             | No               | Raw DDL, test cleanup             |
 * | sql_select_with_crdt   | No             | Yes              | SELECT excluding soft-deleted     |
 * | sql_execute_with_crdt  | Yes            | N/A              | CREATE TABLE with CRDT columns    |
 * | sql_with_crdt          | Auto           | Auto             | Unified proxy for app use         |
 */
export const TAURI_SQL_COMMANDS = {
  /**
   * Raw SELECT without any CRDT transformation
   *
   * - No tombstone filtering (includes soft-deleted rows)
   * - No CRDT column transformation
   * - Use for debugging, PRAGMA queries, or accessing raw data
   *
   * @example
   * ```typescript
   * // Check tombstone status
   * await vault.invokeTauriCommand("sql_select", {
   *   sql: "SELECT id, haex_tombstone FROM users WHERE id = ?",
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
   * - DELETE actually removes rows (hard delete)
   * - Use for test cleanup, DDL on no-sync tables
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
   * SELECT with CRDT tombstone filtering
   *
   * - Excludes rows where haex_tombstone = 1
   * - No other CRDT transformation
   * - Use for queries that should exclude soft-deleted rows
   *
   * @example
   * ```typescript
   * // Get active users only
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
   * - CREATE TABLE: Adds CRDT columns (haex_timestamp, haex_column_hlcs, haex_tombstone)
   * - Sets up triggers for CRDT operations
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
   * // Results in table with: id, name, email, haex_timestamp, haex_column_hlcs, haex_tombstone
   * ```
   */
  SQL_EXECUTE_WITH_CRDT: "sql_execute_with_crdt" as const,

  /**
   * Unified SQL proxy with automatic CRDT handling
   *
   * Routes to appropriate handler based on statement type:
   * - SELECT: Uses sql_select_with_crdt (filters tombstones)
   * - INSERT: Adds CRDT timestamps and HLCs
   * - UPDATE: Updates CRDT timestamps and column HLCs
   * - DELETE: Converts to UPDATE with haex_tombstone = 1 (soft delete)
   * - Other (CREATE, DROP, etc.): Uses raw sql_execute (no CRDT)
   *
   * IMPORTANT: For CREATE TABLE, use sql_execute_with_crdt instead!
   * sql_with_crdt uses raw execute for DDL and won't add CRDT columns.
   *
   * @example
   * ```typescript
   * // Insert with CRDT (adds timestamps)
   * await vault.invokeTauriCommand("sql_with_crdt", {
   *   sql: "INSERT INTO users (id, name) VALUES (?, ?)",
   *   params: ["user1", "Alice"]
   * });
   *
   * // Select (filters soft-deleted)
   * await vault.invokeTauriCommand("sql_with_crdt", {
   *   sql: "SELECT * FROM users WHERE active = ?",
   *   params: [1]
   * });
   *
   * // Delete (soft delete - sets tombstone)
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
 * Check if a command filters tombstones
 */
export function filtersTombstones(command: string): boolean {
  return (
    command === "sql_select_with_crdt" ||
    command === "sql_with_crdt" ||
    command === "sql_query_with_crdt"
  );
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
 * const command = recommendSqlCommand("DELETE", { hardDelete: true });
 * // Returns: "sql_execute"
 * ```
 */
export function recommendSqlCommand(
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE TABLE" | "DROP TABLE" | "OTHER",
  options: {
    /** Should use CRDT transformations? */
    withCrdt?: boolean;
    /** For DELETE: should actually remove rows instead of soft delete? */
    hardDelete?: boolean;
    /** Should include soft-deleted rows in SELECT? */
    includeDeleted?: boolean;
  } = {}
): TauriSqlCommand {
  const { withCrdt = true, hardDelete = false, includeDeleted = false } = options;

  switch (operation) {
    case "SELECT":
      if (includeDeleted || !withCrdt) return TAURI_SQL_COMMANDS.SQL_SELECT;
      return TAURI_SQL_COMMANDS.SQL_WITH_CRDT;

    case "INSERT":
    case "UPDATE":
      if (!withCrdt) return TAURI_SQL_COMMANDS.SQL_EXECUTE;
      return TAURI_SQL_COMMANDS.SQL_WITH_CRDT;

    case "DELETE":
      if (hardDelete || !withCrdt) return TAURI_SQL_COMMANDS.SQL_EXECUTE;
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
  /** HLC timestamp for last modification */
  TIMESTAMP: "haex_timestamp",
  /** JSON object mapping column names to their HLC timestamps */
  COLUMN_HLCS: "haex_column_hlcs",
  /** Soft delete flag (0 = active, 1 = deleted) */
  TOMBSTONE: "haex_tombstone",
} as const;

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
