import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers";

type CrdtStats = {
  totalEntries: number;
  applied: number;
  deleteCount: number;
  pendingUpload: number;
  pendingApply: number;
  insertCount: number;
  updateCount: number;
};

test.describe("Delete-Log Lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const tableName = `e2e_deletelog_${Date.now()}`;
  // Baseline captured before any CRDT-logged delete runs in this suite, so
  // the stats assertion can check an exact delta rather than a lower bound.
  let baselineDeleteCount = 0;

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
      { id: "row-1", label: "Keep Me", priority: 1 },
      { id: "row-2", label: "Delete Me", priority: 2 },
      { id: "row-3", label: "Also Keep", priority: 3 },
      { id: "row-4", label: "Silent Delete Me", priority: 4 },
    ]);

    const baselineStats = await vault.invokeTauriCommand<CrdtStats>(
      "crdt_get_stats",
      {}
    );
    baselineDeleteCount = baselineStats.deleteCount;
  });

  test.afterAll(async () => {
    await sql.dropTable(tableName);
  });

  test("DELETE via CRDT path appends row to haex_deleted_rows", async () => {
    await sql.remove(tableName, "id = ?", ["row-2"]);

    // Delete-log entry exists for the removed row
    const logged = await sql.isInDeleteLog(tableName, { id: "row-2" });
    expect(logged).toEqual(true);

    // A non-deleted row has no delete-log entry
    const notLogged = await sql.isInDeleteLog(tableName, { id: "row-1" });
    expect(notLogged).toEqual(false);
  });

  test("DELETE physically removes the row from the source table", async () => {
    // CRDT select: row is gone
    const crdtRows = await sql.select(tableName, ["id"], {
      where: "id = ?",
      params: ["row-2"],
    });
    expect(crdtRows).toHaveLength(0);

    // Raw select: still gone (delete-log model has no soft-delete)
    const rawRows = await sql.selectRaw(tableName, ["id"], {
      where: "id = ?",
      params: ["row-2"],
    });
    expect(rawRows).toHaveLength(0);
  });

  test("count reflects only the surviving rows", async () => {
    const activeCount = await sql.count(tableName);
    expect(activeCount).toEqual(3);

    const highPriorityCount = await sql.count(
      tableName,
      "priority >= ?",
      [3]
    );
    expect(highPriorityCount).toEqual(2);

    // The removed row (priority=2) is gone
    const removedPriorityCount = await sql.count(
      tableName,
      "priority = ?",
      [2]
    );
    expect(removedPriorityCount).toEqual(0);
  });

  test("re-insert of a previously removed PK succeeds without conflict", async () => {
    // In the delete-log model the row is physically gone, so the PK is free
    // immediately — no hardDelete needed to free it.
    await sql.insert(tableName, {
      id: "row-2",
      label: "Resurrected",
      priority: 10,
    });

    const row = await sql.selectFirst(tableName, ["id", "label", "priority"], {
      where: "id = ?",
      params: ["row-2"],
    });
    expect(row).toEqual(["row-2", "Resurrected", 10]);

    // The old delete-log entry is still present — that's expected; the cleanup
    // job prunes by HLC age, not on re-insert. The row's current liveness is
    // determined by whether it exists in the source table, not by absence from
    // the log.
    const stillLogged = await sql.isInDeleteLog(tableName, { id: "row-2" });
    expect(stillLogged).toEqual(true);
  });

  test("sql_execute DELETE bypasses the delete-log trigger", async () => {
    // hardDelete uses sql_execute which transactionally disables triggers, so
    // the BEFORE-DELETE trigger must not fire and no row must appear in the log.
    await sql.hardDelete(tableName, "id = ?", ["row-4"]);

    const rawRows = await sql.selectRaw(tableName, ["id"], {
      where: "id = ?",
      params: ["row-4"],
    });
    expect(rawRows).toHaveLength(0);

    const silentLogged = await sql.isInDeleteLog(tableName, { id: "row-4" });
    expect(silentLogged).toEqual(false);
  });

  test("crdt_get_stats.deleteCount reflects haex_deleted_rows size", async () => {
    // Add one more logged deletion so we can assert an exact delta against
    // the baseline captured in beforeAll.
    await sql.remove(tableName, "id = ?", ["row-3"]);

    // CrdtStats fields (camelCase via serde rename_all):
    //   totalEntries: total rows across CRDT-synced user tables
    //   applied: same as totalEntries in the delete-log model
    //   deleteCount: rows currently in haex_deleted_rows
    //   pendingUpload, pendingApply, insertCount, updateCount: compat fields
    const stats = await vault.invokeTauriCommand<CrdtStats>(
      "crdt_get_stats",
      {}
    );

    expect(typeof stats.deleteCount).toEqual("number");
    expect(typeof stats.applied).toEqual("number");
    expect(typeof stats.totalEntries).toEqual("number");

    // Exactly two logged deletes happened since the baseline: row-2 (in the
    // first test) and row-3 (just above). row-4 was removed silently via
    // sql_execute and must NOT contribute. An exact-delta check catches both
    // missing rows AND duplicate/stray log entries.
    expect(stats.deleteCount).toEqual(baselineDeleteCount + 2);

    // Total entries is strictly the count of live rows across all CRDT tables.
    expect(stats.totalEntries).toBeGreaterThan(0);
    expect(stats.applied).toEqual(stats.totalEntries);
  });
});
