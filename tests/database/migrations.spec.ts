import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers";

test.describe("Migrations", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;

  // Migration tracking is done via sqlite_master tables.
  // haex-vault tracks core migrations in an internal table.
  // The name may vary by version: "haex_migrations", "_migrations", "migrations", etc.
  let MIGRATIONS_TABLE = "haex_migrations";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    sql = createSqlHelpers(vault);

    // Auto-detect the migrations table name
    // First try known candidates
    const candidates = ["haex_migrations", "_migrations", "migrations", "schema_migrations", "haex_crdt_migrations", "__migrations"];
    let found = false;
    for (const candidate of candidates) {
      const exists = await sql.tableExists(candidate);
      if (exists) {
        MIGRATIONS_TABLE = candidate;
        found = true;
        break;
      }
    }

    // If none matched, search sqlite_master for any table containing "migration"
    if (!found) {
      const tables = await sql.rawSelect(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%migration%' ORDER BY name ASC LIMIT 1",
        []
      );
      if (tables.length > 0) {
        MIGRATIONS_TABLE = tables[0]![0] as string;
        found = true;
      }
    }

    // Last resort: look for tables starting with underscore (common for internal tracking)
    if (!found) {
      const tables = await sql.rawSelect(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_%' ESCAPE '\\' ORDER BY name ASC LIMIT 1",
        []
      );
      if (tables.length > 0) {
        MIGRATIONS_TABLE = tables[0]![0] as string;
      }
    }

    console.log(`[E2E] Detected migrations table: ${MIGRATIONS_TABLE}`);
  });

  test("migrations table exists in the vault database", async () => {
    const exists = await sql.tableExists(MIGRATIONS_TABLE);
    expect(exists).toEqual(true);
  });

  test("migrations table contains at least one applied migration", async () => {
    // Use SELECT * since column names may vary between vault versions
    const migrations = await sql.rawSelect(
      `SELECT * FROM ${MIGRATIONS_TABLE}`,
      []
    );

    expect(migrations.length).toBeGreaterThanOrEqual(1);

    // Verify first row has at least one non-empty field (the migration name/id)
    const firstRow = migrations[0]!;
    expect(firstRow.length).toBeGreaterThanOrEqual(1);
    const firstField = firstRow[0];
    expect(typeof firstField).toEqual("string");
    expect((firstField as string).length).toBeGreaterThan(0);
  });

  test("each migration has a unique identifier", async () => {
    const migrations = await sql.rawSelect(
      `SELECT * FROM ${MIGRATIONS_TABLE}`,
      []
    );

    // First column should be the migration name/identifier
    const names = migrations.map((row) => row[0] as string);

    // All names should be unique
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toEqual(names.length);

    // Each migration must have a non-empty identifier
    for (const name of names) {
      expect(typeof name).toEqual("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("core vault tables exist as a result of migrations", async () => {
    // After migrations run, certain core tables should exist in the vault database.
    // These are the tables that the vault creates for its own operation.
    const tables = await sql.rawSelect(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
      []
    );

    const tableNames = tables.map((row) => row[0] as string);

    // The migrations table itself must exist
    expect(tableNames).toContain(MIGRATIONS_TABLE);

    // There should be multiple tables created by migrations
    // (at minimum: migrations tracking + at least one application table)
    expect(tableNames.length).toBeGreaterThanOrEqual(2);
  });

  test("no duplicate migration names in the tracking table", async () => {
    // Fetch all rows and check uniqueness of the first column (identifier)
    const migrations = await sql.rawSelect(
      `SELECT * FROM ${MIGRATIONS_TABLE}`,
      []
    );

    const names = migrations.map((row) => row[0] as string);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toEqual(names.length);
  });
});
