import { expect, test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { wait } from "../helpers/ui/utils";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

/**
 * Shared-space apply-gate — negative security guard.
 *
 * The counterpart to the owner-sync CRUD suite. Vault PR #735 tightened
 * the shared-space apply-gate to enforce column-signatures on writes for
 * spaces with multiple identities. The fix's follow-up must NOT weaken
 * that gate again — an unsigned wire payload aimed at a real shared
 * space must still be rejected on the receiver even when the surrounding
 * owner-sync code is being softened to accept unsigned owner-private
 * writes.
 *
 * Ideal test shape: seed an unsigned haex_shared_space_deleted_rows
 * entry into A's outbox, force a sync cycle, verify B rejects the entry
 * (row does NOT appear in B's shared-space delete-log, and the business
 * row on B stays intact). Fabricating an unsigned wire payload from the
 * harness alone is not tractable — the CRDT-apply path signs at write
 * time via `execute_with_crdt`, so we'd need a Tauri test-hook that
 * bypasses the signer.
 *
 * The vault plans that hook as `test_seed_shared_space_delete_log_entry`
 * behind the `e2e-hooks` cargo feature in PR #739 (see haex-vault memory:
 * shared-space-delete-propagation-v2-shipped, and follow-up W2 in
 * chat-feature-and-p2p-gatekeeper). Until the hook lands and the
 * companion Docker image is built with `--features e2e-hooks`, this spec
 * cannot exercise the wire-forgery path — it self-skips.
 *
 * When the hook lands:
 *   1. Set `E2E_HAS_SEED_HOOK=1` in the companion CI env for the vault
 *      builds that include it.
 *   2. Flesh out the test body below (marked with TODO(pr#739)) to call
 *      the hook and assert rejection on B.
 *
 * This spec is also a **positive fix-regression guard**: even against a
 * "buggy" vault (i.e., one whose owner-sync path drops owner-private
 * writes), the shared-space rejection this spec asserts remains
 * unchanged — the buggy vault over-rejects, not under-rejects. So it
 * should pass on both the buggy and fixed vault image once the hook is
 * available. Failure means the fix to owner-sync accidentally reopened
 * the shared-space gate.
 */

const HAS_SEED_HOOK = process.env.E2E_HAS_SEED_HOOK === "1";

const VAULT_NAME = `shared-space-negative-${Date.now()}`;
const VAULT_PASSWORD = "shared-space-negative-pw-1234";

// Conditional describe. When the vault hook isn't available we use
// `test.describe.skip` — the ENTIRE describe (fixtures, beforeAll session
// setup, afterAll teardown) is skipped by Playwright. Putting the gate
// inside beforeAll would still spin up the WebDriver sessions on both
// vaults before deciding to skip; CodeRabbit flagged that as needless
// work when the suite will do nothing.
//
// TODO(pr#739): drop the conditional once test_seed_shared_space_delete_log_entry
// is available in the vault image (Cargo feature `e2e-hooks`) and CI
// sets E2E_HAS_SEED_HOOK=1 on that image.
const describeOrSkip = HAS_SEED_HOOK ? test.describe : test.describe.skip;

describeOrSkip("sync: shared-space apply-gate rejects unsigned changes", () => {
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
    await restoreOriginalVault(vaultA, VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultB, VAULT_NAME).catch(() => {});
  });

  test("A → B: unsigned shared-space delete-log entry is rejected by B", async () => {
    // TODO(pr#739): implement once the hook exists. Sketch:
    //
    //   1. Create a fresh multi-identity shared space that includes A and B
    //      (via createLocalSpaceViaUI + accept from B, or the sync-server
    //      helpers under tests/helpers/sync-server-helpers.ts).
    //   2. On A: seed an entry into A's outbound queue with the vault-side
    //      hook, bypassing the signer:
    //        await vaultA.invokeTauriCommand("test_seed_shared_space_delete_log_entry", {
    //          spaceId,
    //          tableName: "haex_passwords_item_details",
    //          rowPks: { id: victimRowId },
    //          signaturePresent: false,
    //        });
    //   3. Force sync cycles on both sides.
    //   4. Assert on B:
    //        - haex_shared_space_deleted_rows does NOT contain an entry for
    //          (spaceId, "haex_passwords_item_details", rowPks matching victimRowId)
    //        - The victim row on B is still present and unchanged
    //        - A rejection is visible in haex_logs_no_sync (optional signal,
    //          strengthens the assertion)
    //
    // The `expect` below is a placeholder that keeps this file compiling
    // when HAS_SEED_HOOK is true but the implementation hasn't been
    // filled in yet. CI must not silently pass a hook-enabled build on
    // a stub — hence the deliberate failure.
    expect(
      HAS_SEED_HOOK,
      "shared-space negative body not yet implemented; see TODO(pr#739)",
    ).toBe(false);

    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);
    await initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD);
  });
});
