/**
 * Regression: a targeted invite must reach a PASSIVE, freshly-initialized
 * invitee whose P2P endpoint was never started explicitly.
 *
 * ── Why this spec exists ────────────────────────────────────────────────────
 * Invitations to a local-only / personal space are delivered solely via the
 * inviter's QUIC outbox dialing the invitee's endpoint directly. Delivery
 * therefore depends on the invitee's `peer_storage` endpoint being up and
 * relay-reachable at send time.
 *
 * On a fresh vault, `useDeviceStore().resolveAsync()` returns 'pending' and the
 * `haex_devices` row only appears after the user completes the Welcome /
 * device-reconciliation dialog. The vault used to gate P2P autostart on the
 * device row being present *at mount* — a one-shot check that had already run
 * (and skipped) by the time the dialog committed the row. Result: the invitee
 * silently never listened, the inviter's PushInvite connect-timed-out, and the
 * invite never arrived until the next full app restart.
 *
 * The pre-existing `quic-invite-flow` spec cannot catch this because it calls
 * `startP2PEndpoint()` on BOTH vaults, masking the missing autostart. Here we
 * deliberately DO NOT start Vault B — the invitee must come up on its own.
 *
 * ── Companion-merge order ───────────────────────────────────────────────────
 * Requires the vault-side fix "reactive P2P autostart after device
 * reconciliation" (watch on `deviceRowId`). The vault PR MUST merge before this
 * spec lands on main, or e2e main goes red until the vault catches up.
 */

import { expect, test, VaultAutomation } from "../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../helpers/ui/utils";
import {
  clickTestId,
  elementExists,
  mousedownClickFound,
} from "../../helpers/ui/ui-primitives";
import {
  initializeVaultViaUI,
  openSettingsCategory,
  startP2PEndpoint,
} from "../../helpers/ui/ui-vault";
import { sendInviteViaUI } from "./quic-helpers/ui-spaces";

const CONTACT_LABEL = "Passive Invitee B";

test.describe("invitations: targeted invite reaches a passive (autostart-only) invitee", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA = "";
  let endpointIdB = "";
  let didB = "";

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [vaultA, vaultB]) {
      try { await v?.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Inviter: normal setup — it must be running to send.
  // ───────────────────────────────────────────────────────────────────────────
  test("init inviter (Vault A) and start its P2P endpoint", async () => {
    await initializeVaultViaUI(vaultA, "Autostart Inviter A", "test-password-a");
    nodeIdA = await startP2PEndpoint(vaultA);
    expect(nodeIdA).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Invitee: init via UI ONLY. No startP2PEndpoint() — that is the whole point.
  //
  // Prior specs in the shared docker session leave Vault B inside an open
  // /vault/<id>, which causes `initializeVaultViaUI` to short-circuit on its
  // "already open" check — the Welcome dialog never runs, `deviceRowId` never
  // transitions from '' to a fresh value, and the autostart watcher under test
  // has no edge to react to. Navigating back to the index closes the prior
  // vault (onBeforeRouteLeave → closeAsync → peer_storage_stop) so the new
  // vault genuinely starts from "pending reconciliation".
  // ───────────────────────────────────────────────────────────────────────────
  test("init invitee (Vault B) via UI WITHOUT starting P2P", async () => {
    await vaultB.navigateTo("/");
    await wait(1500);
    await initializeVaultViaUI(vaultB, "Autostart Invitee B", "test-password-b");

    // The device row (and its persistent endpoint id) exists after the Welcome
    // dialog committed it — independent of whether the endpoint is running.
    const devRows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ endpoint_id: string }>(
          vaultB,
          "SELECT endpoint_id FROM haex_devices WHERE endpoint_id IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 1_000, label: "Vault B device row" },
    );
    endpointIdB = devRows![0].endpoint_id;
    expect(endpointIdB).toBeTruthy();

    const idRows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ did: string }>(
          vaultB,
          "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 1_000, label: "Vault B identity" },
    );
    didB = idRows![0].did;
    expect(didB).toContain("did:key:");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE REGRESSION GUARD — fresh vault must bring its endpoint up on its own.
  // ───────────────────────────────────────────────────────────────────────────
  test("Vault B autostarts peer_storage after reconciliation (no explicit start)", async () => {
    const status = await pollUntil(
      async () => {
        const s = await vaultB.invokeTauriCommand<{ running: boolean; nodeId: string }>(
          "peer_storage_status",
          {},
        );
        return s.running && s.nodeId ? s : null;
      },
      // Pre-fix this times out: the one-shot mount gate skipped autostart while
      // the device was still 'pending', and nothing restarted it once the
      // Welcome dialog committed the row. Post-fix the `deviceRowId` watcher
      // fires startAsync().
      { timeout: 45_000, interval: 1_000, label: "Vault B P2P autostart" },
    );
    expect(status!.running).toBe(true);
    expect(status!.nodeId).toBe(endpointIdB);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Register Vault B as a contact on Vault A (JSON-import flow, mirrors
  // quic-phases/01-setup). Uses Vault B's persistent endpoint id so the invite
  // dials the endpoint that autostart brought up.
  // ───────────────────────────────────────────────────────────────────────────
  test("register Vault B as contact on Vault A via JSON import", async () => {
    const identityPayload = JSON.stringify({
      did: didB,
      name: CONTACT_LABEL,
      claims: [{ type: "endpointId", value: endpointIdB }],
    });

    // Best-effort cleanup so a clean run verifies a fresh import. A hard DELETE
    // can hit FK constraints on retries; we accept the idempotent outcome.
    try {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `DELETE FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
        params: [didB],
      });
    } catch { /* FK on retry — fall through to the UI flow */ }

    await openSettingsCategory(vaultA, "contacts");
    await wait(500);

    const addClicked = await clickTestId(vaultA, "contacts-add-trigger");
    expect(addClicked).toBe(true);
    await wait(800);

    expect(await elementExists(vaultA, '[role="dialog"]')).toBe(true);

    // reka-ui TabsTrigger activates on mousedown.left, not click.
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
      [didB],
    );
    expect(contacts.length).toBe(1);

    const claims = await sqlQuery<{ type: string; value: string }>(
      vaultA,
      `SELECT type, value FROM haex_identity_claims WHERE identity_id = ?1`,
      [contacts[0].id],
    );
    const epClaim = claims.find((c) => c.type === "endpointId");
    expect(epClaim).toBeDefined();
    expect(epClaim!.value).toBe(endpointIdB);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The user-visible outcome: invite must land on B with NO restart.
  // ───────────────────────────────────────────────────────────────────────────
  test("targeted invite to Personal space reaches passive Vault B", async () => {
    // Clear any stale pending rows so the poll observes THIS invite.
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_pending_invites`,
      params: [],
    });

    await sendInviteViaUI(vaultA, "Personal", CONTACT_LABEL);

    const invites = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string }>(
          vaultB,
          `SELECT id FROM haex_pending_invites WHERE status = 'pending'`,
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 120_000, interval: 1_000, label: "invite delivery to passive Vault B" },
    );
    expect(invites!.length).toBeGreaterThan(0);
  });
});
