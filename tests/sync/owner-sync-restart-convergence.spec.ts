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
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
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
    "close B FIRST, DELETE on A while B offline, reopen B, verify convergence",
    async () => {
      // ── 1. Tear B down BEFORE A mutates. ─────────────────────────────────
      // Sequencing is load-bearing: if B is online when A DELETEs, owner-sync
      // may converge the delete LIVE (over the existing P2P connection)
      // BEFORE we close B. Then the subsequent close+reopen becomes cosmetic
      // — the DB on disk already has the delete applied and any "restart"
      // path is untested. CodeRabbit flagged the original order as a false
      // regression guard. Close B first so any convergence must go through
      // a cold-boot apply cycle.
      await vaultB.invokeTauriCommand("close_database", {}).catch(() => {});
      await vaultB.navigateTo("/");
      await wait(2000);

      // ── 2. Prove B is actually offline before we touch A. ────────────────
      // sql_select_with_crdt requires an open database + live AppState. If
      // close_database really tore down state, this call throws (or returns
      // an error result). If it succeeds we have a real live DB on B and
      // the sequencing guarantee is void — surface that immediately rather
      // than silently retesting live convergence dressed up as cold-boot.
      let bIsOffline = false;
      try {
        await vaultB.invokeTauriCommand("sql_select_with_crdt", {
          sql: "SELECT id FROM haex_passwords_item_details LIMIT 1",
          params: [],
        });
      } catch {
        bIsOffline = true;
      }
      expect(
        bIsOffline,
        "B must be closed (sql_select_with_crdt must throw) before A DELETEs — otherwise this spec tests live convergence, not cold-boot recovery",
      ).toBe(true);

      // ── 3. DELETE on A with B provably down. ─────────────────────────────
      // Because B has no live DB / no active peer_storage, this DELETE
      // cannot arrive on B until B re-boots and pulls it via a fresh sync
      // cycle. That is the code path this spec is here to test.
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: "DELETE FROM haex_passwords_item_details WHERE id = ?1",
        params: [PWD_ID],
      });
      // Small window so any (hypothetical) live-sync path would have fired
      // before we bring B back up. Any "B raced the close" outcome here is
      // wrong and should fail below.
      await wait(1500);

      // ── 4. Bring B back — this re-fires PR #511 autostart from cold. ────
      await diagnosed(vaultB, "restart/reopen-B", () =>
        initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD),
      );

      // Give autostart a beat, then nudge the loop.
      await wait(3000);
      await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

      // ── 5. Assert convergence happens ON THE POST-BOOT PATH. ────────────
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
