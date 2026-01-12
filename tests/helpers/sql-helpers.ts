// tests/helpers/sql-helpers.ts
//
// SQL Helper Utilities for E2E Tests
//
// This module provides type-safe wrappers around haex-vault's SQL commands,
// making it easier to write database tests with proper CRDT handling.
//
// IMPORTANT CONCEPTS:
//
// 1. CRDT Tables vs No-Sync Tables
//    - Regular tables get CRDT columns automatically (haex_timestamp, haex_column_hlcs, haex_tombstone)
//    - Tables with "_no_sync" suffix are local-only and don't get CRDT transformation
//
// 2. Soft Delete vs Hard Delete
//    - sql_with_crdt DELETE → UPDATE with haex_tombstone = 1 (soft delete)
//    - sql_execute DELETE → actual row deletion (hard delete)
//
// 3. Available Tauri SQL Commands:
//    - sql_select: Raw SELECT without CRDT filtering
//    - sql_execute: Raw non-SELECT without CRDT transformation
//    - sql_select_with_crdt: SELECT with tombstone filtering (excludes soft-deleted rows)
//    - sql_execute_with_crdt: CREATE TABLE with automatic CRDT columns
//    - sql_with_crdt: Unified proxy that routes based on statement type

import type { VaultAutomation } from "../fixtures";

// =============================================================================
// Types
// =============================================================================

/**
 * SQL parameter types supported by SQLite/rusqlite
 */
export type SqlParam = string | number | boolean | null;

/**
 * Result row from SQL queries (array of values)
 */
export type SqlRow = unknown[];

/**
 * Result set from SQL queries (array of rows)
 */
export type SqlResultSet = SqlRow[];

/**
 * Column definition for table creation
 */
export interface ColumnDefinition {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL" | "BLOB";
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string | number | null;
}

/**
 * Options for table creation
 */
export interface CreateTableOptions {
  /** If true, adds CRDT columns automatically */
  withCrdt?: boolean;
  /** If true, uses IF NOT EXISTS clause */
  ifNotExists?: boolean;
}

// =============================================================================
// SQL Helper Class
// =============================================================================

/**
 * SQL helper utilities for E2E tests
 *
 * Provides type-safe wrappers around Tauri SQL commands with proper CRDT handling.
 *
 * @example
 * ```typescript
 * const sql = new SqlHelpers(vault);
 *
 * // Create a CRDT-enabled table
 * await sql.createTable("my_table", [
 *   { name: "id", type: "TEXT", primaryKey: true, notNull: true },
 *   { name: "name", type: "TEXT", notNull: true },
 *   { name: "value", type: "INTEGER", default: 0 },
 * ], { withCrdt: true });
 *
 * // Insert with CRDT
 * await sql.insert("my_table", { id: "1", name: "Test", value: 42 });
 *
 * // Query with CRDT (excludes soft-deleted rows)
 * const rows = await sql.select("my_table", ["id", "name"], { where: "value > ?", params: [10] });
 *
 * // Soft delete (sets haex_tombstone = 1)
 * await sql.softDelete("my_table", "id = ?", ["1"]);
 *
 * // Hard delete (actually removes the row - use for test cleanup)
 * await sql.hardDelete("my_table", "id = ?", ["1"]);
 * ```
 */
export class SqlHelpers {
  constructor(private vault: VaultAutomation) {}

  // ===========================================================================
  // Table Operations
  // ===========================================================================

  /**
   * Create a new table
   *
   * @param tableName - Name of the table to create
   * @param columns - Column definitions
   * @param options - Creation options (withCrdt, ifNotExists)
   *
   * @example
   * ```typescript
   * await sql.createTable("users", [
   *   { name: "id", type: "TEXT", primaryKey: true, notNull: true },
   *   { name: "email", type: "TEXT", notNull: true, unique: true },
   *   { name: "created_at", type: "TEXT", default: "(CURRENT_TIMESTAMP)" },
   * ], { withCrdt: true, ifNotExists: true });
   * ```
   */
  async createTable(
    tableName: string,
    columns: ColumnDefinition[],
    options: CreateTableOptions = {}
  ): Promise<void> {
    const { withCrdt = true, ifNotExists = true } = options;

    const columnDefs = columns.map((col) => {
      const parts = [col.name, col.type];
      if (col.primaryKey) parts.push("PRIMARY KEY");
      if (col.notNull) parts.push("NOT NULL");
      if (col.unique) parts.push("UNIQUE");
      if (col.default !== undefined) {
        const defaultValue =
          typeof col.default === "string"
            ? col.default.startsWith("(")
              ? col.default
              : `'${col.default}'`
            : col.default;
        parts.push(`DEFAULT ${defaultValue}`);
      }
      return parts.join(" ");
    });

    const ifNotExistsClause = ifNotExists ? "IF NOT EXISTS " : "";
    const sql = `CREATE TABLE ${ifNotExistsClause}${tableName} (${columnDefs.join(", ")})`;

    // Use sql_execute_with_crdt for CRDT tables to add columns automatically
    // Use sql_execute for no-sync tables
    const command = withCrdt ? "sql_execute_with_crdt" : "sql_execute";
    await this.vault.invokeTauriCommand(command, { sql, params: [] });
  }

  /**
   * Drop a table
   *
   * @param tableName - Name of the table to drop
   * @param ifExists - If true, uses IF EXISTS clause
   */
  async dropTable(tableName: string, ifExists = true): Promise<void> {
    const ifExistsClause = ifExists ? "IF EXISTS " : "";
    const sql = `DROP TABLE ${ifExistsClause}${tableName}`;
    await this.vault.invokeTauriCommand("sql_execute", { sql, params: [] });
  }

  // ===========================================================================
  // Insert Operations
  // ===========================================================================

  /**
   * Insert a single row with CRDT
   *
   * @param tableName - Name of the table
   * @param data - Object with column names and values
   * @returns The inserted row if RETURNING is supported
   *
   * @example
   * ```typescript
   * await sql.insert("users", { id: "user1", name: "Alice", email: "alice@example.com" });
   * ```
   */
  async insert(
    tableName: string,
    data: Record<string, SqlParam>
  ): Promise<SqlResultSet> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map(() => "?").join(", ");

    const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params: values,
    });
  }

  /**
   * Insert a single row and return specified columns
   *
   * @param tableName - Name of the table
   * @param data - Object with column names and values
   * @param returning - Columns to return
   * @returns The inserted row with specified columns
   *
   * @example
   * ```typescript
   * const [row] = await sql.insertReturning("users", { id: "user1", name: "Alice" }, ["id", "created_at"]);
   * console.log(row); // ["user1", "2024-01-01T00:00:00Z"]
   * ```
   */
  async insertReturning(
    tableName: string,
    data: Record<string, SqlParam>,
    returning: string[]
  ): Promise<SqlResultSet> {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map(() => "?").join(", ");

    const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING ${returning.join(", ")}`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params: values,
    });
  }

  /**
   * Insert multiple rows at once
   *
   * @param tableName - Name of the table
   * @param rows - Array of objects with column names and values
   *
   * @example
   * ```typescript
   * await sql.insertMany("users", [
   *   { id: "user1", name: "Alice" },
   *   { id: "user2", name: "Bob" },
   *   { id: "user3", name: "Charlie" },
   * ]);
   * ```
   */
  async insertMany(
    tableName: string,
    rows: Record<string, SqlParam>[]
  ): Promise<SqlResultSet> {
    if (rows.length === 0) return [];

    const columns = Object.keys(rows[0]!);
    const valueSets: string[] = [];
    const allParams: SqlParam[] = [];

    for (const row of rows) {
      const placeholders = columns.map(() => "?").join(", ");
      valueSets.push(`(${placeholders})`);
      for (const col of columns) {
        allParams.push(row[col] ?? null);
      }
    }

    const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${valueSets.join(", ")}`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params: allParams,
    });
  }

  // ===========================================================================
  // Select Operations
  // ===========================================================================

  /**
   * Select rows with CRDT filtering (excludes soft-deleted rows)
   *
   * @param tableName - Name of the table
   * @param columns - Columns to select (use ["*"] for all)
   * @param options - Query options (where, params, orderBy, limit, offset)
   * @returns Array of rows (each row is an array of values)
   *
   * @example
   * ```typescript
   * // Select all
   * const allRows = await sql.select("users", ["*"]);
   *
   * // Select with filter
   * const activeUsers = await sql.select("users", ["id", "name"], {
   *   where: "active = ? AND created_at > ?",
   *   params: [1, "2024-01-01"],
   *   orderBy: "name ASC",
   *   limit: 10,
   * });
   * ```
   */
  async select(
    tableName: string,
    columns: string[] = ["*"],
    options: {
      where?: string;
      params?: SqlParam[];
      orderBy?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<SqlResultSet> {
    const { where, params = [], orderBy, limit, offset } = options;

    let sql = `SELECT ${columns.join(", ")} FROM ${tableName}`;
    if (where) sql += ` WHERE ${where}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    if (offset !== undefined) sql += ` OFFSET ${offset}`;

    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params,
    });
  }

  /**
   * Select first matching row
   *
   * @param tableName - Name of the table
   * @param columns - Columns to select
   * @param options - Query options
   * @returns First matching row or undefined
   *
   * @example
   * ```typescript
   * const user = await sql.selectFirst("users", ["id", "name"], {
   *   where: "email = ?",
   *   params: ["alice@example.com"],
   * });
   * if (user) {
   *   console.log(user[0], user[1]); // id, name
   * }
   * ```
   */
  async selectFirst(
    tableName: string,
    columns: string[] = ["*"],
    options: {
      where?: string;
      params?: SqlParam[];
      orderBy?: string;
    } = {}
  ): Promise<SqlRow | undefined> {
    const rows = await this.select(tableName, columns, { ...options, limit: 1 });
    return rows[0];
  }

  /**
   * Select rows without CRDT filtering (includes soft-deleted rows)
   *
   * Use this when you need to verify tombstone status or access all rows.
   *
   * @example
   * ```typescript
   * // Check if a row was soft-deleted
   * const row = await sql.selectRaw("users", ["id", "haex_tombstone"], {
   *   where: "id = ?",
   *   params: ["user1"],
   * });
   * if (row[0]?.[1] === 1) {
   *   console.log("Row is soft-deleted");
   * }
   * ```
   */
  async selectRaw(
    tableName: string,
    columns: string[] = ["*"],
    options: {
      where?: string;
      params?: SqlParam[];
      orderBy?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<SqlResultSet> {
    const { where, params = [], orderBy, limit, offset } = options;

    let sql = `SELECT ${columns.join(", ")} FROM ${tableName}`;
    if (where) sql += ` WHERE ${where}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit !== undefined) sql += ` LIMIT ${limit}`;
    if (offset !== undefined) sql += ` OFFSET ${offset}`;

    return this.vault.invokeTauriCommand<SqlResultSet>("sql_select", {
      sql,
      params,
    });
  }

  /**
   * Count rows matching a condition
   *
   * @example
   * ```typescript
   * const activeCount = await sql.count("users", "active = ?", [1]);
   * ```
   */
  async count(
    tableName: string,
    where?: string,
    params: SqlParam[] = []
  ): Promise<number> {
    let sql = `SELECT COUNT(*) FROM ${tableName}`;
    if (where) sql += ` WHERE ${where}`;

    const result = await this.vault.invokeTauriCommand<SqlResultSet>(
      "sql_with_crdt",
      { sql, params }
    );
    return (result[0]?.[0] as number) ?? 0;
  }

  // ===========================================================================
  // Update Operations
  // ===========================================================================

  /**
   * Update rows with CRDT
   *
   * @param tableName - Name of the table
   * @param data - Object with column names and new values
   * @param where - WHERE clause
   * @param params - Parameters for WHERE clause
   *
   * @example
   * ```typescript
   * await sql.update("users", { name: "Alice Smith", active: 0 }, "id = ?", ["user1"]);
   * ```
   */
  async update(
    tableName: string,
    data: Record<string, SqlParam>,
    where: string,
    params: SqlParam[] = []
  ): Promise<SqlResultSet> {
    const setClauses = Object.keys(data).map((col) => `${col} = ?`);
    const setParams = Object.values(data);

    const sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${where}`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params: [...setParams, ...params],
    });
  }

  /**
   * Update rows and return specified columns
   *
   * @example
   * ```typescript
   * const [updated] = await sql.updateReturning(
   *   "users",
   *   { name: "Alice Smith" },
   *   "id = ?",
   *   ["user1"],
   *   ["id", "name", "updated_at"]
   * );
   * ```
   */
  async updateReturning(
    tableName: string,
    data: Record<string, SqlParam>,
    where: string,
    params: SqlParam[],
    returning: string[]
  ): Promise<SqlResultSet> {
    const setClauses = Object.keys(data).map((col) => `${col} = ?`);
    const setParams = Object.values(data);

    const sql = `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${where} RETURNING ${returning.join(", ")}`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params: [...setParams, ...params],
    });
  }

  // ===========================================================================
  // Delete Operations
  // ===========================================================================

  /**
   * Soft delete rows (sets haex_tombstone = 1)
   *
   * Rows will be excluded from sql_with_crdt SELECT queries but remain in the database.
   * Use for production deletes where CRDT sync is needed.
   *
   * @example
   * ```typescript
   * await sql.softDelete("users", "id = ?", ["user1"]);
   * ```
   */
  async softDelete(
    tableName: string,
    where: string,
    params: SqlParam[] = []
  ): Promise<SqlResultSet> {
    const sql = `DELETE FROM ${tableName} WHERE ${where}`;
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params,
    });
  }

  /**
   * Hard delete rows (actually removes them from the database)
   *
   * Use this for test cleanup to avoid PRIMARY KEY conflicts on re-insert.
   *
   * @example
   * ```typescript
   * // In beforeEach to clean up test data
   * await sql.hardDelete("test_table"); // Delete all rows
   *
   * // Delete specific rows
   * await sql.hardDelete("test_table", "id = ?", ["test-id"]);
   * ```
   */
  async hardDelete(
    tableName: string,
    where?: string,
    params: SqlParam[] = []
  ): Promise<void> {
    let sql = `DELETE FROM ${tableName}`;
    if (where) sql += ` WHERE ${where}`;

    await this.vault.invokeTauriCommand("sql_execute", { sql, params });
  }

  /**
   * Check if a row was soft-deleted
   *
   * @example
   * ```typescript
   * await sql.softDelete("users", "id = ?", ["user1"]);
   * const isTombstoned = await sql.isSoftDeleted("users", "id = ?", ["user1"]);
   * expect(isTombstoned).toBe(true);
   * ```
   */
  async isSoftDeleted(
    tableName: string,
    where: string,
    params: SqlParam[] = []
  ): Promise<boolean> {
    const sql = `SELECT haex_tombstone FROM ${tableName} WHERE ${where}`;
    const result = await this.vault.invokeTauriCommand<SqlResultSet>(
      "sql_select",
      { sql, params }
    );
    return result[0]?.[0] === 1;
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Execute raw SQL with CRDT (for complex queries)
   *
   * @example
   * ```typescript
   * const result = await sql.rawWithCrdt(
   *   "SELECT u.name, COUNT(o.id) as order_count FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id",
   *   []
   * );
   * ```
   */
  async rawWithCrdt(sql: string, params: SqlParam[] = []): Promise<SqlResultSet> {
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_with_crdt", {
      sql,
      params,
    });
  }

  /**
   * Execute raw SQL without CRDT
   *
   * @example
   * ```typescript
   * await sql.rawExecute("PRAGMA table_info(users)", []);
   * ```
   */
  async rawSelect(sql: string, params: SqlParam[] = []): Promise<SqlResultSet> {
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_select", {
      sql,
      params,
    });
  }

  /**
   * Execute raw non-SELECT SQL without CRDT
   */
  async rawExecute(sql: string, params: SqlParam[] = []): Promise<void> {
    await this.vault.invokeTauriCommand("sql_execute", { sql, params });
  }

  /**
   * Check if a table exists
   *
   * @example
   * ```typescript
   * const exists = await sql.tableExists("users");
   * ```
   */
  async tableExists(tableName: string): Promise<boolean> {
    const result = await this.vault.invokeTauriCommand<SqlResultSet>(
      "sql_select",
      {
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        params: [tableName],
      }
    );
    return result.length > 0;
  }

  /**
   * Get table schema information
   *
   * @example
   * ```typescript
   * const columns = await sql.getTableInfo("users");
   * // Returns: [{ cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 }, ...]
   * ```
   */
  async getTableInfo(tableName: string): Promise<SqlResultSet> {
    return this.vault.invokeTauriCommand<SqlResultSet>("sql_select", {
      sql: `PRAGMA table_info(${tableName})`,
      params: [],
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new SqlHelpers instance
 *
 * @example
 * ```typescript
 * import { createSqlHelpers } from "../helpers/sql-helpers";
 *
 * test.describe("My Tests", () => {
 *   let vault: VaultAutomation;
 *   let sql: SqlHelpers;
 *
 *   test.beforeAll(async () => {
 *     vault = new VaultAutomation("A");
 *     await vault.createSession();
 *     sql = createSqlHelpers(vault);
 *   });
 * });
 * ```
 */
export function createSqlHelpers(vault: VaultAutomation): SqlHelpers {
  return new SqlHelpers(vault);
}
