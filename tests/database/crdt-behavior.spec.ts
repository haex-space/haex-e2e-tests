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

    expect(columnNames).toContain(CRDT_COLUMNS.HLC);
    expect(columnNames).toContain(CRDT_COLUMNS.COLUMN_HLCS);

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

    expect(columnNames).not.toContain(CRDT_COLUMNS.HLC);
    expect(columnNames).not.toContain(CRDT_COLUMNS.COLUMN_HLCS);

    // User columns must still be present
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("data");
  });

  test("INSERT sets haex_hlc via selectRaw", async () => {
    await sql.insert(crdtTable, { id: "crdt-1", title: "Test Entry", value: 42 });

    const rows = await sql.selectRaw(
      crdtTable,
      ["id", CRDT_COLUMNS.HLC],
      { where: "id = ?", params: ["crdt-1"] }
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const id = row[0];
    const hlc = row[1];
    expect(id).toEqual("crdt-1");
    expect(hlc).not.toBeNull();
    expect(hlc).not.toBeUndefined();
    // HLC format: "<u64-nanoseconds>/<hex-device-id>"
    expect(typeof hlc).toBe("string");
    expect((hlc as string).length).toBeGreaterThan(0);
    expect(hlc as string).toMatch(/^\d+\/[0-9a-fA-F]+$/);
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
    const parsedBefore = JSON.parse(hlcsBefore) as Record<string, string>;

    // Update only the title column
    await sql.update(crdtTable, { title: "Updated Entry" }, "id = ?", ["crdt-1"]);

    // Get HLC state after update
    const afterRows = await sql.selectRaw(
      crdtTable,
      [CRDT_COLUMNS.COLUMN_HLCS, CRDT_COLUMNS.HLC],
      { where: "id = ?", params: ["crdt-1"] }
    );
    expect(afterRows).toHaveLength(1);
    const hlcsAfter = afterRows[0]![0] as string;
    const rowHlcAfter = afterRows[0]![1] as string;
    const parsedAfter = JSON.parse(hlcsAfter) as Record<string, string>;

    // Column HLCs should have changed after the update
    expect(hlcsAfter).not.toEqual(hlcsBefore);

    // Per-column tracking: only the updated column's HLC changes,
    // unchanged columns keep their prior HLC.
    expect(parsedAfter.title).not.toEqual(parsedBefore.title);
    expect(parsedAfter.value).toEqual(parsedBefore.value);

    // Format validation: "<u64-nanoseconds>/<hex-device-id>" per
    // src-tauri/src/crdt/hlc.rs:compare_hlc_strings.
    const HLC_FORMAT = /^\d+\/[0-9a-fA-F]+$/;
    for (const [column, hlc] of Object.entries(parsedAfter)) {
      expect(hlc, `HLC for column "${column}" must match <nanos>/<nodeId>`).toMatch(HLC_FORMAT);
    }

    // Row-level HLC should match the HLC format too.
    expect(rowHlcAfter).toMatch(HLC_FORMAT);

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

  test("LWW: newer HLC wins, older HLC loses, per-column tracking holds", async () => {
    // All HLCs used in this test are produced by the vault's CRDT triggers —
    // the test never constructs an HLC string manually. This mirrors the real
    // sync flow where remote timestamps always originate from another device's
    // vault.

    // Read the per-column HLC map for a given row.
    const readColumnHlcs = async (rowId: string): Promise<Record<string, string>> => {
      const rows = await sql.selectRaw(
        crdtTable,
        [CRDT_COLUMNS.COLUMN_HLCS],
        { where: "id = ?", params: [rowId] }
      );
      expect(rows).toHaveLength(1);
      return JSON.parse(rows[0]![0] as string) as Record<string, string>;
    };

    // HLC strings look like "<u64-nanoseconds>/<node-id-hex>".
    // Compare the numeric time prefix with BigInt to avoid lexicographic
    // ordering glitches when the prefix length changes.
    const hlcIsNewer = (a: string, b: string): boolean => {
      const [aT = "0"] = a.split("/");
      const [bT = "0"] = b.split("/");
      return BigInt(aT) > BigInt(bT);
    };

    // Step 1: seed the target row and capture its insert-time HLC via the
    // `value` column (which stays untouched through the rest of the test).
    await sql.insert(crdtTable, { id: "lww-a", title: "initial", value: 10 });
    const hlcsAfterInsert = await readColumnHlcs("lww-a");
    const valueInsertHlc = hlcsAfterInsert.value!;
    expect(typeof valueInsertHlc).toBe("string");
    expect(valueInsertHlc.length).toBeGreaterThan(0);

    // Step 2: update only the title locally — title HLC must advance past the
    // insert HLC, while value HLC stays the same.
    await sql.update(crdtTable, { title: "local-winner" }, "id = ?", ["lww-a"]);
    const hlcsAfterLocalUpdate = await readColumnHlcs("lww-a");
    const localTitleHlc = hlcsAfterLocalUpdate.title!;
    expect(hlcIsNewer(localTitleHlc, valueInsertHlc)).toBe(true);
    expect(hlcsAfterLocalUpdate.value).toEqual(valueInsertHlc);

    // Step 3: source a fresh, strictly-newer HLC from an unrelated insert.
    await sql.insert(crdtTable, { id: "lww-b", title: "seed", value: 0 });
    const hlcsForFreshRow = await readColumnHlcs("lww-b");
    const freshHlc = hlcsForFreshRow.title!;
    expect(hlcIsNewer(freshHlc, localTitleHlc)).toBe(true);

    // Step 4: apply a remote change with an HLC older than title's local HLC.
    // LWW must reject it: the row's title stays "local-winner".
    await vault.invokeTauriCommand("apply_remote_changes_in_transaction", {
      changes: [
        {
          tableName: crdtTable,
          rowPks: JSON.stringify({ id: "lww-a" }),
          columnName: "title",
          hlcTimestamp: valueInsertHlc,
          decryptedValue: "should-not-win",
        },
      ],
      backendId: "lww-test-backend",
      maxHlc: valueInsertHlc,
    });
    const afterOlderRemote = await sql.selectFirst(crdtTable, ["title"], {
      where: "id = ?",
      params: ["lww-a"],
    });
    expect(afterOlderRemote).toEqual(["local-winner"]);

    // Step 5: apply a remote change with an HLC newer than title's local HLC.
    // LWW must accept it: the row's title becomes "remote-winner".
    await vault.invokeTauriCommand("apply_remote_changes_in_transaction", {
      changes: [
        {
          tableName: crdtTable,
          rowPks: JSON.stringify({ id: "lww-a" }),
          columnName: "title",
          hlcTimestamp: freshHlc,
          decryptedValue: "remote-winner",
        },
      ],
      backendId: "lww-test-backend",
      maxHlc: freshHlc,
    });
    const afterNewerRemote = await sql.selectFirst(crdtTable, ["title"], {
      where: "id = ?",
      params: ["lww-a"],
    });
    expect(afterNewerRemote).toEqual(["remote-winner"]);

    // Step 6: per-column tracking — title's HLC advanced to the remote HLC,
    // but the value column HLC is still the original insert HLC because no
    // change ever touched it.
    const finalHlcs = await readColumnHlcs("lww-a");
    expect(finalHlcs.title).toEqual(freshHlc);
    expect(finalHlcs.value).toEqual(valueInsertHlc);
  });
});
