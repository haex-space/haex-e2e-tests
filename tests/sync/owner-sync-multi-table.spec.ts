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
 * Owner-vault sync — cross-table CRUD in one flow.
 *
 * A regression on the apply-gate can be table-specific: a column-sig
 * migration might land the fix on `haex_passwords_item_details` but miss
 * `haex_identities` or the delete-log table. The delete-convergence spec
 * caught PR #735 for `haex_passwords_item_details` — this spec broadens
 * coverage across the tables owner-sync must carry:
 *
 *   • `haex_passwords_item_details`  — user data (INSERT + DELETE on A)
 *   • `haex_deleted_rows`            — meta CRDT populated by the DELETE
 *                                      above; the delete-log row itself is
 *                                      the thing that must propagate for B
 *                                      to observe the delete.
 *   • `haex_identities`              — owner identity row; benign UPDATE
 *                                      to the `name` column (INSERTing a
 *                                      new identity has auth side-effects
 *                                      that would derail test isolation).
 *   • `haex_bookmark_collections`    — extension data table, owner-scoped
 *                                      (haex-pass-browser bookmarks). No
 *                                      FKs from other rows here so a bare
 *                                      INSERT is self-contained.
 *
 * NOT covered here: any shared-space extension table (those go through the
 * signed apply-gate, not the owner-sync path).
 */

const VAULT_NAME = `owner-sync-multi-table-${Date.now()}`;
const VAULT_PASSWORD = "owner-sync-multi-table-pw-1234";

// Pre-existing rows (seeded before the copy → present on both sides).
const PWD_PREEXISTING_ID = "pw-pre-copy";
const PWD_PREEXISTING_SECRET = "pre-copy-secret";

// Post-pairing writes on A.
const PWD_NEW_ID = "pw-post-pairing";
const PWD_NEW_SECRET = "post-pairing-secret";
const BOOKMARK_COLLECTION_ID = "bc-multi-table-target";
const BOOKMARK_COLLECTION_NAME = "multi-table-created-on-A";
const IDENTITY_UPDATED_NAME = `E2E owner renamed ${Date.now()}`;

test.describe("sync: owner-vault multi-table CRUD via P2P", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let ownerDid = "";

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

  test("setup: shared vault + pre-existing password row (via copy)", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    // Seed the row we'll DELETE later. Present in the copied .db so both
    // sides start from the same baseline — the DELETE assertion below is
    // then unambiguously about delete-log propagation, not INSERT
    // convergence.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_PREEXISTING_ID, PWD_PREEXISTING_SECRET],
    });

    // Capture the owner's DID from A. This is the identity row we'll UPDATE
    // — pulled dynamically because welcome-onboarding derives it per run.
    const identityRows = await sqlQuery<{ did: string }>(
      vaultA,
      "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
    );
    expect(identityRows.length).toBe(1);
    ownerDid = identityRows[0]!.did;

    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    await diagnosed(vaultA, "reopen-A-after-copy", () =>
      initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD),
    );
    await diagnosed(vaultB, "open-B-imported", () =>
      initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD),
    );

    // Baseline: B knows the pre-existing password and shares the owner
    // identity row. Fail here surfaces "copy did not populate B correctly"
    // separately from any post-pairing convergence failure.
    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "multi-table/post-copy",
      () => pollUntil(
        async () => {
          const pw = await sqlQuery<{ id: string }>(
            vaultB,
            "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
            [PWD_PREEXISTING_ID],
          );
          const ident = await sqlQuery<{ did: string }>(
            vaultB,
            "SELECT did FROM haex_identities WHERE did = ?1",
            [ownerDid],
          );
          return pw.length === 1 && ident.length === 1 ? true : null;
        },
        {
          timeout: 60_000,
          interval: 1_500,
          label: "B has pre-copy password + owner identity",
        },
      ),
    );
  });

  test("A: mutate 4 tables in one flow (INSERT / UPDATE / INSERT / DELETE)", async () => {
    // (1) haex_passwords_item_details — post-pairing INSERT
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
      params: [PWD_NEW_ID, PWD_NEW_SECRET],
    });

    // (2) haex_identities — UPDATE the owner's name column.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "UPDATE haex_identities SET name = ?1 WHERE did = ?2",
      params: [IDENTITY_UPDATED_NAME, ownerDid],
    });

    // (3) haex_bookmark_collections — extension data table (haex-pass-browser).
    // Minimal INSERT: id + name. No FKs, no triggers touching other tables.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "INSERT INTO haex_bookmark_collections (id, name) VALUES (?1, ?2)",
      params: [BOOKMARK_COLLECTION_ID, BOOKMARK_COLLECTION_NAME],
    });

    // (4) DELETE the pre-existing password — populates haex_deleted_rows
    // via the BEFORE-DELETE trigger. We verify the delete-log row itself
    // reached B (rather than only "row is gone on B", which is a
    // weaker signal — the row could go missing for many reasons).
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "DELETE FROM haex_passwords_item_details WHERE id = ?1",
      params: [PWD_PREEXISTING_ID],
    });

    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
  });

  test("B: all four changes converge via P2P sync", async () => {
    await diagnosedSync(
      { a: vaultA, b: vaultB },
      "multi-table/converge",
      () => pollUntil(
        async () => {
          const [insertedPwd, renamedIdent, newCollection, deleteLog] =
            await Promise.all([
              sqlQuery<{ id: string; password: string }>(
                vaultB,
                "SELECT id, password FROM haex_passwords_item_details WHERE id = ?1",
                [PWD_NEW_ID],
              ),
              sqlQuery<{ did: string; name: string }>(
                vaultB,
                "SELECT did, name FROM haex_identities WHERE did = ?1",
                [ownerDid],
              ),
              sqlQuery<{ id: string; name: string }>(
                vaultB,
                "SELECT id, name FROM haex_bookmark_collections WHERE id = ?1",
                [BOOKMARK_COLLECTION_ID],
              ),
              // haex_deleted_rows uses (table_name, row_pks) shape. The
              // simplest signal: an entry whose serialized primary keys
              // include the deleted password id. Matching on `%<pk>%` is
              // loose but tolerant to encoding-format tweaks in the
              // delete-log schema.
              sqlQuery<{ row_pks: string }>(
                vaultB,
                "SELECT row_pks FROM haex_deleted_rows WHERE table_name = ?1 AND row_pks LIKE ?2",
                ["haex_passwords_item_details", `%${PWD_PREEXISTING_ID}%`],
              ),
            ]);

          const insertedOk =
            insertedPwd.length === 1 &&
            insertedPwd[0]?.password === PWD_NEW_SECRET;
          const renamedOk =
            renamedIdent.length === 1 &&
            renamedIdent[0]?.name === IDENTITY_UPDATED_NAME;
          const collectionOk =
            newCollection.length === 1 &&
            newCollection[0]?.name === BOOKMARK_COLLECTION_NAME;
          const deleteLogOk = deleteLog.length >= 1;

          return insertedOk && renamedOk && collectionOk && deleteLogOk
            ? {
                insertedPwd,
                renamedIdent,
                newCollection,
                deleteLog,
              }
            : null;
        },
        {
          timeout: 90_000,
          interval: 2_000,
          label:
            "B converges 4 tables: passwords INSERT + identities UPDATE + " +
            "bookmark_collections INSERT + delete-log row",
        },
      ),
    );

    // Belt-and-braces: verify the DELETE actually took effect on B (the
    // delete-log row alone is convergence for the meta table; the
    // observable business-level effect is the row being gone).
    const deletedOnB = await sqlQuery<{ id: string }>(
      vaultB,
      "SELECT id FROM haex_passwords_item_details WHERE id = ?1",
      [PWD_PREEXISTING_ID],
    );
    expect(deletedOnB.length).toBe(0);

    await dumpSyncState(vaultA, "multi-table/converged");
    await dumpSyncState(vaultB, "multi-table/converged");
  });
});
