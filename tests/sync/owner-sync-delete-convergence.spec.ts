import { expect, test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, sqlQuery, wait } from "../helpers/ui/utils";
import {
  clearExchangedVault,
  copyVaultToDevice,
} from "../helpers/owner-sync/copy-vault";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

const VAULT_NAME = `owner-sync-delete-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-delete-pw-1234";
const PWD_ID = "pw-delete-target";
const PWD_SECRET = "secret-to-be-deleted";

/**
 * Delete-convergence + resurrection protection (Path B, PR #494).
 *
 * Sets up identical rows on A and B (via a vault copy), deletes on one
 * side, and verifies (a) the delete reaches the other side and (b) the
 * row stays gone after multiple sync cycles. A resurrected row
 * (regression of #494) would show up as a re-appeared row with the same
 * primary key.
 */
test.describe("sync: owner-vault delete convergence", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    await clearExchangedVault(VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultA, VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultB, VAULT_NAME).catch(() => {});
  });

  test("setup: shared vault on A and B with one password row", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_ID, PWD_SECRET],
    });

    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);
    await initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD);

    // Confirm both sides see the row before we touch anything.
    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string }>(
          vaultB,
          "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
          [PWD_ID],
        );
        return rows.length === 1 ? rows : null;
      },
      { timeout: 60_000, interval: 1_500, label: "B has pre-delete row" },
    );
  });

  test("delete on A converges to B and stays deleted after multiple sync cycles", async () => {
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "DELETE FROM haex_passwords_item_details WHERE id = ?1",
      params: [PWD_ID],
    });

    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string }>(
          vaultB,
          "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
          [PWD_ID],
        );
        return rows.length === 0 ? true : null;
      },
      { timeout: 60_000, interval: 1_500, label: "B sees the delete" },
    );

    const aRowsAfterDelete = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(aRowsAfterDelete.length).toBe(0);

    // Force several more sync cycles. The PR #494 guard MUST keep the row
    // gone even when stale state gets exchanged again.
    for (let i = 0; i < 4; i++) {
      await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
      await wait(2_000);
    }

    const aFinal = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    const bFinal = await sqlQuery<{ id: string }>(
      vaultB,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(aFinal.length).toBe(0);
    expect(bFinal.length).toBe(0);
  });
});
