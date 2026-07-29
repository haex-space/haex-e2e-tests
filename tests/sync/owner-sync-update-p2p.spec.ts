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
 * Owner-vault sync — UPDATE convergence via P2P.
 *
 * A CREATE + UPDATE pair is a common regression shape: the row exists on
 * both sides, then A mutates one column and B must observe the new value.
 * The convergence question here is different from CREATE: the receiver
 * already has a row for that primary key, and the CRDT layer must apply
 * the newer per-column HLC over the existing one.
 *
 * Coverage gap addressed: PR #735's apply-gate regression would silently
 * drop unsigned owner-private writes. On UPDATE the surface is stealthier
 * than CREATE — B keeps showing the OLD column value with no other
 * observable change ("update never landed") rather than a missing row.
 * We exercise it here explicitly.
 */

const VAULT_NAME = `owner-sync-update-p2p-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-update-p2p-pw-1234";
const PWD_ID = "pw-update-target";
const PWD_INITIAL = "initial-secret";
const PWD_UPDATED = "updated-secret";

test.describe("sync: owner-vault UPDATE via P2P", () => {
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

  test("setup: shared vault + row on both A and B (via copy)", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    // Seed the row BEFORE the copy so it's part of the imported .db on
    // both sides. The test proper is the UPDATE — post-pairing — so the
    // pre-copy CREATE is just the baseline both sides converge from.
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

    // Both sides must see the initial value before we touch anything —
    // otherwise the UPDATE assertion below is ambiguous (did the write
    // never land, or did the update never converge?).
    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "update-p2p/post-copy-pre-update",
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

  test("A updates a column; B converges to the new value via P2P", async () => {
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "UPDATE haex_passwords_item_details SET password = ?1 WHERE id = ?2",
      params: [PWD_UPDATED, PWD_ID],
    });

    // Nudge BOTH sides. Sibling specs (create-p2p, bidirectional) nudge
    // both — reduces autostart-interval flake when A hasn't yet pushed
    // and B hasn't yet pulled.
    await vaultA.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "update-p2p/A->B",
      () => pollUntil(
        async () => {
          const rows = await sqlQuery<{ id: string; password: string }>(
            vaultB,
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
          label: `B sees updated password for ${PWD_ID}`,
        },
      ),
    );

    // A must have the update locally regardless. Guards against the
    // "sql_execute_with_crdt silently no-op" failure mode.
    const aRows = await sqlQuery<{ id: string; password: string }>(
      vaultA,
      "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_ID],
    );
    expect(aRows.length).toBe(1);
    expect(aRows[0]?.password).toBe(PWD_UPDATED);

    // Post-cycle sanity dump — cheap, and puts both HLCs in the artefact
    // stream so a divergence-shape failure is legible in the log.
    await dumpSyncState(vaultA, "update-p2p/post-converge");
    await dumpSyncState(vaultB, "update-p2p/post-converge");
  });
});
