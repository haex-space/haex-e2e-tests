import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../helpers/ui/utils";
import { clickTestId, elementExists, mousedownClickFound } from "../../helpers/ui/ui-primitives";
import {
  initializeVaultViaUI,
  openSettingsCategory,
  startP2PEndpoint,
} from "../../helpers/ui/ui-vault";
import { createLocalSpaceViaUI, sendInviteViaUI } from "./quic-helpers/ui-spaces";

/**
 * Regression: a targeted invite sent while the recipient is offline must
 * stay PENDING in the inviter's outbox — never permanently FAILED — and
 * land on the recipient within seconds once their peer storage comes back
 * online, **without** an inviter restart.
 *
 * Plan reference: docs/plans/2026-06-15-invite-outbox-resilience.md
 *   - Schicht 1 (transient → PENDING, never FAILED before expiresAt)
 *   - Schicht 2 (connection-event-driven flush short-circuits backoff
 *     once the recipient is reachable again)
 *
 * Before the fix this scenario would mark the outbox row FAILED after
 * 6 retries (~21 minutes); recipients coming back online later than that
 * would never receive the invite without manually re-triggering it on
 * the inviter side. The Layer 1 + 2 fix in haex-vault#454 keeps the row
 * PENDING with capped exponential backoff so a later online window
 * delivers cleanly.
 */

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

test.describe("invitations: targeted invite is delivered after recipient comes online late", () => {
  test.describe.configure({ mode: "serial" });
  // The flow includes a "wait for at least one transient retry before B
  // comes online" phase which has to outlast the 30-second outbox poll
  // tick, plus the delivery wait afterwards. 240s leaves margin for
  // container slowness.
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  let identityA: { id: string; did: string };
  let identityB: { id: string; did: string };
  let spaceId: string;
  let spaceName: string;
  const contactLabel = "OnlineLate Vault B Contact";

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    // Same cleanup pattern as targeted-invite-did-mismatch — vaultA is
    // shared across suites, so we have to remove the space we created
    // plus restart-friendly state, but must NOT close_database on it.
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
    for (const v of [vaultA, vaultB]) {
      if (!v) continue;
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  test("Vault A is open (set up by global-setup)", async () => {
    const href = await vaultA.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("Vault B has an open vault", async () => {
    await initializeVaultViaUI(vaultB, "OnlineLate Vault B", "test-password-online-late-b");
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

  // We start Vault B's P2P just so its haex_identities + haex_devices rows
  // get populated and a contact import on Vault A finds a valid endpoint
  // claim. Immediately after we stop it again — the *test* premise is
  // "Vault B is offline when the invite is sent".
  test("start P2P endpoint on Vault B (transient — needed to seed identity/device rows)", async () => {
    nodeIdB = await startP2PEndpoint(vaultB);
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

  // Vault B becomes a contact on Vault A — sendInviteViaUI looks for the
  // contact by label in the SpaceInviteDialog, so this is the input the
  // invite flow ends up dispatching against. Same flow as Phase 1 of the
  // QUIC invite-flow suite, inlined here to keep this spec self-contained.
  test("register Vault B as contact on Vault A via JSON import", async () => {
    const identityPayload = JSON.stringify({
      did: identityB.did,
      name: contactLabel,
      claims: [{ type: "endpointId", value: nodeIdB }],
    });

    try {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `DELETE FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
        params: [identityB.did],
      });
    } catch {
      // FK constraint on retries — fall through to the UI flow.
    }

    await openSettingsCategory(vaultA, "contacts");
    await wait(500);

    const addClicked = await clickTestId(vaultA, "contacts-add-trigger");
    expect(addClicked).toBe(true);
    await wait(800);

    expect(await elementExists(vaultA, '[role="dialog"]')).toBe(true);

    const tabSwitched = await mousedownClickFound(
      vaultA,
      `
        const container = document.querySelector('[data-testid="contacts-add-tabs"]');
        if (!container) return null;
        const tabs = [...container.querySelectorAll('[role="tab"]')];
        return tabs.find(t => {
          const text = t.textContent?.toLowerCase() || '';
          return text.includes('file') || text.includes('datei');
        }) ?? null;
      `,
    );
    expect(tabSwitched).toBe(true);
    await wait(300);

    const pasted = await vaultA.executeScript<boolean>(`
      const el = document.querySelector('[data-testid="contacts-import-json"]');
      const textarea = el?.tagName === 'TEXTAREA' ? el : el?.querySelector('textarea');
      if (!textarea) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(identityPayload)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    expect(pasted).toBe(true);
    await wait(300);

    expect(await clickTestId(vaultA, "contacts-import-preview")).toBe(true);
    await wait(500);
    expect(await clickTestId(vaultA, "contacts-import-submit")).toBe(true);
    await wait(1000);

    const contacts = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
      [identityB.did],
    );
    expect(contacts.length).toBe(1);
  });

  test("create local space on Vault A and start the leader", async () => {
    spaceName = `OnlineLate-${Date.now()}`;
    spaceId = await createLocalSpaceViaUI(vaultA, spaceName);
    expect(spaceId).toBeTruthy();

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

  // Simulates "recipient is offline at the moment the invite is sent".
  // Doing this before sendInviteViaUI guarantees the first delivery attempt
  // dials a dead endpoint instead of racing the recipient.
  test("stop Vault B's peer storage to simulate offline recipient", async () => {
    await vaultB.invokeTauriCommand("peer_storage_stop", {});
    const status = await vaultB.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    expect(status.running).toBe(false);
  });

  test("Vault A sends a targeted invite to Vault B (write capability)", async () => {
    await sendInviteViaUI(vaultA, spaceName, contactLabel, true);

    // The invite-outbox row appears immediately in haex_invite_outbox.
    const outboxRows = await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string; status: string; retry_count: number }>(
          vaultA,
          `SELECT id, status, retry_count FROM haex_invite_outbox
           WHERE space_id = ?1 AND target_did = ?2`,
          [spaceId, identityB.did],
        );
        return rows.length > 0 ? rows : null;
      },
      { timeout: 30_000, interval: 2_000, label: "outbox row created" },
    );
    expect(outboxRows!.length).toBeGreaterThanOrEqual(1);
  });

  // Key Layer 1 assertion: at least one delivery attempt has failed
  // (recipient is offline) AND the row is still PENDING, not FAILED.
  // Before the resilience fix a transient failure would eventually hit
  // FAILED at retryCount=6; here we just wait for the FIRST retry tick
  // and check that the row stayed PENDING.
  test("outbox stays PENDING with retry_count > 0 while recipient is offline", async () => {
    const row = await pollUntil(
      async () => {
        const rows = await sqlQuery<{ status: string; retry_count: number; last_error: string | null }>(
          vaultA,
          `SELECT status, retry_count, last_error FROM haex_invite_outbox
           WHERE space_id = ?1 AND target_did = ?2`,
          [spaceId, identityB.did],
        );
        const r = rows[0];
        if (!r) return null;
        return r.retry_count > 0 ? r : null;
      },
      // Outbox poll runs every 30s; first failed attempt should land within
      // ~60s. Beyond that we'd be hitting something other than the
      // ordinary poll cadence and the test wants to fail loudly.
      { timeout: 90_000, interval: 3_000, label: "retry_count > 0 (first attempt failed)" },
    );
    expect(row!.status).toBe("pending");
    expect(row!.retry_count).toBeGreaterThan(0);
    // Sanity: lastError records *why* it stayed PENDING, must not be empty.
    expect(row!.last_error).toBeTruthy();
  });

  // Now Vault B comes back online. Crucially: we do NOT touch Vault A here.
  // The fix's promise is that A's existing outbox row delivers on its next
  // retry once the path becomes live again, no inviter-side intervention.
  test("Vault B comes back online (peer_storage_start)", async () => {
    const info = await vaultB.invokeTauriCommand<PeerStorageStartInfo>("peer_storage_start", {});
    // nodeId must be stable across restart — same identity, same endpoint id.
    expect(info.nodeId).toBe(nodeIdB);
    const status = await vaultB.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
    expect(status.running).toBe(true);
  });

  test("invite is delivered to Vault B without inviter restart", async () => {
    await pollUntil(
      async () => {
        const rows = await sqlQuery<{ id: string; status: string }>(
          vaultB,
          `SELECT id, status FROM haex_pending_invites WHERE space_id = ?1`,
          [spaceId],
        );
        return rows.find((r) => r.status === "pending") ?? null;
      },
      // After B comes online the next outbox poll on A delivers within
      // ~30s. Allow 90s for container scheduling slack — much beyond that
      // suggests the retry path didn't reach B.
      { timeout: 90_000, interval: 3_000, label: "pending invite arrives on Vault B" },
    );

    const outboxFinal = await pollUntil(
      async () => {
        const rows = await sqlQuery<{ status: string }>(
          vaultA,
          `SELECT status FROM haex_invite_outbox
           WHERE space_id = ?1 AND target_did = ?2`,
          [spaceId, identityB.did],
        );
        return rows.find((r) => r.status === "delivered") ?? null;
      },
      { timeout: 30_000, interval: 2_000, label: "outbox row marked DELIVERED on A" },
    );
    expect(outboxFinal!.status).toBe("delivered");
  });
});
