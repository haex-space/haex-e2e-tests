import { test, expect, VaultAutomation } from "../fixtures";
import { restoreOriginalVault } from "./vault-constants";

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
    await restoreOriginalVault(vault, testVaultName);
  });

  test("should create a vault for deletion testing", async () => {
    const vaultId = await vault.invokeTauriCommand<string>("create_encrypted_database", {
      vaultName: testVaultName,
      key: testVaultPassword,
      spaceId: null,
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
    expect(targetVault).toBeDefined();
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
