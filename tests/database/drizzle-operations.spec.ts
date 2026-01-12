// tests/database/drizzle-operations.spec.ts
//
// E2E Tests for Database Operations via Tauri Commands
//
// Tests the actual SQL execution through Tauri backend:
// - All SQL operations work correctly through Tauri invoke
// - CRDT integration works properly
// - RETURNING clause handled correctly
//
// IMPORTANT: Tauri SQL commands return Vec<Vec<JsonValue>> - arrays of arrays,
// NOT arrays of objects. Column order matches the SELECT column order.
//
// IMPORTANT: Use sql_execute_with_crdt for CREATE TABLE - it automatically adds
// CRDT columns (haex_timestamp, haex_column_hlcs, haex_tombstone) and sets up triggers.
//
// These tests use the running haex-vault app via tauri-driver/WebDriver.

import { test, expect, VaultAutomation } from "../fixtures";

// Test table for database operations
const TEST_TABLE = "haex_e2e_drizzle_test";

test.describe("Database Operations via Tauri", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Create test table using sql_execute_with_crdt
    // This automatically adds CRDT columns and sets up triggers
    await vault.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `
        CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          value TEXT,
          counter INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
        )
      `,
      params: [],
    });
  });

  test.afterAll(async () => {
    // Clean up test table
    await vault.invokeTauriCommand("sql_with_crdt", {
      sql: `DROP TABLE IF EXISTS ${TEST_TABLE}`,
      params: [],
    });
    await vault.deleteSession();
  });

  test.beforeEach(async () => {
    // Clear test data before each test
    // NOTE: sql_with_crdt converts DELETE to UPDATE (soft delete) with haex_tombstone = 1
    // For test cleanup, we need a HARD delete using sql_execute (no CRDT transformation)
    await vault.invokeTauriCommand("sql_execute", {
      sql: `DELETE FROM ${TEST_TABLE}`,
      params: [],
    });
  });

  // ===========================================================================
  // INSERT Operations
  // ===========================================================================

  test.describe("INSERT operations", () => {
    test("should insert single row", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (?, ?, ?)`,
        params: ["id1", "Test Name", "Test Value"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, value FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[0]).toBe("id1"); // id
      expect(result[0]?.[1]).toBe("Test Name"); // name
      expect(result[0]?.[2]).toBe("Test Value"); // value
    });

    test("should insert multiple rows", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name) VALUES (?, ?), (?, ?), (?, ?)`,
        params: ["id1", "Name 1", "id2", "Name 2", "id3", "Name 3"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} ORDER BY id`,
          params: [],
        }
      );

      expect(result).toHaveLength(3);
      expect(result.map((r) => r[1])).toEqual(["Name 1", "Name 2", "Name 3"]);
    });

    test("should use default values", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name) VALUES (?, ?)`,
        params: ["id1", "Default Test"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT counter, active, created_at FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe(0); // counter default
      expect(result[0]?.[1]).toBe(1); // active default
      expect(result[0]?.[2]).toBeDefined(); // created_at timestamp
    });

    test("should return inserted row with RETURNING", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (?, ?, ?) RETURNING id, name, created_at`,
          params: ["id1", "Return Test", "Return Value"],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[0]).toBe("id1"); // id
      expect(result[0]?.[1]).toBe("Return Test"); // name
      expect(result[0]?.[2]).toBeDefined(); // created_at
    });
  });

  // ===========================================================================
  // SELECT Operations
  // ===========================================================================

  test.describe("SELECT operations", () => {
    test.beforeEach(async () => {
      // Seed test data
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value, counter, active) VALUES
          (?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?)`,
        params: [
          "id1", "Alice", "alpha", 10, 1,
          "id2", "Bob", "beta", 20, 1,
          "id3", "Charlie", "gamma", 30, 0,
          "id4", "Diana", null, 40, 1,
          "id5", "Eve", "epsilon", 50, 1,
        ],
      });
    });

    test("should select all rows", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT * FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result).toHaveLength(5);
    });

    test("should select specific columns", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name, counter FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result).toHaveLength(5);
      // Each row should have exactly 2 columns
      expect(result[0]).toHaveLength(2);
    });

    test("should filter with WHERE =", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name = ?`,
          params: ["Alice"],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[1]).toBe("Alice");
    });

    test("should filter with WHERE != / <>", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name != ?`,
          params: ["Alice"],
        }
      );

      expect(result).toHaveLength(4);
      expect(result.map((r) => r[1])).not.toContain("Alice");
    });

    test("should filter with WHERE >", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter FROM ${TEST_TABLE} WHERE counter > ?`,
          params: [25],
        }
      );

      expect(result).toHaveLength(3);
      result.forEach((row) => {
        expect(row[2]).toBeGreaterThan(25);
      });
    });

    test("should filter with WHERE >=", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter FROM ${TEST_TABLE} WHERE counter >= ?`,
          params: [30],
        }
      );

      expect(result).toHaveLength(3);
      result.forEach((row) => {
        expect(row[2]).toBeGreaterThanOrEqual(30);
      });
    });

    test("should filter with WHERE <", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter FROM ${TEST_TABLE} WHERE counter < ?`,
          params: [25],
        }
      );

      expect(result).toHaveLength(2);
      result.forEach((row) => {
        expect(row[2]).toBeLessThan(25);
      });
    });

    test("should filter with WHERE <=", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter FROM ${TEST_TABLE} WHERE counter <= ?`,
          params: [20],
        }
      );

      expect(result).toHaveLength(2);
      result.forEach((row) => {
        expect(row[2]).toBeLessThanOrEqual(20);
      });
    });

    test("should filter with WHERE LIKE", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name LIKE ?`,
          params: ["%a%"],
        }
      );

      // Alice, Charlie, Diana all contain 'a'
      expect(result).toHaveLength(3);
    });

    test("should filter with WHERE AND", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter, active FROM ${TEST_TABLE} WHERE counter > ? AND active = ?`,
          params: [15, 1],
        }
      );

      expect(result).toHaveLength(3); // Bob, Diana, Eve
      result.forEach((row) => {
        expect(row[2]).toBeGreaterThan(15);
        expect(row[3]).toBe(1);
      });
    });

    test("should filter with WHERE OR", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name = ? OR name = ?`,
          params: ["Alice", "Bob"],
        }
      );

      expect(result).toHaveLength(2);
    });

    test("should filter with IS NULL", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, value FROM ${TEST_TABLE} WHERE value IS NULL`,
          params: [],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[1]).toBe("Diana");
    });

    test("should filter with IS NOT NULL", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE value IS NOT NULL`,
          params: [],
        }
      );

      expect(result).toHaveLength(4);
    });

    test("should filter with IN", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name IN (?, ?, ?)`,
          params: ["Alice", "Bob", "Eve"],
        }
      );

      expect(result).toHaveLength(3);
    });

    test("should filter with NOT IN", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name FROM ${TEST_TABLE} WHERE name NOT IN (?, ?)`,
          params: ["Alice", "Bob"],
        }
      );

      expect(result).toHaveLength(3);
    });

    test("should filter with BETWEEN", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, name, counter FROM ${TEST_TABLE} WHERE counter BETWEEN ? AND ?`,
          params: [15, 35],
        }
      );

      expect(result).toHaveLength(2); // Bob (20), Charlie (30)
      result.forEach((row) => {
        expect(row[2]).toBeGreaterThanOrEqual(15);
        expect(row[2]).toBeLessThanOrEqual(35);
      });
    });
  });

  // ===========================================================================
  // ORDER BY
  // ===========================================================================

  test.describe("ORDER BY", () => {
    test.beforeEach(async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES
          (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
        params: ["id1", "Charlie", 30, "id2", "Alice", 10, "id3", "Bob", 20],
      });
    });

    test("should order ASC", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name FROM ${TEST_TABLE} ORDER BY name ASC`,
          params: [],
        }
      );

      expect(result.map((r) => r[0])).toEqual(["Alice", "Bob", "Charlie"]);
    });

    test("should order DESC", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name FROM ${TEST_TABLE} ORDER BY name DESC`,
          params: [],
        }
      );

      expect(result.map((r) => r[0])).toEqual(["Charlie", "Bob", "Alice"]);
    });

    test("should order by multiple columns", async () => {
      // Add more data with same name
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES (?, ?, ?)`,
        params: ["id4", "Alice", 5],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name, counter FROM ${TEST_TABLE} ORDER BY name ASC, counter DESC`,
          params: [],
        }
      );

      // Alice should appear twice, with higher counter first
      expect(result[0]).toEqual(["Alice", 10]);
      expect(result[1]).toEqual(["Alice", 5]);
    });
  });

  // ===========================================================================
  // LIMIT and OFFSET
  // ===========================================================================

  test.describe("LIMIT and OFFSET", () => {
    test.beforeEach(async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES
          (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
        params: [
          "id1", "A", 1,
          "id2", "B", 2,
          "id3", "C", 3,
          "id4", "D", 4,
          "id5", "E", 5,
        ],
      });
    });

    test("should limit results", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name FROM ${TEST_TABLE} ORDER BY name LIMIT 3`,
          params: [],
        }
      );

      expect(result).toHaveLength(3);
      expect(result.map((r) => r[0])).toEqual(["A", "B", "C"]);
    });

    test("should offset results", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT name FROM ${TEST_TABLE} ORDER BY name LIMIT 3 OFFSET 2`,
          params: [],
        }
      );

      expect(result).toHaveLength(3);
      expect(result.map((r) => r[0])).toEqual(["C", "D", "E"]);
    });
  });

  // ===========================================================================
  // Aggregate functions
  // ===========================================================================

  test.describe("Aggregate functions", () => {
    test.beforeEach(async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES
          (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
        params: [
          "id1", "A", 10,
          "id2", "B", 20,
          "id3", "C", 30,
          "id4", "D", 40,
          "id5", "E", 50,
        ],
      });
    });

    test("COUNT", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT COUNT(*) FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result[0]?.[0]).toBe(5);
    });

    test("SUM", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT SUM(counter) FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result[0]?.[0]).toBe(150);
    });

    test("AVG", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT AVG(counter) FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result[0]?.[0]).toBe(30);
    });

    test("MIN", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT MIN(counter) FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result[0]?.[0]).toBe(10);
    });

    test("MAX", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT MAX(counter) FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result[0]?.[0]).toBe(50);
    });
  });

  // ===========================================================================
  // UPDATE Operations
  // ===========================================================================

  test.describe("UPDATE operations", () => {
    test.beforeEach(async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value, counter) VALUES
          (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
        params: [
          "id1", "Alice", "original", 10,
          "id2", "Bob", "original", 20,
          "id3", "Charlie", "original", 30,
        ],
      });
    });

    test("should update single row", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `UPDATE ${TEST_TABLE} SET value = ? WHERE id = ?`,
        params: ["updated", "id1"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id, value FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[1]).toBe("updated");
    });

    test("should update multiple columns", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `UPDATE ${TEST_TABLE} SET value = ?, counter = ? WHERE id = ?`,
        params: ["multi-update", 999, "id1"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT value, counter FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe("multi-update");
      expect(result[0]?.[1]).toBe(999);
    });

    test("should update with RETURNING", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `UPDATE ${TEST_TABLE} SET value = ? WHERE id = ? RETURNING id, value`,
          params: ["returned", "id1"],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[0]).toBe("id1");
      expect(result[0]?.[1]).toBe("returned");
    });
  });

  // ===========================================================================
  // DELETE Operations
  // ===========================================================================

  test.describe("DELETE operations", () => {
    test.beforeEach(async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES
          (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
        params: [
          "id1", "Alice", 10,
          "id2", "Bob", 20,
          "id3", "Charlie", 30,
        ],
      });
    });

    test("should delete single row", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `DELETE FROM ${TEST_TABLE} WHERE id = ?`,
        params: ["id1"],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result).toHaveLength(2);
      expect(result.map((r) => r[0])).not.toContain("id1");
    });

    test("should delete multiple rows", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `DELETE FROM ${TEST_TABLE} WHERE counter < ?`,
        params: [25],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id FROM ${TEST_TABLE}`,
          params: [],
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.[0]).toBe("id3");
    });

    test("should delete with RETURNING", async () => {
      // NOTE: sql_with_crdt converts DELETE to UPDATE with haex_tombstone = 1 (soft delete)
      // The RETURNING clause behavior depends on how the CRDT transformer handles it
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `DELETE FROM ${TEST_TABLE} WHERE id = ? RETURNING id, name`,
          params: ["id1"],
        }
      );

      // With CRDT soft delete, RETURNING may return empty array since the row
      // is not actually deleted but updated. Verify the row is soft-deleted instead.
      if (result.length === 0) {
        // Verify soft delete worked - row should still exist but be filtered by CRDT
        // Using sql_select (raw SELECT without CRDT filter) to check tombstone
        const rawResult = await vault.invokeTauriCommand<unknown[][]>(
          "sql_select",
          {
            sql: `SELECT id, name, haex_tombstone FROM ${TEST_TABLE} WHERE id = ?`,
            params: ["id1"],
          }
        );
        expect(rawResult).toHaveLength(1);
        expect(rawResult[0]?.[0]).toBe("id1");
        expect(rawResult[0]?.[2]).toBe(1); // haex_tombstone = 1
      } else {
        // If RETURNING does work, verify the returned data
        expect(result).toHaveLength(1);
        expect(result[0]?.[0]).toBe("id1");
        expect(result[0]?.[1]).toBe("Alice");
      }

      // Either way, the row should be invisible via sql_with_crdt (soft delete filter)
      const visibleRows = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT id FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );
      expect(visibleRows).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  test.describe("Edge cases", () => {
    test("should handle special characters", async () => {
      const specialValue = "Test's \"quoted\" & <special> value";

      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (?, ?, ?)`,
        params: ["id1", "Special", specialValue],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT value FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe(specialValue);
    });

    test("should handle empty string", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (?, ?, ?)`,
        params: ["id1", "Empty", ""],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT value FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe("");
    });

    test("should handle zero", async () => {
      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, counter) VALUES (?, ?, ?)`,
        params: ["id1", "Zero", 0],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT counter FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe(0);
    });

    test("should handle unicode", async () => {
      const unicodeValue = "日本語 🎉 émojis";

      await vault.invokeTauriCommand("sql_with_crdt", {
        sql: `INSERT INTO ${TEST_TABLE} (id, name, value) VALUES (?, ?, ?)`,
        params: ["id1", "Unicode", unicodeValue],
      });

      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT value FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["id1"],
        }
      );

      expect(result[0]?.[0]).toBe(unicodeValue);
    });

    test("should return empty array for no matches", async () => {
      const result = await vault.invokeTauriCommand<unknown[][]>(
        "sql_with_crdt",
        {
          sql: `SELECT * FROM ${TEST_TABLE} WHERE id = ?`,
          params: ["nonexistent"],
        }
      );

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Tests for the critical findFirst behavior
// These verify that empty results don't cause issues
// ===========================================================================

test.describe("Empty result handling (critical for findFirst)", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("sql_with_crdt should return empty array for no matches", async () => {
    // Query a system table that exists but has no matching rows
    // NOTE: haex_crdt_configs_no_sync is a local-only table (no CRDT sync)
    const result = await vault.invokeTauriCommand<unknown[][]>(
      "sql_with_crdt",
      {
        sql: `SELECT * FROM haex_crdt_configs_no_sync WHERE key = ?`,
        params: ["definitely_does_not_exist_12345"],
      }
    );

    // Must be empty array, NOT an object
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("initial_sync_complete pattern should work correctly", async () => {
    // This mimics the isInitialSyncCompleteAsync pattern
    const result = await vault.invokeTauriCommand<unknown[][]>(
      "sql_with_crdt",
      {
        sql: `SELECT value FROM haex_crdt_configs_no_sync WHERE key = ?`,
        params: ["initial_sync_complete"],
      }
    );

    // Result should be array (possibly empty)
    expect(Array.isArray(result)).toBe(true);

    // Pattern: const isComplete = result[0]?.[0] === 'true'
    // This works correctly whether result is [] or has data
    const isComplete = result[0]?.[0] === "true";
    expect(typeof isComplete).toBe("boolean");
  });

  test("upsert pattern should work with existence check", async () => {
    const testKey = "e2e_test_config_" + Date.now();

    // Check if exists (should not)
    // NOTE: haex_crdt_configs_no_sync is a _no_sync table, so no CRDT transformation
    const checkResult = await vault.invokeTauriCommand<unknown[][]>(
      "sql_with_crdt",
      {
        sql: `SELECT key FROM haex_crdt_configs_no_sync WHERE key = ?`,
        params: [testKey],
      }
    );

    expect(checkResult).toHaveLength(0);

    // Insert new entry (using sql_execute since it's a _no_sync table)
    await vault.invokeTauriCommand("sql_execute", {
      sql: `INSERT INTO haex_crdt_configs_no_sync (key, type, value) VALUES (?, ?, ?)`,
      params: [testKey, "test", "test_value"],
    });

    // Check again (should exist now)
    const checkAgain = await vault.invokeTauriCommand<unknown[][]>(
      "sql_with_crdt",
      {
        sql: `SELECT key, value FROM haex_crdt_configs_no_sync WHERE key = ?`,
        params: [testKey],
      }
    );

    expect(checkAgain).toHaveLength(1);
    expect(checkAgain[0]?.[0]).toBe(testKey);
    expect(checkAgain[0]?.[1]).toBe("test_value");

    // Clean up (using sql_execute for hard delete on _no_sync table)
    await vault.invokeTauriCommand("sql_execute", {
      sql: `DELETE FROM haex_crdt_configs_no_sync WHERE key = ?`,
      params: [testKey],
    });
  });
});
