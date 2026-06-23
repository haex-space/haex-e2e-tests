import { expect, test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, sqlQuery } from "../helpers/ui/utils";
import {
  clearExchangedVault,
  copyVaultToDevice,
  resetVaultOnDevice,
} from "../helpers/owner-sync/copy-vault";

const VAULT_NAME = "owner-sync-copy";
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
 *    KNOWN GAP: the welcome dialog does NOT re-fire on an
 *    already-onboarded vault, so B's own device is NOT auto-registered
 *    into `haex_devices`. The planned new-device-detection drawer will
 *    fix this — at which point owner-sync becomes symmetric. Until then
 *    this spec exercises the asymmetric state a real DB copy produces
 *    today, and is written so it still passes once the gap is closed.
 * 4. autostart from PR #511 fires `peer_storage_start` + `owner_sync_start`
 *    on both vaults. Only B has a peer to connect to (A) — A's
 *    `owner_sync_start` is currently a no-op because B is unknown to A.
 *    The single B→A connection carries both push and pull, so both sides
 *    converge regardless.
 *
 * Specs in this file assert that bidirectional convergence is achieved
 * over the B-initiated connection alone.
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

    // Playwright reruns the whole describe.serial on retry, so a leftover
    // .db from a prior attempt would (a) make Step 1's INSERT hit a UNIQUE
    // constraint and (b) make Step 2's import_vault fail with
    // VaultAlreadyExists. Wipe both sides up-front so every attempt sees
    // truly empty vault dirs.
    await resetVaultOnDevice(vaultA, VAULT_NAME);
    await resetVaultOnDevice(vaultB, VAULT_NAME);
    await clearExchangedVault(VAULT_NAME).catch(() => {});
  });

  test.afterAll(async () => {
    await clearExchangedVault(VAULT_NAME).catch(() => {});
  });

  test("A: create vault and author a row", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_FROM_A_ID, PWD_FROM_A_SECRET],
    });

    // Confirm A is in the expected pre-copy state: exactly one device row
    // (its own, registered by the welcome onboarding) and exactly one
    // password row.
    const devices = await sqlQuery<{ endpoint_id: string }>(
      vaultA,
      "SELECT endpoint_id FROM haex_devices",
    );
    expect(devices.length).toBe(1);
    expect(devices[0]?.endpoint_id ?? "").not.toBe("");

    const rows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_FROM_A_ID],
    );
    expect(rows.length).toBe(1);
  });

  test("B: import A's vault file and open it through the UI", async () => {
    // Closes A's vault internally; we re-open it below so subsequent
    // assertions can keep talking to vault A.
    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);
    await initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD);

    // Post-import, A's row from the copied DB must be present on B (the
    // baseline for B → A connectivity below). B's OWN endpoint may or may
    // not be in there: today the welcome dialog does not re-fire on an
    // already-onboarded vault, so B is missing — a known gap the planned
    // new-device-detection drawer will close. We assert only the bound
    // that the existing code already enforces (A is present), so the spec
    // keeps passing when that gap is closed and `length` becomes 2.
    const bDevices = await sqlQuery<{ endpoint_id: string }>(
      vaultB,
      "SELECT endpoint_id FROM haex_devices",
    );
    expect(bDevices.length).toBeGreaterThanOrEqual(1);
  });

  test("A → B: B pulls A's existing row over the B-initiated connection", async () => {
    // autostart from PR #511 should have brought owner-sync up on B already.
    // Nudge it so we don't sit through the full poll interval, then poll
    // for convergence.
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {
      // Best-effort: if owner-sync isn't running yet, the force is a no-op;
      // the next start-up tick will bring it up.
    });

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

    // Owner-sync loops on B push on every cycle; force one so the assertion
    // doesn't have to wait out the default interval.
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
