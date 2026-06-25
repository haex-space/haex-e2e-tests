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
const VAULT_B_NAME = "Autostart Invitee B";
const VAULT_B_PASSWORD = "test-password-b";

test.describe("invitations: targeted invite reaches a passive (autostart-only) invitee", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA = "";
  let endpointIdB = "";
  let didB = "";
  // The shared baseline vault open on Vault B before this spec swaps in its own
  // fresh vault. afterAll restores it so downstream specs reuse it (see afterAll).
  let originalVaultBName: string | null = null;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();
  });

  test.afterAll(async () => {
    // Restore the shared baseline vault on Vault B. This spec is the only one in
    // the workflows shard that swaps Vault B away from the warm baseline ("QUIC
    // Test B") — every other invite spec reuses it via initializeVaultViaUI's
    // "already at /vault/" early-return. Leaving the fresh "Autostart Invitee B"
    // active makes the LATER cross-vault-file-sharing spec dial a cold endpoint
    // that never connects (connectedPeers: []). Re-open the baseline via UI so
    // downstream specs see exactly the state they would on main.
    try {
      await vaultB?.invokeTauriCommand("close_database", {});
      const baseline =
        originalVaultBName ??
        (await vaultB.invokeTauriCommand<Array<{ name: string }>>("list_vaults", {}))
          .map((v) => v.name)
          .find((n) => n !== VAULT_B_NAME) ??
        null;
      if (baseline) {
        await vaultB.navigateTo("/");
        await pollUntil(
          async () => {
            const h = await vaultB.executeScript<string>("return location.href");
            return h && !h.includes("/vault/") ? true : null;
          },
          { timeout: 30_000, interval: 500, label: "Vault B at picker (restore)" },
        );
        await vaultB.executeScript(`
          const app = document.getElementById('__nuxt')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          const store = pinia?._s?.get('lastVaultStore');
          if (store?.syncLastVaultsAsync) await store.syncLastVaultsAsync();
        `);
        await initializeVaultViaUI(vaultB, baseline, VAULT_B_PASSWORD);
      }
    } catch (err) {
      console.warn("[E2E] Vault B baseline restore failed:", err);
    }

    for (const v of [vaultA, vaultB]) {
      try {
        await v?.invokeTauriCommand("peer_storage_stop", {});
      } catch (err) {
        // Don't swallow silently: a leaked endpoint here can make a LATER spec's
        // failure look unrelated. Log and continue the best-effort teardown.
        console.warn(
          `[E2E] peer_storage_stop failed on Vault ${v?.getInstance?.() ?? "?"}:`,
          err,
        );
      }
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
  // Invitee: a FRESH vault, opened via UI ONLY. No startP2PEndpoint() — the
  // invitee coming up on its own is the whole point.
  //
  // Earlier specs leave the prior vault ("QUIC Test B") MOUNTED on Vault B's
  // Rust process. Two facts make this the crux of the whole spec:
  //   • create_encrypted_database refuses a second in-process mount and throws
  //     `VaultAlreadyMountedInProcess`; the create-vault drawer's onCreateAsync
  //     swallows that error, so the drawer path just silently no-ops and the
  //     desktop poll times out.
  //   • `navigateTo` on the cross-container Vault B has no `$router` and falls
  //     back to a hard `location.href` reload, which does NOT run the
  //     `onBeforeRouteLeave` guard — so navigating to `/` never closes the DB.
  //     The Rust mount survives the reload (it is process-global).
  // So we must close the mounted vault EXPLICITLY on the Rust side, then create
  // the fresh vault via the same backend command global-setup uses, then open
  // it via UI to drive the Welcome dialog → device row → deviceRowId autostart.
  // Leaving Vault B back on `/vault/<new id>` also keeps later specs (which
  // reuse the shared session via the "already at /vault/" early-return) green.
  // ───────────────────────────────────────────────────────────────────────────
  test("init invitee (Vault B) via UI WITHOUT starting P2P", async () => {
    // Remember the baseline vault (e.g. "QUIC Test B") so afterAll can restore
    // it for the downstream specs that reuse the shared session.
    originalVaultBName =
      (await vaultB.invokeTauriCommand<Array<{ name: string }>>("list_vaults", {}))
        .map((v) => v.name)
        .find((n) => n !== VAULT_B_NAME) ?? originalVaultBName;

    // 1. Unmount whatever a prior spec left mounted. close_database is the only
    //    reliable way here — the navigate-to-`/` below is a hard reload that
    //    bypasses the route-guard close. Safe to call when nothing is mounted.
    await vaultB.invokeTauriCommand("close_database", {}).catch(() => {});

    // 2. Create the fresh invitee vault via the backend command (idempotent
    //    across Playwright retries). create_encrypted_database also mounts it,
    //    so close_database releases it again for the UI open to take over.
    const existing = await vaultB.invokeTauriCommand<Array<{ name: string }>>(
      "list_vaults",
      {},
    );
    if (!existing.some((v) => v.name === VAULT_B_NAME)) {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: VAULT_B_NAME,
        key: VAULT_B_PASSWORD,
        spaceId: null,
      });
      await vaultB.invokeTauriCommand("close_database", {}).catch(() => {});
    }

    // 3. Return to the picker. navigateTo hard-reloads Vault B, so index.vue's
    //    onMounted re-runs syncLastVaultsAsync and the freshly-created vault
    //    shows up in the list for the open path below.
    await vaultB.navigateTo("/");
    await pollUntil(
      async () => {
        const h = await vaultB.executeScript<string>("return location.href");
        return h && !h.includes("/vault/") ? true : null;
      },
      { timeout: 30_000, interval: 500, label: "Vault B at picker (URL left /vault/)" },
    );

    // 4. Belt-and-suspenders: if navigateTo ever resolves to an in-app router
    //    push (no reload), the list won't have re-synced — refresh it directly.
    await vaultB.executeScript(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const store = pinia?._s?.get('lastVaultStore');
      if (store?.syncLastVaultsAsync) await store.syncLastVaultsAsync();
    `);

    // 5. Open via UI → vault.vue mounts → Welcome dialog (fresh vault) → device
    //    row committed → deviceRowId watcher fires the P2P autostart we guard.
    await initializeVaultViaUI(vaultB, VAULT_B_NAME, VAULT_B_PASSWORD);

    // The device row (and its persistent endpoint id) exists after the Welcome
    // dialog committed it — independent of whether the endpoint is running.
    // ORDER BY created_at keeps the device/identity pair deterministic.
    const devRows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ endpoint_id: string }>(
          vaultB,
          "SELECT endpoint_id FROM haex_devices WHERE endpoint_id IS NOT NULL ORDER BY created_at LIMIT 1",
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
          "SELECT did FROM haex_identities WHERE private_key IS NOT NULL ORDER BY created_at LIMIT 1",
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

    // onImportContactAsync chains several async DB writes (identity insert +
    // claims + reactive store reload). The 1s wait raced these under
    // workflows-shard load and the assertions saw both contacts.length=0
    // and (when the identity row arrived first) the claim row missing.
    // Poll for BOTH the identity AND its endpointId claim in one step.
    const importRow = await pollUntil(
      async () => {
        const identities = await sqlQuery<{ id: string }>(
          vaultA,
          `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
          [didB],
        );
        if (identities.length !== 1) return null;
        const claims = await sqlQuery<{ type: string; value: string }>(
          vaultA,
          `SELECT type, value FROM haex_identity_claims WHERE identity_id = ?1`,
          [identities[0].id],
        );
        const ep = claims.find((c) => c.type === "endpointId");
        return ep ? { identityId: identities[0].id, claim: ep } : null;
      },
      {
        timeout: 10_000,
        interval: 500,
        label: "imported contact + endpointId claim on Vault A",
      },
    );
    expect(importRow).not.toBeNull();
    expect(importRow!.claim.value).toBe(endpointIdB);
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
