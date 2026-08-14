/**
 * MLS Phase-3 committer-capability — forged UCAN rejected (Spec 3)
 *
 * `resolve_presented_committer_capability` maps EVERY verification failure
 * to `None` (haex-vault `space_delivery::local::ucan.rs`), so the first
 * three sub-cases below produce the byte-identical "none presented" gate
 * error as no UCAN at all — the only place they're distinguishable at all
 * is `resolvedAudienceDid`/`resolvedLevel` on the report, which is exactly
 * what each assertion checks instead of the rejection message. "Wrong
 * audience" is the one sub-case whose UCAN chain-walks fine (rooted at the
 * real admin) and resolves a real `resolvedAudienceDid` — but is rejected
 * even earlier than Phase 3: `verify_commit_bind_bytes` (`mls/commit_bind.rs`)
 * derives its verification key from the UCAN's *audience* DID, and the
 * commit here was actually bind-signed by B's real key, not the wrong
 * audience's — so the signature itself fails to verify. The commit-bind
 * check is transitively audience-bound even though it has no group/epoch
 * binding of its own.
 *
 * Every sub-case pairs its forged UCAN with the REAL bind signature from
 * the SAME commit (`test_mls_remove_member_unchecked` always signs one),
 * so the commit-bind check passes for 6a-6c and does not mask the check
 * under test there. 6d is the one case where that same real bind sig is
 * exactly what trips the EARLIER commit-bind rejection (see above).
 * Each sub-case gets its own space — a shared one would let one sub-case's
 * local divergence on B poison the next (see README.md).
 *
 * See README.md for the attack model this directory shares.
 */
import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery } from "../../helpers/ui/utils";
import { initializeVaultViaUI, startP2PEndpoint } from "../../helpers/ui/ui-vault";
import {
  ensureSpaceMemberRow,
  findMlsMemberIndex,
  generateThrowawayIdentity,
  loadAdminIdentity,
  mintFakeSelfSignedRoot,
  mintUcan,
  runSuffix,
  setupTwoPartySpace,
  testMlsProcessCommitReport,
  testMlsRemoveMemberUnchecked,
  type TestCommitGateReport,
} from "../../helpers/mls-attack-helpers";

const RUN_SUFFIX = runSuffix();
const CONTACT_LABEL = "MLS ForgedUcan Vault B Contact";

test.describe("mls committer-capability: forged UCAN rejected", () => {
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let identityA: { did: string };
  let identityB: { did: string };
  const createdSpaceIds: string[] = [];

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    await initializeVaultViaUI(vaultA, "MLS ForgedUcan Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "MLS ForgedUcan Test B", "test-password-b");
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
      // Each sub-case's space stays "active" (still syncing) until stopped
      // explicitly — `peer_storage_stop` below pauses the endpoint but does
      // not deregister spaces, so without this every later spec file in the
      // same worker inherits all 4 of this file's spaces as extra load.
      for (const spaceId of createdSpaceIds) {
        await v.invokeTauriCommand("local_delivery_stop", { spaceId }).catch(() => { /* ignore */ });
      }
      await v.invokeTauriCommand("peer_storage_stop", {}).catch(() => { /* ignore */ });
    }
  });

  /** Create a dedicated space for one sub-case and establish B's MLS group in it. */
  async function setupSubcaseSpace(spaceName: string): Promise<string> {
    const spaceId = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did,
      identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL,
      spaceName,
    });
    createdSpaceIds.push(spaceId);
    await ensureSpaceMemberRow(vaultA, spaceId, identityA.did);
    return spaceId;
  }

  /** B produces an unchecked Remove of A, then A's receive path is fed the commit with `forgedUcan` + the commit's own real bind sig. */
  async function driveAttack(spaceId: string, forgedUcan: string): Promise<TestCommitGateReport> {
    const aLeafOnB = await findMlsMemberIndex(vaultB, spaceId, identityA.did);
    expect(aLeafOnB).not.toBeNull();
    const attack = await testMlsRemoveMemberUnchecked(vaultB, spaceId, aLeafOnB!);
    return testMlsProcessCommitReport(vaultA, spaceId, attack.commitB64, forgedUcan, attack.commitBindSigB64);
  }

  test("6a: wrong signer — self-signed root by an identity unrelated to this space", async () => {
    const spaceId = await setupSubcaseSpace(`MLS Forged-UCAN WrongSigner ${RUN_SUFFIX}`);

    const fake = await generateThrowawayIdentity();
    const fakeRoot = await mintFakeSelfSignedRoot(fake, spaceId);
    const forged = await mintUcan({
      issuerDid: fake.did,
      issuerPrivateKeyBase64: fake.privateKeyBase64,
      audienceDid: identityB.did,
      spaceId,
      capability: "space/invite",
      proofs: [fakeRoot],
    });

    const report = await driveAttack(spaceId, forged);

    expect(report.resolvedAudienceDid).toBeNull();
    expect(report.outcome.kind).toBe("rejectedCommitterCapability");
    expect(report.epochAfter).toBe(report.epochBefore);
  });

  test("6b: broken chain — leaf issuer does not match the fake root's audience", async () => {
    const spaceId = await setupSubcaseSpace(`MLS Forged-UCAN BrokenChain ${RUN_SUFFIX}`);

    const fakeRootIdentity = await generateThrowawayIdentity();
    const fakeRootToken = await mintFakeSelfSignedRoot(fakeRootIdentity, spaceId);
    const impostor = await generateThrowawayIdentity();
    const forged = await mintUcan({
      issuerDid: impostor.did,
      issuerPrivateKeyBase64: impostor.privateKeyBase64,
      audienceDid: identityB.did,
      spaceId,
      capability: "space/invite",
      proofs: [fakeRootToken],
    });

    const report = await driveAttack(spaceId, forged);

    expect(report.resolvedAudienceDid).toBeNull();
    expect(report.outcome.kind).toBe("rejectedCommitterCapability");
    expect(report.epochAfter).toBe(report.epochBefore);
  });

  test("6c: expired — valid fake-rooted chain, expiration in the past", async () => {
    const spaceId = await setupSubcaseSpace(`MLS Forged-UCAN Expired ${RUN_SUFFIX}`);

    const fake = await generateThrowawayIdentity();
    const fakeRoot = await mintFakeSelfSignedRoot(fake, spaceId);
    const forged = await mintUcan({
      issuerDid: fake.did,
      issuerPrivateKeyBase64: fake.privateKeyBase64,
      audienceDid: identityB.did,
      spaceId,
      capability: "space/invite",
      proofs: [fakeRoot],
      expiresInSeconds: -3600,
    });

    const report = await driveAttack(spaceId, forged);

    expect(report.resolvedAudienceDid).toBeNull();
    expect(report.outcome.kind).toBe("rejectedCommitterCapability");
    expect(report.epochAfter).toBe(report.epochBefore);
  });

  test("6d: wrong audience — real chain rooted at the space's actual admin, audience is not B", async () => {
    const spaceId = await setupSubcaseSpace(`MLS Forged-UCAN WrongAudience ${RUN_SUFFIX}`);

    const admin = await loadAdminIdentity(vaultA, spaceId);
    const wrongAudience = await generateThrowawayIdentity();
    const forged = await mintUcan({
      issuerDid: admin.did,
      issuerPrivateKeyBase64: admin.privateKeyBase64,
      audienceDid: wrongAudience.did,
      spaceId,
      capability: "space/invite",
      proofs: [admin.rootToken],
    });

    const report = await driveAttack(spaceId, forged);

    // The one sub-case whose UCAN verifies successfully — chain-walks fine,
    // rooted at the real admin — so `resolvedAudienceDid` resolves for real.
    // But the commit's bind signature was produced by B's real key, not the
    // wrong audience's, and `verify_commit_bind_bytes` verifies against a
    // key derived from the UCAN's audience DID — so the signature check
    // itself fails before Phase 3's committer-capability logic ever runs.
    expect(report.resolvedAudienceDid).toBe(wrongAudience.did);
    expect(report.outcome.kind).toBe("rejectedCommitBind");
    if (report.outcome.kind === "rejectedCommitBind") {
      expect(report.outcome.reason).toContain("commit-bind signature invalid");
    }
    expect(report.epochAfter).toBe(report.epochBefore);
  });
});
