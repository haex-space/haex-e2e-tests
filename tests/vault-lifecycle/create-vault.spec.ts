import { test, expect, VaultAutomation } from "../fixtures";

const E2E_VAULT_NAME = "e2e-test-vault";
const E2E_VAULT_PASSWORD = "test-password-12345";

test.describe("vault-lifecycle: create-vault", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  const testVaultName = `test-create-vault-${Date.now()}`;
  const testVaultPassword = "create-vault-password-987";
  let createdVaultId: string | null = null;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Close the currently open e2e-test-vault so we can work with a fresh slate
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }
  });

  test.afterAll(async () => {
    // Clean up: delete test vault if it was created
    try {
      await vault.invokeTauriCommand("close_database", {});
    } catch {
      // May already be closed
    }

    if (createdVaultId) {
      try {
        await vault.invokeTauriCommand("delete_vault", { vaultName: testVaultName });
      } catch {
        // Best effort cleanup
      }
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

  test("should create a new vault and return a valid ID", async () => {
    const vaultId = await vault.invokeTauriCommand<string>("create_encrypted_database", {
      vaultName: testVaultName,
      key: testVaultPassword,
      spaceId: null,
    });

    expect(typeof vaultId).toBe("string");
    expect(vaultId.length).toBeGreaterThan(0);
    expect(vaultId).toContain(".db"); // Returns vault file path

    createdVaultId = vaultId;
  });

  test("should show newly created vault in list_vaults", async () => {
    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; lastAccess: number; path: string }>
    >("list_vaults", {});

    const createdVault = vaults.find((v) => v.name === testVaultName);
    expect(createdVault).not.toBeNull();
    expect(createdVault!.name).toEqual(testVaultName);
    expect(typeof createdVault!.path).toEqual("string");
    expect(createdVault!.path).toContain(testVaultName);
    expect(typeof createdVault!.lastAccess).toEqual("number");
  });

  test("should reject duplicate vault name", async () => {
    // Close current vault first so we can attempt creation
    await vault.invokeTauriCommand("close_database", {});

    await expect(
      vault.invokeTauriCommand("create_encrypted_database", {
        vaultName: testVaultName,
        key: "another-password",
        spaceId: null,
      })
    ).rejects.toThrow();
  });

  test("should open created vault with correct password", async () => {
    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).toBeDefined();

    const openedVaultId = await vault.invokeTauriCommand<string>("open_encrypted_database", {
      vaultPath: targetVault!.path,
      key: testVaultPassword,
    });

    expect(typeof openedVaultId).toBe("string");
    expect(openedVaultId.length).toBeGreaterThan(0);
    expect(openedVaultId).toContain(".db"); // Returns vault file path
  });

  test("should reject wrong password when opening vault", async () => {
    // Close the currently open vault first
    await vault.invokeTauriCommand("close_database", {});

    const vaults = await vault.invokeTauriCommand<
      Array<{ name: string; path: string }>
    >("list_vaults", {});
    const targetVault = vaults.find((v) => v.name === testVaultName);
    expect(targetVault).toBeDefined();

    await expect(
      vault.invokeTauriCommand("open_encrypted_database", {
        vaultPath: targetVault!.path,
        key: "wrong-password-xyz",
      })
    ).rejects.toThrow();
  });
});
