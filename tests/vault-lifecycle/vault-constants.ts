import type { VaultAutomation } from "../fixtures";

/**
 * Name of the long-lived vault created by `global-setup.ts` and shared
 * across every test suite. All vault-lifecycle specs close it temporarily,
 * exercise their own short-lived test vault, and must re-open this one
 * in afterAll so downstream suites find the same baseline state.
 */
export const E2E_VAULT_NAME = "e2e-test-vault";
export const E2E_VAULT_PASSWORD = "test-password-12345";

/**
 * Clean up a transient test vault and re-open the shared baseline vault.
 * Safe to call when the test vault was never created (delete_vault errors
 * are swallowed) and when the database is already closed.
 *
 * @param vault          The session driving the cleanup
 * @param testVaultName  Name of the short-lived vault to delete (best-effort)
 */
export async function restoreOriginalVault(
  vault: VaultAutomation,
  testVaultName: string,
): Promise<void> {
  try {
    await vault.invokeTauriCommand("close_database", {});
  } catch {
    /* may already be closed */
  }
  try {
    await vault.invokeTauriCommand("delete_vault", { vaultName: testVaultName });
  } catch {
    /* may already be deleted, or never created */
  }

  const vaults = await vault.invokeTauriCommand<
    Array<{ name: string; path: string }>
  >("list_vaults", {});
  const e2eVault = vaults.find((v) => v.name === E2E_VAULT_NAME);
  if (e2eVault) {
    await vault.invokeTauriCommand("open_encrypted_database", {
      vaultPath: e2eVault.path,
      key: E2E_VAULT_PASSWORD,
    });
  } else {
    console.warn(
      `[E2E] restoreOriginalVault: baseline "${E2E_VAULT_NAME}" not in list_vaults — downstream suites will run without it`,
    );
  }
}
