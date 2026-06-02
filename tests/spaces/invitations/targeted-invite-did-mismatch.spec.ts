import * as crypto from "crypto";
import { publicKeyToDid } from "@haex-space/ucan";
import { test, expect, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../helpers/ui/utils";
import { initializeVaultViaUI } from "../../helpers/ui/ui-vault";
import { createLocalSpaceViaUI } from "./quic-helpers/ui-spaces";

/**
 * Regression: targeted invite must reject claims from a DID other than the
 * one the token was minted for, even when the claimant is a legitimate
 * vault with its own valid identity.
 *
 * Phase 2 wire-format note (haex-vault PR #386): the claimer DID is no
 * longer carried on the wire — the leader binds it cryptographically via
 * the server-initiated quic_did_auth handshake. The token's `target_did`
 * still lives in haex_invite_tokens and is the autoritative input to
 * `can_claim()`. Together these two pieces guarantee the property tested
 * here: Vault B cannot impersonate the targeted DID just by knowing the
 * token id.
 *
 * Plan reference: docs/plans/2026-06-01-quic-did-auth-primitiv.md §4.4 T6
 * (Targeted-Invite, Claimant lügt im Payload) and §4.3 (target_did ist
 * Server-side autoritativ, niemals aus dem Payload).
 */

const { subtle } = crypto.webcrypto as unknown as Crypto;

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

test.describe("invitations: targeted-invite DID mismatch is rejected", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let phantomDid: string;
  let spaceId: string;
  let inviteTokenId: string;

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
        try { await v.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* ignore */ }
      }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
    // Release the per-suite vault B mount and reset the UI so a later suite's
    // beforeAll starts with a clean AppState (matches peer-share-visibility-after-invite).
    try { await vaultB.invokeTauriCommand("close_database", {}); } catch { /* ignore */ }
    try { await vaultB.navigateTo("/"); } catch { /* ignore */ }
  });

  test("Vault A is open (set up by global-setup)", async () => {
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("Vault B has an open vault", async () => {
    await initializeVaultViaUI(vaultB, "TargetedMismatch Vault B", "test-password-b");
    expect(await vaultB.executeScript<string>("return location.href")).toContain("/vault/");
  });

  test("start P2P endpoint on Vault A", async () => {
    const status = await vaultA.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    if (status.running) {
      nodeIdA = status.nodeId;
      const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>(
        "peer_storage_start", {},
      ).catch(() => null);
      relayUrlA = info?.relayUrl ?? null;
    } else {
      const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
      nodeIdA = info.nodeId;
      relayUrlA = info.relayUrl;
    }
    expect(nodeIdA).toBeTruthy();
  });

  test("start P2P endpoint on Vault B", async () => {
    const status = await vaultB.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    if (status.running) {
      nodeIdB = status.nodeId;
    } else {
      const info = await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
      nodeIdB = info.nodeId;
    }
    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
  });

  test("load identities on both vaults", async () => {
    const rowsA = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultA, "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    identityA = { id: rowsA![0].id, did: rowsA![0].did };

    const rowsB = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vaultB, "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    identityB = { id: rowsB![0].id, did: rowsB![0].did };

    expect(identityA.did).toContain("did:key:");
    expect(identityB.did).toContain("did:key:");
    expect(identityA.did).not.toBe(identityB.did);
  });

  test("mint a phantom DID that is neither Vault A nor Vault B", async () => {
    // The targeted invite below is minted for this DID. Neither vault owns
    // the corresponding private key, so any claim attempt against the leader
    // must be cryptographically refused. We deliberately do NOT seed this
    // DID into Vault B's haex_identities — the claim path uses Vault B's
    // own identity, and the leader must reject because verified_did
    // (= Vault B's DID) ≠ token.target_did (= phantomDid).
    const keyPair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPublicKey = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
    phantomDid = publicKeyToDid(rawPublicKey);
    expect(phantomDid).toContain("did:key:");
    expect(phantomDid).not.toBe(identityA.did);
    expect(phantomDid).not.toBe(identityB.did);
  });

  test("create local space on Vault A and start the leader", async () => {
    // Create through the UI so the vault initializes the owner's admin UCAN —
    // a raw SQL `INSERT INTO haex_spaces` skips UCAN generation and causes
    // local_delivery_create_invite to fail with "No admin UCAN found for space".
    // Same pattern as peer-share-visibility-after-invite.spec.ts.
    spaceId = await createLocalSpaceViaUI(vaultA, `TargetedMismatch-${Date.now()}`);

    // Register Vault A's own device row in the space so leader election finds
    // the publisher device (same boilerplate the working invite specs use).
    const ownDeviceRowsA = await sqlQuery<{ id: string }>(
      vaultA,
      "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      [nodeIdA],
    );
    expect(ownDeviceRowsA.length).toBe(1);
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_space_devices
              (id, space_id, device_id, endpoint_id, name, platform, relay_url, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      params: [
        crypto.randomUUID(),
        spaceId,
        ownDeviceRowsA[0].id,
        nodeIdA,
        "VaultA",
        "desktop",
        relayUrlA,
        identityA.did,
      ],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    await vaultA.invokeTauriCommand("local_delivery_start", { spaceId });
    await wait(1000);
  });

  test("Vault A creates a targeted invite for the phantom DID", async () => {
    inviteTokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      {
        spaceId,
        targetDid: phantomDid,
        capability: "space/read",
        maxUses: 1,
        expiresInSeconds: 3600,
        includeHistory: false,
      },
    );
    expect(inviteTokenId).toBeTruthy();

    // Sanity check: the row should land in haex_invite_tokens with
    // target_did = phantomDid (the autoritative source).
    const tokens = await sqlQuery<{ id: string; target_did: string | null }>(
      vaultA,
      `SELECT id, target_did FROM haex_invite_tokens WHERE id = ?1`,
      [inviteTokenId],
    );
    expect(tokens.length).toBe(1);
    expect(tokens[0].target_did).toBe(phantomDid);
  });

  test("seed pending invite on Vault B (simulates relay delivery)", async () => {
    // The claim path needs an haex_identities row for the inviter DID so the
    // pre-flight inviter-resolution check passes. private_key=NULL signals
    // "this is the other party's DID, we only know the public half".
    // `name` is NOT NULL in the schema (src/database/schemas/identity.ts).
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_identities (id, did, name, source, private_key)
            VALUES (?1, ?2, ?3, 'contact', NULL)`,
      params: [crypto.randomUUID(), identityA.did, "Vault A"],
    });

    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_pending_invites
              (id, space_id, space_name, space_type, inviter_did, inviter_label,
               token_id, capabilities, status, space_endpoints)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      params: [
        crypto.randomUUID(),
        spaceId,
        `Targeted Mismatch Space`,
        "local",
        identityA.did,
        "Vault A",
        inviteTokenId,
        JSON.stringify(["space/read"]),
        "pending",
        JSON.stringify([nodeIdA]),
      ],
    });

    const invites = await sqlQuery<{ id: string }>(
      vaultB,
      `SELECT id FROM haex_pending_invites WHERE space_id = ?1 AND status = 'pending'`,
      [spaceId],
    );
    expect(invites.length).toBe(1);
  });

  test("Vault B claims with its own DID — leader rejects with 'This invite is not for your DID'", async () => {
    // Call local_delivery_claim_invite directly (NOT via spacesStore.acceptLocalInviteAsync
    // which would pick the first own identity anyway). The wire-format change in
    // Phase 2 means the claimer DID is no longer carried on the request payload —
    // the leader binds it via the quic_did_auth handshake from `identityDid`'s
    // signing key. So the property under test is: even though identityB.did is
    // a fully valid signing identity, the token's target_did (= phantomDid) is
    // the autoritative comparison point and the leader rejects.
    let error: unknown = null;
    try {
      await vaultB.invokeTauriCommand("local_delivery_claim_invite", {
        leaderEndpointId: nodeIdA,
        leaderRelayUrl: relayUrlA,
        spaceId,
        spaceName: "Targeted Mismatch Space",
        tokenId: inviteTokenId,
        identityDid: identityB.did,
        label: null,
        identityPublicKey: null,
      });
    } catch (e) {
      error = e;
    }

    expect(error, "claim must fail when verified_did != token.target_did").not.toBeNull();
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("This invite is not for your DID");
  });

  test("no UCAN was issued for Vault B on Vault A's side", async () => {
    // Belt-and-suspenders check on the anti-manipulation property (§4.3): a
    // failed claim must NOT have caused the leader to mint a UCAN for the
    // claimant's verified DID, otherwise the rejection was string-deep only.
    const rows = await sqlQuery<{ token: string }>(
      vaultA,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, identityB.did],
    );
    expect(rows.length).toBe(0);
  });

  test("token is not consumed — max_uses still 0", async () => {
    // The consume step runs only after a fully successful claim. A rejected
    // claim must leave current_uses untouched so a legitimate claim by the
    // intended DID later still works.
    const rows = await sqlQuery<{ current_uses: number; max_uses: number }>(
      vaultA,
      `SELECT current_uses, max_uses FROM haex_invite_tokens WHERE id = ?1`,
      [inviteTokenId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].current_uses).toBe(0);
    expect(rows[0].max_uses).toBe(1);
  });
});
