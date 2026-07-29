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
 * Owner-vault sync — reverse direction UPDATE (B → A).
 *
 * The owner-sync loop has a push-side and a pull-side; a regression in one
 * without the other is a common failure shape (e.g., the receiver's
 * apply-gate is fixed but the pull cursor still filters out unsigned
 * writes). The A→B UPDATE case is covered by owner-sync-update-p2p.spec.ts
 * — this spec is the mirror image and guards against exactly that
 * asymmetry.
 *
 * `owner-sync-vault-copy.spec.ts` also exercises a B→A INSERT in its
 * final step, but bundled with an A→B pull test in the same describe. A
 * dedicated file makes the failure mode obvious in test output: if
 * `sync: owner-vault UPDATE via P2P` passes and `sync: owner-vault
 * REVERSE UPDATE via P2P` fails, the diagnosis is "push path broken, pull
 * path healthy" (or vice-versa depending on wire direction).
 */

const VAULT_NAME = `owner-sync-bidirectional-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-bidirectional-pw-1234";
const PWD_ID = "pw-reverse-update";
const PWD_INITIAL = "initial-authored-on-A";
const PWD_UPDATED = "updated-authored-on-B";

test.describe("sync: owner-vault REVERSE UPDATE via P2P (B → A)", () => {
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

  test("setup: pre-existing password row on both A and B", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_ID, PWD_INITIAL],
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
      "reverse-update/post-copy",
      () => pollUntil(
        async () => {
          const rows = await sqlQuery<{ id: string; password: string }>(
            vaultB,
            "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
            [PWD_ID],
          );
          return rows.length === 1 && rows[0]?.password === PWD_INITIAL
            ? rows
            : null;
        },
        {
          timeout: 60_000,
          interval: 1_500,
          label: `B has initial value for ${PWD_ID}`,
        },
      ),
    );
  });

  test("B updates the row; A converges to the new value via P2P", async () => {
    // The mutation happens on B — the opposite side from the update-p2p
    // spec. Any push/pull-asymmetric regression surfaces here.
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "UPDATE haex_passwords_item_details SET password = ?1 WHERE id = ?2",
      params: [PWD_UPDATED, PWD_ID],
    });

    await vaultA.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "reverse-update/B->A",
      () => pollUntil(
        async () => {
          const rows = await sqlQuery<{ id: string; password: string }>(
            vaultA,
            "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
            [PWD_ID],
          );
          return rows.length === 1 && rows[0]?.password === PWD_UPDATED
            ? rows
            : null;
        },
        {
          timeout: 60_000,
          interval: 1_500,
          label: `A sees updated password ${PWD_ID}`,
        },
      ),
    );

    const bRows = await sqlQuery<{ id: string; password: string }>(
      vaultB,
      "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(bRows.length).toBe(1);
    expect(bRows[0]?.password).toBe(PWD_UPDATED);

    await dumpSyncState(vaultA, "reverse-update/converged");
    await dumpSyncState(vaultB, "reverse-update/converged");
  });
});
