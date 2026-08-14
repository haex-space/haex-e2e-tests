/**
 * MLS Phase-3 committer-capability — local raw remove without capability
 * rejected (Spec 5)
 *
 * No attack hooks at all: B (holding only `space/read`) invokes the real
 * `mls_remove_member` Tauri command directly against its own local group.
 * Tests `authorization::authorize_local_removal` on the honest SEND path —
 * the gate this whole design's e2e coverage started from (a CodeRabbit
 * finding on PR #781): a locally-originated Remove never passes through
 * `decrypt`/`inspect` at all, so nothing else gates it.
 *
 * See README.md for the attack model this directory shares.
 */
import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery } from "../../helpers/ui/utils";
import { initializeVaultViaUI, startP2PEndpoint } from "../../helpers/ui/ui-vault";
import { ensureSpaceMemberRow, findMlsMemberIndex, runSuffix, setupTwoPartySpace } from "../../helpers/mls-attack-helpers";

const RUN_SUFFIX = runSuffix();
const SPACE_NAME = `MLS Local-Gate Space ${RUN_SUFFIX}`;
const CONTACT_LABEL = "MLS LocalGate Vault B Contact";

test.describe("mls committer-capability: local raw remove without capability is rejected", () => {
  test.skip(!!process.env.HAEX_VAULT_BINARY_PATH, "multi-vault instance B is not available on native Windows/macOS E2E runners yet");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

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

  test("open both vaults, start P2P, load identities, establish read-only space", async () => {
    await initializeVaultViaUI(vaultA, "MLS LocalGate Test A", "test-password-a");
    await initializeVaultViaUI(vaultB, "MLS LocalGate Test B", "test-password-b");
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

    spaceId = await setupTwoPartySpace({
      vaultA, vaultB, nodeIdA, nodeIdB,
      identityADid: identityA.did,
      identityBDid: identityB.did,
      contactLabel: CONTACT_LABEL,
      spaceName: SPACE_NAME,
    });

    // `authorize_local_removal` only demands a capability proof if the
    // removal target is a recognized member in the committer's OWN
    // `haex_space_members` table (`is_space_member` — otherwise it treats
    // the target as "already left" and skips the gate). The invite/accept
    // flow doesn't itself populate B's row for A, so without this B's
    // `mls_remove_member` call below would silently succeed instead of
    // rejecting — same precondition forged-ucan-rejected.spec.ts needs.
    await ensureSpaceMemberRow(vaultB, spaceId, identityA.did);

    // B holds only space/read from the invite dialog (no Invite toggle
    // exists in the UI at all).
    const ucans = await sqlQuery<{ capability: string }>(
      vaultB,
      `SELECT capability FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(ucans.some((u) => u.capability === "space/read")).toBe(true);
    expect(ucans.some((u) => u.capability === "space/invite" || u.capability === "space/admin")).toBe(false);
  });

  test("B's direct mls_remove_member call is rejected by the local capability gate", async () => {
    // Throws if A is missing — precondition assert.
    const aLeafOnB = await findMlsMemberIndex(vaultB, spaceId, identityA.did);

    // `mls_export_epoch_key` is the only production-exposed epoch reader —
    // idempotent (in-place UPDATE on the sync-keys table) so calling it
    // before/after doesn't perturb what we're measuring.
    const { epoch: epochBefore } = await vaultB.invokeTauriCommand<{ epoch: number | bigint }>(
      "mls_export_epoch_key", { spaceId },
    );

    await expect(
      vaultB.invokeTauriCommand("mls_remove_member", { spaceId, memberIndex: aLeafOnB }),
    ).rejects.toThrow(/Invite-or-higher/);

    // No commit was produced — B's own group still has A as a member, and
    // its epoch didn't advance (belt-and-braces on top of the membership
    // check: `authorize_local_removal` rejects BEFORE anything is staged).
    await findMlsMemberIndex(vaultB, spaceId, identityA.did);
    const { epoch: epochAfter } = await vaultB.invokeTauriCommand<{ epoch: number | bigint }>(
      "mls_export_epoch_key", { spaceId },
    );
    expect(String(epochAfter)).toBe(String(epochBefore));

    // A's member set is untouched — nothing was ever sent.
    await findMlsMemberIndex(vaultA, spaceId, identityA.did);
  });
});
