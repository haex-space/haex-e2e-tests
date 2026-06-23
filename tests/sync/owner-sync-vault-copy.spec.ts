import { expect, test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, sqlQuery } from "../helpers/ui/utils";
import {
  clearExchangedVault,
  copyVaultToDevice,
} from "../helpers/owner-sync/copy-vault";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

// Vault names MUST be unique across the rig (one name → one .db file per
// container). Deriving from Date.now() guarantees a fresh slate on every
// Playwright retry — leftover state from a failed attempt cannot collide.
const VAULT_NAME = `owner-sync-copy-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-copy-pw-1234";
const PWD_FROM_A_ID = "pw-from-a-001";
const PWD_FROM_A_SECRET = "secret-authored-on-a";
const PWD_FROM_B_ID = "pw-from-b-002";
const PWD_FROM_B_SECRET = "secret-authored-on-b";

/**
 * Owner-vault sync across the owner's own devices via the real-world
 * "user copies vault file to a new device" flow.
 *
 * Architecture under test (post-PR #511):
 * 1. Vault A is created via the full UI flow. The welcome onboarding
 *    registers A's `endpoint_id` in `haex_devices` under the owner DID.
 * 2. The vault is closed and its `.db` file is staged in the shared
 *    `/exchange` docker volume.
 * 3. Vault B ingests the file through its own `import_vault` Tauri
 *    command — the exact code path a real "Import vault" button would
 *    call. B then opens the imported vault through the standard UI.
 * 4. autostart from PR #511 fires `peer_storage_start` + `owner_sync_start`
 *    on both vaults. Convergence is the assertion.
 */
test.describe("sync: owner-vault via DB copy", () => {
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

  test("A: create vault and author a row", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_FROM_A_ID, PWD_FROM_A_SECRET],
    });

    // Sanity: A is in the expected pre-copy state — at least one device row
    // (its own, from welcome onboarding) and the password we just wrote.
    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_devices",
    );
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices[0]?.endpoint_id ?? "").not.toBe("");

    const rows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_FROM_A_ID],
    );
    expect(rows.length).toBe(1);
  });

  test("B: import A's vault file and open it through the UI", async () => {
    // copyVaultToDevice closes A's vault internally; we re-open A below so
    // subsequent assertions can keep talking to it.
    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);
    await initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD);

    // Post-import baseline: A's row from the copied DB must be present on
    // B (the floor we rely on for B → A connectivity). B's own row may or
    // may not be in there depending on whether the welcome dialog re-fires
    // on a copied-vault open — both outcomes are valid here.
    const bDevices = await sqlQuery<{ endpoint_id: string }>(
      vaultB,
      "SELECT endpoint_id FROM haex_devices",
    );
    expect(bDevices.length).toBeGreaterThanOrEqual(1);
  });

  test("A → B: B pulls A's existing row over the B-initiated connection", async () => {
    // autostart from PR #511 should have brought owner-sync up on B; nudge
    // it so we don't sit through the full poll interval.
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string; password: string }>(
          vaultB,
          "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
          [PWD_FROM_A_ID],
        );
        return rows.length === 1 && rows[0]?.password === PWD_FROM_A_SECRET
          ? rows
          : null;
      },
      {
        timeout: 60_000,
        interval: 1_500,
        label: `B pulls password ${PWD_FROM_A_ID} from A`,
      },
    );
  });

  test("B → A: A receives a row authored on B over the same connection", async () => {
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_FROM_B_ID, PWD_FROM_B_SECRET],
    });

    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string; password: string }>(
          vaultA,
          "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
          [PWD_FROM_B_ID],
        );
        return rows.length === 1 && rows[0]?.password === PWD_FROM_B_SECRET
          ? rows
          : null;
      },
      {
        timeout: 60_000,
        interval: 1_500,
        label: `A receives password ${PWD_FROM_B_ID} pushed from B`,
      },
    );

    // Both rows should now be visible on both sides (full convergence).
    const aRows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id IN (?1, ?2) ORDER BY id",
      [PWD_FROM_A_ID, PWD_FROM_B_ID],
    );
    expect(aRows.map((r) => r.id)).toEqual([PWD_FROM_A_ID, PWD_FROM_B_ID]);

    const bRows = await sqlQuery<{ id: string }>(
      vaultB,
      "SELECT id FROM haex_passwords_item_details WHERE id IN (?1, ?2) ORDER BY id",
      [PWD_FROM_A_ID, PWD_FROM_B_ID],
    );
    expect(bRows.map((r) => r.id)).toEqual([PWD_FROM_A_ID, PWD_FROM_B_ID]);
  });
});
