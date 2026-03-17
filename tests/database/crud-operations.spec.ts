import { test, expect, VaultAutomation } from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers";

test.describe("CRUD Operations", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const tableName = `e2e_crud_${Date.now()}`;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
    sql = createSqlHelpers(vault);

    await sql.createTable(
      tableName,
      [
        { name: "id", type: "TEXT", primaryKey: true, notNull: true },
        { name: "name", type: "TEXT", notNull: true },
        { name: "email", type: "TEXT" },
        { name: "age", type: "INTEGER" },
      ],
      { withCrdt: true }
    );
  });

  test.afterAll(async () => {
    await sql.dropTable(tableName);
  });

  test("INSERT single row and SELECT returns exact values", async () => {
    await sql.insert(tableName, {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
      age: 30,
    });

    const rows = await sql.select(tableName, ["id", "name", "email", "age"], {
      where: "id = ?",
      params: ["user-1"],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(["user-1", "Alice", "alice@example.com", 30]);
  });

  test("INSERT multiple rows and SELECT returns all with correct order", async () => {
    await sql.insertMany(tableName, [
      { id: "user-2", name: "Bob", email: "bob@example.com", age: 25 },
      { id: "user-3", name: "Charlie", email: "charlie@example.com", age: 35 },
      { id: "user-4", name: "Diana", email: "diana@example.com", age: 28 },
    ]);

    const rows = await sql.select(tableName, ["id", "name"], {
      orderBy: "name ASC",
    });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual(["user-1", "Alice"]);
    expect(rows[1]).toEqual(["user-2", "Bob"]);
    expect(rows[2]).toEqual(["user-3", "Charlie"]);
    expect(rows[3]).toEqual(["user-4", "Diana"]);
  });

  test("UPDATE row and SELECT returns new value", async () => {
    await sql.update(tableName, { name: "Alice Smith", age: 31 }, "id = ?", [
      "user-1",
    ]);

    const row = await sql.selectFirst(tableName, ["id", "name", "age"], {
      where: "id = ?",
      params: ["user-1"],
    });

    expect(row).toEqual(["user-1", "Alice Smith", 31]);
  });

  test("SELECT with WHERE returns only matching rows", async () => {
    const rows = await sql.select(tableName, ["id", "name"], {
      where: "age >= ?",
      params: [30],
      orderBy: "age ASC",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["user-1", "Alice Smith"]);
    expect(rows[1]).toEqual(["user-3", "Charlie"]);
  });

  test("SELECT with WHERE does NOT return non-matching rows", async () => {
    const rows = await sql.select(tableName, ["id"], {
      where: "age > ?",
      params: [100],
    });

    expect(rows).toHaveLength(0);

    // Also verify a specific row known to not match
    const specificRows = await sql.select(tableName, ["id", "name"], {
      where: "name = ?",
      params: ["NonExistentUser"],
    });

    expect(specificRows).toHaveLength(0);
  });

  test("SELECT with ORDER BY, LIMIT and OFFSET returns correct subset", async () => {
    // All 4 rows ordered by age ASC: Bob(25), Diana(28), Alice(31), Charlie(35)
    const firstTwo = await sql.select(tableName, ["id", "name", "age"], {
      orderBy: "age ASC",
      limit: 2,
    });

    expect(firstTwo).toHaveLength(2);
    expect(firstTwo[0]).toEqual(["user-2", "Bob", 25]);
    expect(firstTwo[1]).toEqual(["user-4", "Diana", 28]);

    // Skip first 2, take next 2
    const lastTwo = await sql.select(tableName, ["id", "name", "age"], {
      orderBy: "age ASC",
      limit: 2,
      offset: 2,
    });

    expect(lastTwo).toHaveLength(2);
    expect(lastTwo[0]).toEqual(["user-1", "Alice Smith", 31]);
    expect(lastTwo[1]).toEqual(["user-3", "Charlie", 35]);

    // Offset past all rows returns empty
    const empty = await sql.select(tableName, ["id"], {
      orderBy: "age ASC",
      limit: 10,
      offset: 100,
    });

    expect(empty).toHaveLength(0);
  });

  test("COUNT matches actual row count", async () => {
    const totalCount = await sql.count(tableName);
    expect(totalCount).toEqual(4);

    const filteredCount = await sql.count(tableName, "age >= ?", [30]);
    expect(filteredCount).toEqual(2);

    const zeroCount = await sql.count(tableName, "age > ?", [100]);
    expect(zeroCount).toEqual(0);
  });
});
