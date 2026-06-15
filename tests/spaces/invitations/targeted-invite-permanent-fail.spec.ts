import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../helpers/ui/utils";
import { createLocalSpaceViaUI } from "./quic-helpers/ui-spaces";

/**
 * Regression: a permanent delivery failure (invalid target endpoint id,
 * auth/protocol reject) must mark the outbox row FAILED on the *first*
 * attempt rather than burning six transient retries before surfacing to
 * the user.
 *
 * Plan reference: docs/plans/2026-06-15-invite-outbox-resilience.md
 *   - Schicht 1 (transient vs. permanent classification): permanent
 *     errors short-circuit retry, transient errors keep the row PENDING
 *     until `expiresAt`. The counter-test to
 *     `targeted-invite-recipient-comes-online-late.spec.ts`.
 *
 * Mechanism: we insert an outbox row whose `target_endpoint_id` is a
 * deliberately malformed iroh EndpointId. `local_delivery_push_invite`
 * fails at `build_endpoint_addr_with_relay` with an `OutboxAttemptError`
 * carrying `transient: false`. The TS-side outbox processor then writes
 * `status=FAILED, retry_count=1` immediately rather than backing off and
 * retrying five more times.
 *
 * The malformed-endpoint path is the cleanest permanent-error trigger
 * available without forging cryptographic material: a non-base32 string
 * cannot parse to an ed25519 public key, so no retry could ever change
 * the outcome.
 */

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

test.describe("invitations: permanent failure marks outbox FAILED on first attempt", () => {
  test.describe.configure({ mode: "serial" });
  // The flow is single-vault and bounded by one outbox poll tick (30s)
  // plus setup overhead.
  test.setTimeout(120_000);

  let vaultA: VaultAutomation;
  let nodeIdA: string;
  let relayUrlA: string | null;
  let identityA: { id: string; did: string };
  let spaceId: string;
  let inviteTokenId: string;
  let outboxRowId: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    await vaultA.createSession();
  });

  test.afterAll(async () => {
    if (spaceId) {
      try { await vaultA.invokeTauriCommand("local_delivery_stop", { spaceId }); } catch { /* ignore */ }
      try {
        await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
          sql: `DELETE FROM haex_invite_outbox WHERE space_id = ?1`,
          params: [spaceId],
        });
      } catch { /* best effort */ }
      try {
        await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
          sql: `DELETE FROM haex_spaces WHERE id = ?1`,
          params: [spaceId],
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
    try { await vaultA.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
  });

  test("Vault A is open (set up by global-setup)", async () => {
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
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

  test("load identity on Vault A", async () => {
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
  });

  test("create local space on Vault A and start the leader", async () => {
    spaceId = await createLocalSpaceViaUI(vaultA, `PermFail-${Date.now()}`);

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
    await wait(500);
  });

  // We need a real invite token row so the outbox processor's foreign-key
  // join finds capabilities + history flag. A standalone outbox row that
  // references a non-existent token would be SKIPPED with "token not found"
  // before ever reaching the QUIC dial path we want to test.
  test("mint an invite token on Vault A (target DID is a phantom)", async () => {
    inviteTokenId = await vaultA.invokeTauriCommand<string>(
      "local_delivery_create_invite",
      {
        spaceId,
        // Phantom target DID — irrelevant for this test because the
        // outbox row will fail at the QUIC connect step long before the
        // recipient could check audience binding. But the token row
        // requires *some* DID; using a syntactically valid one keeps the
        // INSERT clean.
        targetDid: "did:key:z6MkfakeNotAClaimantBeforePushInvite",
        capability: "space/read",
        maxUses: 1,
        expiresInSeconds: 3600,
        includeHistory: false,
      },
    );
    expect(inviteTokenId).toBeTruthy();
  });

  // Inject the outbox row directly. The `target_endpoint_id` is a deliberately
  // malformed string — iroh's `EndpointId::from_str` rejects it before any
  // network I/O, so `build_endpoint_addr_with_relay` returns an Err that the
  // command classifies as PERMANENT. Without the resilience fix this would
  // still eventually land in FAILED — but only after six transient retries
  // (~21 minutes); the assertion below requires it on the first try.
  test("insert outbox row with malformed target_endpoint_id", async () => {
    outboxRowId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const now = new Date().toISOString();
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_invite_outbox
              (id, space_id, token_id, target_did, target_endpoint_id, status,
               retry_count, next_retry_at, expires_at, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?8)`,
      params: [
        outboxRowId,
        spaceId,
        inviteTokenId,
        "did:key:z6MkfakeNotAClaimantBeforePushInvite",
        // Not a base32-encoded ed25519 public key — `iroh::EndpointId::parse`
        // returns InvalidLength/InvalidEncoding; the command path maps that
        // to OutboxAttemptError { transient: false }.
        "this-is-not-a-valid-iroh-endpoint-id-deadbeef",
        now,
        expiresAt,
        now,
      ],
    });
  });

  test("outbox row is marked FAILED with retry_count=1 on the first attempt", async () => {
    const row = await pollUntil(
      async () => {
        const rows = await sqlQuery<{
          status: string;
          retry_count: number;
          last_error: string | null;
          next_retry_at: string | null;
        }>(
          vaultA,
          `SELECT status, retry_count, last_error, next_retry_at
           FROM haex_invite_outbox WHERE id = ?1`,
          [outboxRowId],
        );
        const r = rows[0];
        if (!r) return null;
        return r.status === "failed" ? r : null;
      },
      // The outbox poll runs every 30s; the first attempt fires on the
      // next tick and lands FAILED immediately. 75s leaves room for two
      // ticks under load.
      { timeout: 75_000, interval: 3_000, label: "outbox row reaches FAILED" },
    );
    expect(row!.status).toBe("failed");
    // Key Layer 1 invariant: FAILED on the FIRST attempt, not after the
    // old 6-retry budget. retry_count=1 is the strongest evidence that
    // the row took the permanent-classification short-circuit.
    expect(row!.retry_count).toBe(1);
    // last_error surfacing is the responsibility of Schicht 3 (UI); the
    // wire-level happy path may leave it null when Tauri's error
    // serialization strips fields the IPC layer doesn't know about. Log
    // it here for diagnostic purposes but don't gate the regression on
    // it — status+retry_count already prove the classification.
    console.log(`[permanent-fail] outbox row final state: ${JSON.stringify(row)}`);
    // FAILED rows are not scheduled for further retries. The processor's
    // FAILED branch leaves next_retry_at unchanged (no explicit clear),
    // so the column may still carry the row's last-scheduled timestamp
    // from when it was PENDING — but since the processor's WHERE clause
    // also filters on status='pending', a stale value is harmless. What
    // we really want to assert is that, IF set, it's in the past (not
    // going to trigger a future tick), so a future code change that does
    // start clearing it doesn't break the test either.
    if (row!.next_retry_at) {
      expect(Date.parse(row!.next_retry_at)).toBeLessThanOrEqual(Date.now());
    }
  });

  // The mirror-property: a permanent FAILED row must not have an
  // accompanying delivered/expired sibling spawned by the same processor
  // pass. This catches a class of mis-classification where a permanent
  // failure also writes a pending follow-up.
  test("no sibling outbox row was spawned for the same token", async () => {
    const rows = await sqlQuery<{ id: string; status: string }>(
      vaultA,
      `SELECT id, status FROM haex_invite_outbox WHERE token_id = ?1`,
      [inviteTokenId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(outboxRowId);
    expect(rows[0].status).toBe("failed");
  });
});
