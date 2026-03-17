import { test, expect, VaultAutomation } from "../fixtures";

const E2E_VAULT_NAME = "e2e-test-vault";
const E2E_VAULT_PASSWORD = "test-password-12345";

test.describe("vault-lifecycle: delete-vault", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  const testVaultName = `test-delete-vault-${Date.now()}`;
  const testVaultPassword = "delete-vault-password-789";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Close the currently open e2e-test-vault
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }
  });

  test.afterAll(async () => {
    // Ensure test vault is cleaned up in case a test failed midway
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }

    try {
      await vault.invokeTauriCommand("delete_vault", { vaultName: testVaultName });
    } catch {
      // May already be deleted
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

  test("should create a vault for deletion testing", async () => {
    const vaultId = await vault.invokeTauriCommand<string>("create_encrypted_database", {
      vaultName: testVaultName,
      key: testVaultPassword,
      vaultId: null,
    });

    expect(typeof vaultId).toBe("string");
    expect(vaultId.length).toBeGreaterThan(0);
    expect(vaultId).toContain(".db"); // Returns vault file path

    // Close it so it can be deleted
    await vault.invokeTauriCommand("close_database", {});
  });

  test("should confirm vault exists before deletion", async () => {
    const exists = await vault.invokeTauriCommand<boolean>("vault_exists", {
      vaultName: testVaultName,
    });
    expect(exists).toEqual(true);

    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; lastAccess: number; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).not.toBeNull();
    expect(targetVault!.name).toEqual(testVaultName);
  });

  test("should delete the vault", async () => {
    const result = await vault.invokeTauriCommand<string>("delete_vault", {
      vaultName: testVaultName,
    });

    expect(typeof result).toEqual("string");
  });

  test("should confirm vault is gone after deletion", async () => {
    const exists = await vault.invokeTauriCommand<boolean>("vault_exists", {
      vaultName: testVaultName,
    });
    expect(exists).toEqual(false);

    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; lastAccess: number; path: string }>
    >("list_vaults", {});
    const deletedVault = vaults.find((v) => v.name === testVaultName);
    expect(deletedVault).toBeUndefined();
  });
});
