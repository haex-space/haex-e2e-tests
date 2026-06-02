import * as crypto from "crypto";
import { publicKeyToDid } from "@haex-space/ucan";
import { test, expect, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../helpers/ui/utils";
import { initializeVaultViaUI } from "../../helpers/ui/ui-vault";
import { createLocalSpaceViaUI } from "./quic-helpers/ui-spaces";

/**
 * Regression: a public invite (target_did = NULL) still cannot be claimed
 * with a DID whose private key the claimant does not own.
 *
 * Phase 2 of the haex-vault quic_did_auth refactor (PR #386) makes the
 * leader bind the claimer DID via a server-initiated handshake — the
 * client must sign a nonce with the private key for the DID it is
 * claiming. So the property under test is: Vault B cannot impersonate
 * an arbitrary foreign DID just because the invite is public.
 *
 * The failure surface today: `local_delivery_claim_invite` rejects at the
 * `load_signing_identity_for_did` step before the QUIC connection is even
 * opened. That is the strictly earlier-than-token-check rejection that
 * the plan calls for (§4.4 below), and it carries the same security
 * guarantee — the claim never reaches a state where the leader could
 * issue a UCAN for the foreign DID. If we ever loosen that pre-check, the
 * regression net moves to the handshake itself; either way the public
 * invite must not become a free pass for impersonation.
 *
 * Plan reference: docs/plans/2026-06-01-quic-did-auth-primitiv.md §4.2
 * (Bedrohungsmodell 2 — Public-Invite mit fremder DID claimen) and §4.4
 * T9 baseline (legitimate own-DID claim of a public invite works — this
 * spec only covers the negative half).
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

test.describe("invitations: public invite cannot be claimed with a foreign DID", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let foreignDid: string;
  let spaceId: string;
  let inviteTokenId: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    // Vault A is shared across every suite in this shard and never gets
    // close_database — its Pinia `spacesStore.spaces` and the haex_spaces
    // table both have to be left clean. Cleanup order:
    //   1. local_delivery_stop — remove the leader from the multi-leader map.
    //   2. DELETE FROM haex_spaces (FK cascade handles space_devices,
    //      invite_tokens, pending_invites, ucan_tokens, mls_sync_keys, etc.).
    //   3. spacesStore.loadSpacesFromDbAsync — refresh Pinia. Without this,
    //      the next spec's startP2PEndpoint(vaultA) triggers the frontend's
    //      startLocalSpaceLeadersAsync, which iterates spaces.value (the
    //      Pinia ref, NOT the DB) and revives a zombie leader for the now-
    //      deleted space. Confirmed via cross-vault-file-sharing's "After UI
    //      start: active_spaces=[<my-deleted-space-ids>]" diagnostic.
    if (spaceId) {
      try { await vaultA.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* ignore */ }
      try {
        await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
          sql: `DELETE FROM haex_spaces WHERE id = ?1`,
          params: [spaceId],
        });
      } catch { /* best effort */ }
    }
    if (inviteTokenId) {
      try {
        await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
          sql: `DELETE FROM haex_invite_tokens WHERE id = ?1`,
          params: [inviteTokenId],
        });
      } catch { /* best effort */ }
    }
    try {
      await vaultA.executeScript(`
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const spacesStore = pinia?._s?.get('spacesStore');
        if (spacesStore?.loadSpacesFromDbAsync) {
          await spacesStore.loadSpacesFromDbAsync();
        }
      `);
    } catch { /* best effort */ }
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
    // Deliberately NOT calling close_database/navigateTo on Vault B here.
    // That combination resets the WebView URL to "/", which then causes the
    // next suite's initializeVaultViaUI to skip the early-return path and
    // run a full vault create. The fresh vault triggers `vault.vue`'s
    // onMounted auto-start of peer_storage as a fire-and-forget — a subtly
    // different code path than `startP2PEndpoint`'s UI-driven flow that
    // breaks cross-vault-file-sharing.spec.ts:523's PushInvite delivery.
    // Pre-#41 quic-phases also only stopped peer_storage in afterAll; we
    // match its surface area to stay on the well-tested path.
  });

  test("Vault A is open (set up by global-setup)", async () => {
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("Vault B has an open vault", async () => {
    await initializeVaultViaUI(vaultB, "PublicForeign Vault B", "test-password-b");
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

    expect(identityA.did).not.toBe(identityB.did);
  });

  test("seed a foreign DID on Vault B with private_key = NULL", async () => {
    // Generate an ed25519 keypair off-vault and ONLY register the public DID
    // on Vault B. private_key=NULL means Vault B knows the DID exists but
    // holds no signing material for it — exactly the shape Vault B would
    // have for a contact's identity. Without the private key, Vault B
    // cannot prove ownership of this DID in the quic_did_auth handshake.
    const keyPair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPublicKey = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
    foreignDid = publicKeyToDid(rawPublicKey);
    expect(foreignDid).toContain("did:key:");
    expect(foreignDid).not.toBe(identityB.did);

    // `name` is NOT NULL in the schema (src/database/schemas/identity.ts).
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_identities (id, did, name, source, private_key)
            VALUES (?1, ?2, ?3, 'contact', NULL)`,
      params: [crypto.randomUUID(), foreignDid, "Phantom Foreign DID"],
    });

    const row = await sqlQuery<{ did: string; private_key: string | null }>(
      vaultB,
      `SELECT did, private_key FROM haex_identities WHERE did = ?1 LIMIT 1`,
      [foreignDid],
    );
    expect(row.length).toBe(1);
    expect(row[0].private_key).toBeNull();
  });

  test("Vault A creates a public invite (target_did = NULL) and starts the leader", async () => {
    // Create through the UI so the vault initializes the owner's admin UCAN —
    // raw SQL INSERT skips UCAN generation and causes local_delivery_create_invite
    // to fail with "No admin UCAN found for space". Same pattern as the working
    // peer-share-visibility-after-invite spec.
    spaceId = await createLocalSpaceViaUI(vaultA, `PublicForeign-${Date.now()}`);

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

    inviteTokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      {
        spaceId,
        targetDid: null,
        capability: "space/read",
        maxUses: 5,
        expiresInSeconds: 3600,
        includeHistory: false,
      },
    );
    expect(inviteTokenId).toBeTruthy();

    const tokens = await sqlQuery<{ id: string; target_did: string | null }>(
      vaultA,
      `SELECT id, target_did FROM haex_invite_tokens WHERE id = ?1`,
      [inviteTokenId],
    );
    expect(tokens.length).toBe(1);
    // The autoritative target_did must be NULL for a public invite, otherwise
    // this test would coincidentally measure the targeted path.
    expect(tokens[0].target_did).toBeNull();
  });

  test("seed pending invite on Vault B (simulates relay delivery)", async () => {
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
        "Public Foreign Space",
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

  test("Vault B claims with the foreign DID — fails before any wire request", async () => {
    let error: unknown = null;
    try {
      await vaultB.invokeTauriCommand("local_delivery_claim_invite", {
        leaderEndpointId: nodeIdA,
        leaderRelayUrl: relayUrlA,
        spaceId,
        spaceName: "Public Foreign Space",
        tokenId: inviteTokenId,
        identityDid: foreignDid,
        label: null,
        identityPublicKey: null,
      });
    } catch (e) {
      error = e;
    }

    expect(error, "claim with a DID we hold no private_key for must fail").not.toBeNull();
    const message = error instanceof Error ? error.message : String(error);
    // load_signing_identity_for_did returns DeliveryError::AccessDenied which
    // formats as "Access denied: no haex_identities row with private_key for <did>".
    // Match on the stable substring; the rest of the message includes the DID.
    expect(message).toMatch(/no haex_identities row with private_key/i);
  });

  test("no UCAN was issued for the foreign DID on Vault A's side", async () => {
    const rows = await sqlQuery<{ token: string }>(
      vaultA,
      `SELECT token FROM haex_ucan_tokens WHERE space_id = ?1 AND audience_did = ?2`,
      [spaceId, foreignDid],
    );
    expect(rows.length).toBe(0);
  });

  test("token current_uses is still 0 after the failed foreign-DID claim", async () => {
    const rows = await sqlQuery<{ current_uses: number; max_uses: number }>(
      vaultA,
      `SELECT current_uses, max_uses FROM haex_invite_tokens WHERE id = ?1`,
      [inviteTokenId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].current_uses).toBe(0);
    expect(rows[0].max_uses).toBe(5);
  });
});
