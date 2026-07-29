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
 * Owner-vault sync — pure P2P CREATE convergence.
 *
 * Companion to `owner-sync-vault-copy.spec.ts`: that spec authors a row
 * BEFORE the vault is copied, so on B the row arrives via the imported
 * `.db` file — not via P2P sync. If the CRDT apply-path silently drops
 * owner-private writes (as the vault PR #735 regression did — it started
 * enforcing signatures on owner-sync where the write side does not sign),
 * that pre-existing row masks the bug because it was never subject to the
 * apply-gate.
 *
 * This spec closes that hole:
 *   1. Copy A → B while A is EMPTY (no user rows). The copy is only a
 *      device-pairing shortcut — post-copy both sides share the owner DID
 *      but neither has any user data to be masked by.
 *   2. AFTER both vaults are open and owner-sync autostart has connected,
 *      A writes a fresh `haex_passwords_item_details` row.
 *   3. B must receive the row via a P2P sync cycle. This forces the row
 *      through the CRDT apply-gate on the receiver — the exact code path
 *      PR #735 broke.
 */

const VAULT_NAME = `owner-sync-create-p2p-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-create-p2p-pw-1234";
const PWD_ID = "pw-created-post-copy";
const PWD_SECRET = "secret-authored-after-pairing";

test.describe("sync: owner-vault CREATE via P2P (post-pairing)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Reset both webviews out of any /vault/... URL a sibling suite may
    // have left behind — same reasoning as owner-sync-vault-copy.spec.ts.
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

  test("setup: pair A and B via empty-vault copy (no user rows seeded)", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    // Sanity: A has an haex_devices row from welcome onboarding but no
    // password rows yet. If a sibling suite left rows behind under the same
    // vault name this assertion catches it BEFORE we base the whole test on
    // a bad baseline.
    const initialRows = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(initialRows.length).toBe(0);

    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await diagnosed(vaultA, "reopen-A-after-copy", () =>
      initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD),
    );
    await diagnosed(vaultB, "open-B-imported", () =>
      initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD),
    );

    // Post-copy baseline: both sides know each other as devices (autostart
    // in PR #511 fires peer_storage_start), and neither carries the target
    // password row yet. If we saw the row here that would mean either the
    // copy replicated user rows we didn't seed (impossible) or the vault
    // name collided with a prior suite's leftover state (fatal).
    await dumpSyncState(vaultA, "create-p2p/post-import");
    await dumpSyncState(vaultB, "create-p2p/post-import");
  });

  test("A creates a row AFTER pairing; B pulls it via P2P sync", async () => {
    // Nudge autostart's poll loop so we don't wait for the interval.
    await vaultA.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    // This INSERT runs POST-copy, so the row is NOT in B's imported .db.
    // The only path onto B is CRDT-apply on the receiver — which is
    // exactly the surface PR #735 accidentally started dropping when the
    // apply-gate demanded signatures on owner-private writes.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_ID, PWD_SECRET],
    });

    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "create-p2p/A->B",
      () => pollUntil(
        async () => {
          const rows = await sqlQuery<{ id: string; password: string }>(
            vaultB,
            "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
            [PWD_ID],
          );
          return rows.length === 1 && rows[0]?.password === PWD_SECRET
            ? rows
            : null;
        },
        {
          timeout: 60_000,
          interval: 1_500,
          label: `B pulls post-pairing INSERT ${PWD_ID}`,
        },
      ),
    );

    // Author side is unambiguous — assert it too so a failure surfaces
    // the "A never wrote" case distinct from the "A wrote, B didn't
    // apply" case.
    const aRows = await sqlQuery<{ id: string; password: string }>(
      vaultA,
      "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(aRows.length).toBe(1);
    expect(aRows[0]?.password).toBe(PWD_SECRET);
  });
});
