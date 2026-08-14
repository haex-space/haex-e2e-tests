/**
 * MLS Phase-3 committer-capability — happy path (Spec 1)
 *
 * The one spec in this matrix that runs over the real P2P wire: Vault A
 * (admin, leader) removes Vault B via the production `mls_remove_member` +
 * `local_delivery_broadcast_commit` commands (no attack hooks). It is the
 * only proof anywhere that `committerUcan` + `committerCommitBindSig`
 * actually survive `MlsCommitBundle` → `local_delivery_broadcast_commit` →
 * `buffer::store_message` → the wire → `haex_local_delivery_messages_no_sync`
 * on the receiver — every other spec in this directory injects out-of-band
 * and never touches that path.
 *
 * See README.md for the attack model this directory shares.
 */
import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery } from "../../helpers/ui/utils";
import { initializeVaultViaUI, startP2PEndpoint } from "../../helpers/ui/ui-vault";
import { findMlsMemberIndex, runSuffix, setupTwoPartySpace } from "../../helpers/mls-attack-helpers";

const RUN_SUFFIX = runSuffix();
const SPACE_NAME = `MLS Happy Path Space ${RUN_SUFFIX}`;
const CONTACT_LABEL = "MLS HappyPath Vault B Contact";

interface MlsCommitBundleJs {
  commit: number[];
  welcome: number[] | null;
  groupInfo: number[];
  committerUcan: string | null;
  committerCommitBindSig: number[] | null;
}

test.describe("mls committer-capability: happy path over real P2P", () => {
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

  test("open both vaults and start P2P endpoints", async () => {
    await initializeVaultViaUI(vaultA, "MLS HappyPath Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "MLS HappyPath Test B", "test-password-b");
    nodeIdA = await startP2PEndpoint(vaultA);
    nodeIdB = await startP2PEndpoint(vaultB);
    expect(nodeIdA).toBeTruthy();
    expect(nodeIdB).toBeTruthy();
  });

  test("load identities on both vaults", async () => {
    const rowsA = await pollUntil(
      async () => {
        const r = await sqlQuery<{ did: string }>(
          vaultA, "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { did: rowsA![0].did };

    const rowsB = await pollUntil(
      async () => {
        const r = await sqlQuery<{ did: string }>(
          vaultB, "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { did: rowsB![0].did };
  });

  test("create space, invite B, accept, and establish the MLS group", async () => {
    spaceId = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did,
      identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL,
      spaceName: SPACE_NAME,
    });
    expect(spaceId).toBeTruthy();

    const aLeaf = await findMlsMemberIndex(vaultA, spaceId, identityA.did);
    const bLeafOnA = await findMlsMemberIndex(vaultA, spaceId, identityB.did);
    expect(aLeaf).not.toBeNull();
    expect(bLeafOnA).not.toBeNull();
  });

  test("A removes B via the real production commit + wire delivery", async () => {
    const bLeaf = await findMlsMemberIndex(vaultA, spaceId, identityB.did);
    expect(bLeaf).not.toBeNull();

    const bundle = await vaultA.invokeTauriCommand<MlsCommitBundleJs>("mls_remove_member", {
      spaceId,
      memberIndex: bLeaf,
    });
    // A is the space's creator (self-signed admin root, held for itself) and
    // B is still an active member at commit time — `authorize_local_removal`
    // must have required (and `remove_member` attached) a real proof.
    expect(bundle.committerUcan).toBeTruthy();
    expect(bundle.committerCommitBindSig).not.toBeNull();

    await vaultA.invokeTauriCommand("local_delivery_broadcast_commit", {
      spaceId,
      commit: bundle.commit,
      committerUcan: bundle.committerUcan,
      committerCommitBindSig: bundle.committerCommitBindSig,
    });
  });

  test("the wire carried committerUcan + committerCommitBindSig to B, and B merged the commit", async () => {
    const row = await pollUntil(
      async () => {
        const rows = await sqlQuery<{
          committer_ucan: string | null;
          committer_commit_bind_sig: string | null;
        }>(
          vaultB,
          `SELECT committer_ucan, committer_commit_bind_sig
           FROM haex_local_delivery_messages_no_sync
           WHERE space_id = ?1 AND message_type = 'commit'
           ORDER BY id DESC LIMIT 1`,
          [spaceId],
        );
        return rows.length > 0 ? rows[0] : null;
      },
      { timeout: 60_000, interval: 2_000, label: "removal commit row on Vault B" },
    );
    expect(row!.committer_ucan).not.toBeNull();
    expect(row!.committer_commit_bind_sig).not.toBeNull();

    // B merged the commit (not just stored it) — it should recognize its own
    // removal in its OWN local MLS group view. Convergence, not just wire-
    // carry: proves the receive-gate accepted the proof, not that the row
    // merely landed unread.
    await pollUntil(
      async () => (await findMlsMemberIndex(vaultB, spaceId, identityB.did)) === null,
      { timeout: 30_000, interval: 2_000, label: "Vault B recognizes its own removal" },
    );
  });

  test("both peers converge: B is gone from A's group too", async () => {
    const bLeafOnA = await findMlsMemberIndex(vaultA, spaceId, identityB.did);
    expect(bLeafOnA).toBeNull();
  });
});
