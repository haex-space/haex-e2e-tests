import { expect, test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, sqlQuery, wait } from "../helpers/ui/utils";
import {
  clearExchangedVault,
  copyVaultToDevice,
} from "../helpers/owner-sync/copy-vault";
import {
  diagnosed,
  diagnosedSync,
  dumpSyncState,
} from "../helpers/owner-sync/diagnostics";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

/**
 * Owner-vault sync — restart resilience.
 *
 * The delete-convergence and update specs verify convergence with both
 * vaults running continuously. Some regressions only surface when the
 * receiver had NO in-memory state at write-time — e.g., an apply-gate
 * that decides at connect-time whether to accept unsigned rows and
 * caches the decision. Restarting the receiver AFTER the write forces
 * that decision to be made fresh from persistent state.
 *
 * We can't kill the docker container from a spec, but `close_database`
 * followed by re-open via `initializeVaultViaUI` tears down the
 * AppState (peer_storage, owner_sync, mesh) and rebuilds it — the same
 * boot path a container restart would follow. That's the closest
 * proxy the harness provides today.
 */

const VAULT_NAME = `owner-sync-restart-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-restart-pw-1234";
const PWD_ID = "pw-restart-target";
const PWD_SECRET = "will-be-deleted-then-B-restarts";

test.describe("sync: owner-vault convergence across B restart", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    for (const v of [vaultA, vaultB]) {
      await v.invokeTauriCommand("close_database", {}).catch(() => {});
      await v.navigateTo("/");
    }
    await wait(1000);
  });

  test.afterAll(async () => {
    await clearExchangedVault(VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultA, VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultB, VAULT_NAME).catch(() => {});
  });

  test("setup: password row on both sides", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_ID, PWD_SECRET],
    });

    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await diagnosed(vaultA, "reopen-A-after-copy", () =>
      initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD),
    );
    await diagnosed(vaultB, "open-B-imported", () =>
      initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD),
    );

    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "restart/pre-delete",
      () => pollUntil(
        async () => {
          const rows = await sqlQuery<{ id: string }>(
            vaultB,
            "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
            [PWD_ID],
          );
          return rows.length === 1 ? rows : null;
        },
        {
          timeout: 60_000,
          interval: 1_500,
          label: "B has pre-delete row",
        },
      ),
    );
  });

  test(
    "DELETE on A, restart B, verify B converges after re-boot",
    async () => {
      // A performs the DELETE while B is up. We deliberately do NOT
      // wait for convergence here — the whole point is to force B to
      // apply the change AFTER its restart, from cold state.
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: "DELETE FROM haex_passwords_item_details WHERE id = ?1",
        params: [PWD_ID],
      });

      // Tear B down. close_database drops AppState; navigate("/") clears
      // the cached /vault/... URL so the re-open via initializeVaultViaUI
      // goes through the picker again (fresh onboarding path).
      await vaultB.invokeTauriCommand("close_database", {}).catch(() => {});
      await vaultB.navigateTo("/");
      await wait(2000);

      // Bring B back. This re-fires the PR #511 autostart:
      // peer_storage_start + owner_sync_start from a cold AppState.
      await diagnosed(vaultB, "restart/reopen-B", () =>
        initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD),
      );

      // Give autostart a beat to bring the endpoint up, then nudge it.
      await wait(3000);
      await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

      await diagnosedSync(
        { a: vaultA, b: vaultB },
        "restart/post-boot-converge",
        () => pollUntil(
          async () => {
            const rows = await sqlQuery<{ id: string }>(
              vaultB,
              "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
              [PWD_ID],
            );
            return rows.length === 0 ? true : null;
          },
          {
            timeout: 90_000,
            interval: 2_000,
            label: "B (restarted) converges to the delete",
          },
        ),
      );

      const aFinal = await sqlQuery<{ id: string }>(
        vaultA,
        "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
        [PWD_ID],
      );
      expect(aFinal.length).toBe(0);

      await dumpSyncState(vaultA, "restart/final");
      await dumpSyncState(vaultB, "restart/final");
    },
  );
});
