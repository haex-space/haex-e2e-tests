import { test, expect, VaultAutomation } from "../fixtures";
import { SqlHelpers } from "../helpers";

import { E2E_VAULT_NAME, E2E_VAULT_PASSWORD, restoreOriginalVault } from "./vault-constants";

test.describe("vault-lifecycle: change-password", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  const testVaultName = `test-change-pw-${Date.now()}`;
  const originalPassword = "original-password-111";
  const newPassword = "changed-password-222";
  const testTableName = "e2e_change_pw_test_no_sync";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Close the currently open e2e-test-vault
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }

    // Create a fresh test vault
    await vault.invokeTauriCommand("create_encrypted_database", {
      vaultName: testVaultName,
      key: originalPassword,
      spaceId: null,
    });

    sql = new SqlHelpers(vault);
  });

  test.afterAll(async () => {
    await restoreOriginalVault(vault, testVaultName);
  });

  test("should insert test data before password change", async () => {
    await sql.createTable(
      testTableName,
      [
        { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
        { name: "secret", type: "TEXT", notNull: true },
      ],
      { withCrdt: false, ifNotExists: true }
    );

    await sql.rawExecute(
      `INSERT INTO ${testTableName} (id, secret) VALUES (?, ?)`,
      [1, "confidential-data-A"]
    );
    await sql.rawExecute(
      `INSERT INTO ${testTableName} (id, secret) VALUES (?, ?)`,
      [2, "confidential-data-B"]
    );

    const rows = await sql.rawSelect(
      `SELECT id, secret FROM ${testTableName} ORDER BY id ASC`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1, "confidential-data-A"]);
    expect(rows[1]).toEqual([2, "confidential-data-B"]);
  });

  test("should change the vault password", async () => {
    const result = await vault.invokeTauriCommand<string>("change_vault_password", {
      newPassword,
    });

    expect(typeof result).toEqual("string");
  });

  test("should reopen vault with new password and find data intact", async () => {
    await vault.invokeTauriCommand("close_database", {});

    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).toBeDefined();

    // Open with new password
    const vaultId = await vault.invokeTauriCommand<string>("open_encrypted_database", {
      vaultPath: targetVault!.path,
      key: newPassword,
    });
    expect(typeof vaultId).toBe("string");
    expect(vaultId.length).toBeGreaterThan(0);
    expect(vaultId).toContain(".db"); // Returns vault file path

    // Verify data survived the password change
    const rows = await sql.rawSelect(
      `SELECT id, secret FROM ${testTableName} ORDER BY id ASC`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1, "confidential-data-A"]);
    expect(rows[1]).toEqual([2, "confidential-data-B"]);
  });

  test("should reject old password after password change", async () => {
    await vault.invokeTauriCommand("close_database", {});

    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).toBeDefined();

    await expect(
      vault.invokeTauriCommand("open_encrypted_database", {
        vaultPath: targetVault!.path,
        key: originalPassword,
      })
    ).rejects.toThrow();
  });
});
