/**
 * MLS Phase-3 committer-capability — no-proof Remove rejected (Spec 2)
 *
 * B (capability-less attacker) produces a Remove of A with NO local
 * capability gate and NO attached UCAN
 * (`test_mls_remove_member_unchecked`, out-of-band — sending is impossible
 * on the wire, see README.md). A's REAL receive path
 * (`test_mls_process_commit_report` → `MlsManager::decrypt`) must reject it
 * without advancing its epoch.
 *
 * See README.md for the attack model this directory shares.
 */
import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery } from "../../helpers/ui/utils";
import { initializeVaultViaUI, startP2PEndpoint } from "../../helpers/ui/ui-vault";
import {
  ensureSpaceMemberRow,
  findMlsMemberIndex,
  runSuffix,
  setupTwoPartySpace,
  testMlsProcessCommitReport,
  testMlsRemoveMemberUnchecked,
} from "../../helpers/mls-attack-helpers";

const RUN_SUFFIX = runSuffix();
const SPACE_NAME = `MLS No-Capability Space ${RUN_SUFFIX}`;
const CONTACT_LABEL = "MLS NoCap Vault B Contact";

test.describe("mls committer-capability: no-proof Remove is rejected", () => {
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { did: string };
  let identityB: { did: string };
  let spaceId: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      if (spaceId) {
        await v.invokeTauriCommand("local_delivery_stop", { spaceId }).catch(() => { /* ignore */ });
      }
      await v.invokeTauriCommand("peer_storage_stop", {}).catch(() => { /* ignore */ });
    }
  });

  test("open both vaults, start P2P, load identities", async () => {
    await initializeVaultViaUI(vaultA, "MLS NoCap Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "MLS NoCap Test B", "test-password-b");
    nodeIdA = await startP2PEndpoint(vaultA);
    nodeIdB = await startP2PEndpoint(vaultB);

    const rowsA = await pollUntil(
      async () => {
        const r = await sqlQuery<{ did: string }>(vaultA, "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1");
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { did: rowsA![0].did };

    const rowsB = await pollUntil(
      async () => {
        const r = await sqlQuery<{ did: string }>(vaultB, "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1");
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { did: rowsB![0].did };
  });

  test("create space, invite B (read-only), accept, establish MLS group", async () => {
    spaceId = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did,
      identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL,
      spaceName: SPACE_NAME,
    });
    expect(spaceId).toBeTruthy();

    // C1 precondition: A (the removal target below) must be a known active
    // member on A's OWN db — otherwise the target-already-gone exemption
    // fires and this spec passes for the wrong reason.
    await ensureSpaceMemberRow(vaultA, spaceId, identityA.did);
  });

  test("B produces an unchecked Remove of A; A's receive path rejects it", async () => {
    const aLeafOnB = await findMlsMemberIndex(vaultB, spaceId, identityA.did);
    expect(aLeafOnB).not.toBeNull();

    const attack = await testMlsRemoveMemberUnchecked(vaultB, spaceId, aLeafOnB!);
    expect(attack.commitB64).toBeTruthy();

    const report = await testMlsProcessCommitReport(vaultA, spaceId, attack.commitB64, null, null);

    expect(report.outcome.kind).toBe("rejectedCommitterCapability");
    if (report.outcome.kind === "rejectedCommitterCapability") {
      expect(report.outcome.reason).toContain("none presented");
    }
    expect(report.epochAfter).toBe(report.epochBefore);

    // A's own group is untouched — its epoch didn't move, so it must still
    // see itself as a member.
    const aLeafOnA = await findMlsMemberIndex(vaultA, spaceId, identityA.did);
    expect(aLeafOnA).not.toBeNull();
  });
});
