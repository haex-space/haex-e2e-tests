import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers";

test.describe("Tombstone Lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const tableName = `e2e_tombstone_${Date.now()}`;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    sql = createSqlHelpers(vault);

    await sql.createTable(
      tableName,
      [
        { name: "id", type: "TEXT", primaryKey: true, notNull: true },
        { name: "label", type: "TEXT", notNull: true },
        { name: "priority", type: "INTEGER", default: 0 },
      ],
      { withCrdt: true }
    );

    // Set up triggers for the newly created CRDT table
    await vault.invokeTauriCommand("ensure_extension_triggers", {});

    // Seed test data
    await sql.insertMany(tableName, [
      { id: "tomb-1", label: "Keep Me", priority: 1 },
      { id: "tomb-2", label: "Delete Me", priority: 2 },
      { id: "tomb-3", label: "Also Keep", priority: 3 },
      { id: "tomb-4", label: "Hard Delete Me", priority: 4 },
    ]);
  });

  test.afterAll(async () => {
    await sql.dropTable(tableName);
  });

  test("soft delete sets isSoftDeleted to true", async () => {
    await sql.softDelete(tableName, "id = ?", ["tomb-2"]);

    const isTombstoned = await sql.isSoftDeleted(tableName, "id = ?", [
      "tomb-2",
    ]);
    expect(isTombstoned).toEqual(true);

    // Verify that non-deleted row is NOT soft deleted
    const isNotTombstoned = await sql.isSoftDeleted(tableName, "id = ?", [
      "tomb-1",
    ]);
    expect(isNotTombstoned).toEqual(false);
  });

  test("soft deleted rows excluded from CRDT select", async () => {
    const rows = await sql.select(tableName, ["id", "label"], {
      orderBy: "id ASC",
    });

    // tomb-2 was soft deleted, so only 3 rows remain
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(["tomb-1", "Keep Me"]);
    expect(rows[1]).toEqual(["tomb-3", "Also Keep"]);
    expect(rows[2]).toEqual(["tomb-4", "Hard Delete Me"]);

    // Explicitly verify tomb-2 is NOT in the result
    const ids = rows.map((row) => row[0]);
    expect(ids).not.toContain("tomb-2");
  });

  test("soft deleted rows VISIBLE in raw selectRaw", async () => {
    const rows = await sql.selectRaw(tableName, ["id", "haex_tombstone"], {
      orderBy: "id ASC",
    });

    // All 4 rows should be visible in raw select
    expect(rows).toHaveLength(4);

    const tomb2 = rows.find((row) => row[0] === "tomb-2");
    expect(tomb2).not.toBeUndefined();
    expect(tomb2![1]).toEqual(1); // haex_tombstone = 1

    // Verify active rows have tombstone = 0 or null (depending on vault version)
    const tomb1 = rows.find((row) => row[0] === "tomb-1");
    expect(tomb1).not.toBeUndefined();
    expect([0, null]).toContain(tomb1![1]);
  });

  test("count after soft delete reflects only active rows", async () => {
    const activeCount = await sql.count(tableName);
    expect(activeCount).toEqual(3);

    // Count with specific filter
    const highPriorityCount = await sql.count(
      tableName,
      "priority >= ?",
      [3]
    );
    expect(highPriorityCount).toEqual(2);

    // The soft-deleted row (priority=2) must not be counted
    const deletedPriorityCount = await sql.count(
      tableName,
      "priority = ?",
      [2]
    );
    expect(deletedPriorityCount).toEqual(0);
  });

  test("re-insert after hard delete of soft-deleted row", async () => {
    // First hard delete the soft-deleted row to free the PK
    await sql.hardDelete(tableName, "id = ?", ["tomb-2"]);

    // Verify it's completely gone from raw select
    const rawAfterHardDelete = await sql.selectRaw(tableName, ["id"], {
      where: "id = ?",
      params: ["tomb-2"],
    });
    expect(rawAfterHardDelete).toHaveLength(0);

    // Re-insert with same PK but different data
    await sql.insert(tableName, {
      id: "tomb-2",
      label: "Resurrected",
      priority: 10,
    });

    // Verify it's back and active
    const row = await sql.selectFirst(tableName, ["id", "label", "priority"], {
      where: "id = ?",
      params: ["tomb-2"],
    });
    expect(row).toEqual(["tomb-2", "Resurrected", 10]);

    const isTombstoned = await sql.isSoftDeleted(tableName, "id = ?", [
      "tomb-2",
    ]);
    expect(isTombstoned).toEqual(false);
  });

  test("hard delete actually removes row completely", async () => {
    await sql.hardDelete(tableName, "id = ?", ["tomb-4"]);

    // Not visible in CRDT select
    const crdtRows = await sql.select(tableName, ["id"], {
      where: "id = ?",
      params: ["tomb-4"],
    });
    expect(crdtRows).toHaveLength(0);

    // Also not visible in raw select
    const rawRows = await sql.selectRaw(tableName, ["id"], {
      where: "id = ?",
      params: ["tomb-4"],
    });
    expect(rawRows).toHaveLength(0);
  });

  test("crdt_get_stats returns correct tombstone count", async () => {
    // Current state: tomb-1 active, tomb-2 re-inserted (active), tomb-3 active, tomb-4 hard deleted
    // Soft delete tomb-3 to have a known tombstone for the stats check
    await sql.softDelete(tableName, "id = ?", ["tomb-3"]);

    // CrdtStats fields (camelCase via serde rename_all):
    //   totalEntries: total rows across all CRDT tables (including tombstoned)
    //   applied: non-tombstoned entries
    //   deleteCount: tombstoned (soft-deleted) entries
    //   pendingUpload, pendingApply, insertCount, updateCount: compatibility fields
    const stats = await vault.invokeTauriCommand<{
      totalEntries: number;
      applied: number;
      deleteCount: number;
      pendingUpload: number;
      pendingApply: number;
      insertCount: number;
      updateCount: number;
    }>("crdt_get_stats", {});

    // Stats are global across ALL tables, so we verify they're at least what we expect
    expect(typeof stats.deleteCount).toEqual("number");
    expect(typeof stats.applied).toEqual("number");
    expect(typeof stats.totalEntries).toEqual("number");

    // We have at least 1 tombstone (tomb-3).
    // Applied count depends on other tests that may have run before.
    expect(stats.deleteCount).toBeGreaterThanOrEqual(1);

    // Total entries includes both active and tombstoned
    expect(stats.totalEntries).toBeGreaterThan(0);
    expect(stats.totalEntries).toBeGreaterThanOrEqual(stats.applied + stats.deleteCount);
  });
});
