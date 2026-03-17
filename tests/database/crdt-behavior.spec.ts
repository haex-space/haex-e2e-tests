import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers, CRDT_COLUMNS } from "../helpers";

test.describe("CRDT Behavior", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const crdtTable = `e2e_crdt_${Date.now()}`;
  const noCrdtTable = `e2e_nocrdt_${Date.now()}`;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    sql = createSqlHelpers(vault);
  });

  test.afterAll(async () => {
    await sql.dropTable(crdtTable);
    await sql.dropTable(noCrdtTable);
  });

  test("create table with CRDT adds CRDT columns", async () => {
    await sql.createTable(
      crdtTable,
      [
        { name: "id", type: "TEXT", primaryKey: true, notNull: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "value", type: "INTEGER", default: 0 },
      ],
      { withCrdt: true }
    );

    // After creating a new CRDT table, triggers must be set up so that INSERT/UPDATE
    // operations populate haex_column_hlcs and mark the table as dirty.
    await vault.invokeTauriCommand("ensure_extension_triggers", {});

    const tableInfo = await sql.getTableInfo(crdtTable);
    // tableInfo rows: [cid, name, type, notnull, dflt_value, pk]
    const columnNames = tableInfo.map((row) => row[1] as string);

    expect(columnNames).toContain(CRDT_COLUMNS.TIMESTAMP);
    expect(columnNames).toContain(CRDT_COLUMNS.COLUMN_HLCS);
    expect(columnNames).toContain(CRDT_COLUMNS.TOMBSTONE);

    // Also verify user columns are present
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("title");
    expect(columnNames).toContain("value");
  });

  test("create table WITHOUT CRDT does NOT add CRDT columns", async () => {
    await sql.createTable(
      noCrdtTable,
      [
        { name: "id", type: "TEXT", primaryKey: true, notNull: true },
        { name: "data", type: "TEXT" },
      ],
      { withCrdt: false }
    );

    const tableInfo = await sql.getTableInfo(noCrdtTable);
    const columnNames = tableInfo.map((row) => row[1] as string);

    expect(columnNames).not.toContain(CRDT_COLUMNS.TIMESTAMP);
    expect(columnNames).not.toContain(CRDT_COLUMNS.COLUMN_HLCS);
    expect(columnNames).not.toContain(CRDT_COLUMNS.TOMBSTONE);

    // User columns must still be present
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("data");
  });

  test("INSERT sets haex_timestamp via selectRaw", async () => {
    await sql.insert(crdtTable, { id: "crdt-1", title: "Test Entry", value: 42 });

    const rows = await sql.selectRaw(
      crdtTable,
      ["id", CRDT_COLUMNS.TIMESTAMP, CRDT_COLUMNS.TOMBSTONE],
      { where: "id = ?", params: ["crdt-1"] }
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const id = row[0];
    const timestamp = row[1];
    const tombstone = row[2];
    expect(id).toEqual("crdt-1");
    // HLC timestamp: could be ISO string (2024-...), Unix numeric, or HLC format (<ISO>:<counter>:<nodeId>)
    expect(timestamp).not.toBeNull();
    expect(timestamp).not.toBeUndefined();
    if (typeof timestamp === "string") {
      expect(timestamp.length).toBeGreaterThan(0);
    } else if (typeof timestamp === "number") {
      expect(timestamp).toBeGreaterThan(0);
    }
    // Active rows may have tombstone = 0 or null depending on vault version
    expect([0, null]).toContain(tombstone);
  });

  test("UPDATE single column updates haex_column_hlcs for that column", async () => {
    // Get HLC state before update
    const beforeRows = await sql.selectRaw(
      crdtTable,
      [CRDT_COLUMNS.COLUMN_HLCS],
      { where: "id = ?", params: ["crdt-1"] }
    );
    expect(beforeRows).toHaveLength(1);
    const hlcsBefore = beforeRows[0]![0] as string;

    // Update only the title column
    await sql.update(crdtTable, { title: "Updated Entry" }, "id = ?", ["crdt-1"]);

    // Get HLC state after update
    const afterRows = await sql.selectRaw(
      crdtTable,
      [CRDT_COLUMNS.COLUMN_HLCS, CRDT_COLUMNS.TIMESTAMP],
      { where: "id = ?", params: ["crdt-1"] }
    );
    expect(afterRows).toHaveLength(1);
    const hlcsAfter = afterRows[0]![0] as string;
    const timestampAfter = afterRows[0]![1] as string;

    // Column HLCs should have changed after the update
    expect(hlcsAfter).not.toEqual(hlcsBefore);

    // Timestamp should be a valid non-empty string
    expect(typeof timestampAfter).toEqual("string");
    expect(timestampAfter.length).toBeGreaterThan(0);

    // Verify the actual value was updated
    const dataRow = await sql.selectFirst(crdtTable, ["title"], {
      where: "id = ?",
      params: ["crdt-1"],
    });
    expect(dataRow).toEqual(["Updated Entry"]);
  });

  test("INSERT causes table to appear in dirty tables", async () => {
    // Insert a new row to ensure the table is dirty
    await sql.insert(crdtTable, { id: "crdt-2", title: "Dirty Check", value: 99 });

    const dirtyTables = await vault.invokeTauriCommand<
      Array<{ tableName: string; lastModified: string }>
    >("get_dirty_tables", {});

    const ourTable = dirtyTables.find((t) => t.tableName === crdtTable);
    expect(ourTable).not.toBeUndefined();
    expect(ourTable!.tableName).toEqual(crdtTable);
    expect(typeof ourTable!.lastModified).toEqual("string");
  });

  test("clear_dirty_table removes table from dirty tables", async () => {
    await vault.invokeTauriCommand("clear_dirty_table", {
      tableName: crdtTable,
    });

    const dirtyTables = await vault.invokeTauriCommand<
      Array<{ tableName: string; lastModified: string }>
    >("get_dirty_tables", {});

    const ourTable = dirtyTables.find((t) => t.tableName === crdtTable);
    expect(ourTable).toBeUndefined();
  });

  test("get_all_crdt_tables includes our CRDT test table", async () => {
    const crdtTables = await vault.invokeTauriCommand<string[]>(
      "get_all_crdt_tables",
      {}
    );

    expect(crdtTables).toContain(crdtTable);
    expect(crdtTables).not.toContain(noCrdtTable);
  });
});
