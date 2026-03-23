import { test, expect, VaultAutomation } from "../fixtures";
import { SqlHelpers } from "../helpers";

const E2E_VAULT_NAME = "e2e-test-vault";
const E2E_VAULT_PASSWORD = "test-password-12345";

test.describe("vault-lifecycle: open-close-vault", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const testVaultName = `test-open-close-${Date.now()}`;
  const testVaultPassword = "open-close-password-456";
  const testTableName = "e2e_open_close_test_no_sync";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Close the currently open e2e-test-vault
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }

    // Create a fresh test vault for this suite
    await vault.invokeTauriCommand("create_encrypted_database", {
      vaultName: testVaultName,
      key: testVaultPassword,
      spaceId: null,
    });

    sql = new SqlHelpers(vault);
  });

  test.afterAll(async () => {
    // Clean up: close and delete test vault
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }

    try {
      await vault.invokeTauriCommand("delete_vault", { vaultName: testVaultName });
    } catch {
      // Best effort cleanup
    }

    // Reopen the original e2e-test-vault
    const vaults = await vault.invokeTauriCommand<Array<{ name: string; path: string }>>(
      "list_vaults",
      {}
    );
    const e2eVault = vaults.find((v) => v.name === E2E_VAULT_NAME);
    if (e2eVault) {
      await vault.invokeTauriCommand("open_encrypted_database", {
        vaultPath: e2eVault.path,
        key: E2E_VAULT_PASSWORD,
      });
    }
  });

  test("should write data to vault (create table and insert rows)", async () => {
    // Use _no_sync suffix to avoid CRDT overhead for this simple test
    await sql.createTable(
      testTableName,
      [
        { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
        { name: "label", type: "TEXT", notNull: true },
        { name: "value", type: "INTEGER", notNull: true },
      ],
      { withCrdt: false, ifNotExists: true }
    );

    // Insert test rows using raw execute (no-sync table)
    await sql.rawExecute(
      `INSERT INTO ${testTableName} (id, label, value) VALUES (?, ?, ?)`,
      [1, "alpha", 100]
    );
    await sql.rawExecute(
      `INSERT INTO ${testTableName} (id, label, value) VALUES (?, ?, ?)`,
      [2, "beta", 200]
    );
    await sql.rawExecute(
      `INSERT INTO ${testTableName} (id, label, value) VALUES (?, ?, ?)`,
      [3, "gamma", 300]
    );

    // Verify data was written
    const rows = await sql.rawSelect(
      `SELECT id, label, value FROM ${testTableName} ORDER BY id ASC`
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([1, "alpha", 100]);
    expect(rows[1]).toEqual([2, "beta", 200]);
    expect(rows[2]).toEqual([3, "gamma", 300]);
  });

  test("should fail SQL commands after closing the vault", async () => {
    await vault.invokeTauriCommand("close_database", {});

    // Any SQL command should fail on a closed database
    await expect(
      sql.rawSelect(`SELECT id, label, value FROM ${testTableName}`)
    ).rejects.toThrow();
  });

  test("should persist data after reopen", async () => {
    // Reopen the test vault
    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).not.toBeNull();

    await vault.invokeTauriCommand("open_encrypted_database", {
      vaultPath: targetVault!.path,
      key: testVaultPassword,
    });

    // Verify exact same data is still present
    const rows = await sql.rawSelect(
      `SELECT id, label, value FROM ${testTableName} ORDER BY id ASC`
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([1, "alpha", 100]);
    expect(rows[1]).toEqual([2, "beta", 200]);
    expect(rows[2]).toEqual([3, "gamma", 300]);
  });
});
