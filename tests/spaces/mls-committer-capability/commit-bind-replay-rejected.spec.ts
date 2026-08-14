/**
 * MLS Phase-3 committer-capability — commit-bind replay rejected (Spec 4)
 *
 * Zero coverage anywhere else in the suite: a commit-bind signature is
 * DID-key-based and carries no group/epoch binding of its own
 * (`commit_bind::bind_digest` only hashes the commit bytes), so a
 * signature captured from one commit is a syntactically valid signature —
 * just over the wrong bytes. B holds a genuinely resolvable `space/invite`
 * UCAN (minted directly against the space's real admin root, isolating
 * this from the "no capability"/"forged UCAN" specs), produces two Remove
 * commits in two independent spaces, and A is fed the second commit
 * paired with the signature from the first.
 *
 * See README.md for the attack model this directory shares.
 */
import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery } from "../../helpers/ui/utils";
import { initializeVaultViaUI, startP2PEndpoint } from "../../helpers/ui/ui-vault";
import {
  ensureSpaceMemberRow,
  findMlsMemberIndex,
  loadAdminIdentity,
  mintUcan,
  runSuffix,
  setupTwoPartySpace,
  testMlsProcessCommitReport,
  testMlsRemoveMemberUnchecked,
} from "../../helpers/mls-attack-helpers";

const RUN_SUFFIX = runSuffix();
const SPACE_SRC_NAME = `MLS BindReplay Src ${RUN_SUFFIX}`;
const SPACE_DST_NAME = `MLS BindReplay Dst ${RUN_SUFFIX}`;
const CONTACT_LABEL = "MLS BindReplay Vault B Contact";

test.describe("mls committer-capability: commit-bind replay is rejected", () => {
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { did: string };
  let identityB: { did: string };
  let spaceSrc: string;
  let spaceDst: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    await initializeVaultViaUI(vaultA, "MLS BindReplay Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "MLS BindReplay Test B", "test-password-b");
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

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      for (const id of [spaceSrc, spaceDst]) {
        if (!id) continue;
        await v.invokeTauriCommand("local_delivery_stop", { spaceId: id }).catch(() => { /* ignore */ });
      }
      await v.invokeTauriCommand("peer_storage_stop", {}).catch(() => { /* ignore */ });
    }
  });

  test("create two independent spaces and establish B's MLS group in both", async () => {
    spaceSrc = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did, identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL, spaceName: SPACE_SRC_NAME,
    });
    await ensureSpaceMemberRow(vaultA, spaceSrc, identityA.did);

    spaceDst = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did, identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL, spaceName: SPACE_DST_NAME,
    });
    await ensureSpaceMemberRow(vaultA, spaceDst, identityA.did);

    expect(spaceSrc).not.toBe(spaceDst);
  });

  test("a bind signature captured on one commit is rejected when replayed onto another", async () => {
    // B genuinely holds `space/invite` for spaceDst — isolates this spec
    // from the committer-capability gate entirely, so only the bind check
    // can fire.
    const admin = await loadAdminIdentity(vaultA, spaceDst);
    const bInviteUcan = await mintUcan({
      issuerDid: admin.did,
      issuerPrivateKeyBase64: admin.privateKeyBase64,
      audienceDid: identityB.did,
      spaceId: spaceDst,
      capability: "space/invite",
      proofs: [admin.rootToken],
    });

    const aLeafOnBSrc = await findMlsMemberIndex(vaultB, spaceSrc, identityA.did);
    expect(aLeafOnBSrc).not.toBeNull();
    const attack1 = await testMlsRemoveMemberUnchecked(vaultB, spaceSrc, aLeafOnBSrc!);

    const aLeafOnBDst = await findMlsMemberIndex(vaultB, spaceDst, identityA.did);
    expect(aLeafOnBDst).not.toBeNull();
    const attack2 = await testMlsRemoveMemberUnchecked(vaultB, spaceDst, aLeafOnBDst!);

    // commit2 (spaceDst) paired with sig1 (captured on spaceSrc's commit1).
    const report = await testMlsProcessCommitReport(
      vaultA,
      spaceDst,
      attack2.commitB64,
      bInviteUcan,
      attack1.commitBindSigB64,
    );

    expect(report.outcome.kind).toBe("rejectedCommitBind");
    expect(report.epochAfter).toBe(report.epochBefore);
  });
});
