import { expect, test, VaultAutomation } from "../../../fixtures";
import { pollUntil, sqlQuery, wait } from "../../../helpers/ui/utils";
import { clickTestId, elementExists, mousedownClickFound } from "../../../helpers/ui/ui-primitives";
import { initializeVaultViaUI, openSettingsCategory, startP2PEndpoint } from "../../../helpers/ui/ui-vault";
import { QUIC_CONSTANTS, type QuicTestState } from "./state";

/**
 * Phase 1 — Setup: open both vaults, start P2P endpoints, load identities and
 * register Vault B as a contact on Vault A. This is the precondition that
 * every later phase depends on, so all assertions here are strict.
 *
 * Mutates `state.vaultA/vaultB/nodeIdA/nodeIdB/identityA/identityB`.
 */
export function registerSetupPhase(state: QuicTestState): void {
  const { contactLabel } = QUIC_CONSTANTS;

  test.beforeAll(async () => {
    state.vaultA = new VaultAutomation("A");
    state.vaultB = new VaultAutomation("B");
    await state.vaultA.createSession();
    await state.vaultB.createSession();
  });

  test.afterAll(async () => {
    for (const v of [state.vaultA, state.vaultB]) {
      if (!v) continue;
      for (const id of [state.spaceId, state.personalSpaceId]) {
        if (!id) continue;
        try { await v.invokeTauriCommand("local_delivery_stop", { spaceId: id }); } catch { /* ignore */ }
      }
      try { await v.invokeTauriCommand("peer_storage_stop", {}); } catch { /* ignore */ }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1 — Initialize vaults through the UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("open Vault A through UI", async () => {
    await initializeVaultViaUI(state.vaultA!, "QUIC Test A", "test-password-a");
    const href = await state.vaultA!.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("open Vault B through UI", async () => {
    await initializeVaultViaUI(state.vaultB!, "QUIC Test B", "test-password-b");
    const href = await state.vaultB!.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2 — Start P2P endpoints via Settings UI
  // ═══════════════════════════════════════════════════════════════════════════

  test("start P2P endpoint on Vault A", async () => {
    state.nodeIdA = await startP2PEndpoint(state.vaultA!);
    expect(state.nodeIdA).toBeTruthy();
    console.log(`[QUIC] Vault A endpoint: ${state.nodeIdA.slice(0, 16)}…`);
  });

  test("start P2P endpoint on Vault B", async () => {
    state.nodeIdB = await startP2PEndpoint(state.vaultB!);
    expect(state.nodeIdB).toBeTruthy();
    expect(state.nodeIdB).not.toBe(state.nodeIdA);
    console.log(`[QUIC] Vault B endpoint: ${state.nodeIdB.slice(0, 16)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3 — Load identities (SQL — no UI for raw identity viewing)
  // ═══════════════════════════════════════════════════════════════════════════

  test("load identity on Vault A", async () => {
    const rows = await pollUntil(
      async () => {
        try {
          const r = await sqlQuery<{ id: string; did: string }>(
            state.vaultA!,
            "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
          );
          return r.length > 0 ? r : null;
        } catch { return null; }
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault A" },
    );
    state.identityA = { id: rows![0].id, did: rows![0].did };
    expect(state.identityA.did).toContain("did:key:");
    console.log(`[QUIC] Identity A: ${state.identityA.did.slice(0, 30)}…`);
  });

  test("load identity on Vault B", async () => {
    const rows = await pollUntil(
      async () => {
        try {
          const r = await sqlQuery<{ id: string; did: string }>(
            state.vaultB!,
            "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
          );
          return r.length > 0 ? r : null;
        } catch { return null; }
      },
      { timeout: 30_000, interval: 2_000, label: "identity on Vault B" },
    );
    state.identityB = { id: rows![0].id, did: rows![0].did };
    expect(state.identityB.did).toContain("did:key:");
    console.log(`[QUIC] Identity B: ${state.identityB.did.slice(0, 30)}…`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4 — Share Vault B's identity and import as contact on Vault A
  //          Uses the JSON import flow in Settings → Contacts
  // ═══════════════════════════════════════════════════════════════════════════

  test("register Vault B as contact on Vault A via JSON import", async () => {
    const vaultA = state.vaultA!;
    const identityB = state.identityB!;
    const nodeIdB = state.nodeIdB!;

    // Build the identity JSON payload (same format as ShareIdentityDialog / QR export)
    const identityPayload = JSON.stringify({
      did: identityB.did,
      name: contactLabel,
      claims: [{ type: "endpointId", value: nodeIdB }],
    });

    // Best-effort cleanup so that on a clean run the DB-side assertions
    // below verify a fresh import rather than passing trivially against
    // leftover rows. A hard DELETE can fail FK constraints on retries
    // (haex_space_devices.identityId etc. reference this row), and we
    // can't reliably cascade those without dropping unrelated state, so
    // we accept that retries verify the idempotent outcome instead. The
    // hard `expect` assertions on each UI step below are what actually
    // guarantees the import flow ran.
    try {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `DELETE FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
        params: [identityB.did],
      });
    } catch {
      // FK constraint expected on retries — fall through to the UI flow.
    }

    // Navigate to Settings → Contacts
    await openSettingsCategory(vaultA, "contacts");
    await wait(500);

    // Click "Add" button — every step from here is required for the import to
    // land, so a false return value means the import never happened.
    const addClicked = await clickTestId(vaultA, "contacts-add-trigger");
    expect(addClicked).toBe(true);
    await wait(800);

    const dialogOpen = await elementExists(vaultA, '[role="dialog"]');
    expect(dialogOpen).toBe(true);

    // Click the "From file" tab. reka-ui TabsTrigger activates on
    // mousedown.left, NOT click — see mousedownClickFound.
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

    // Paste JSON into the textarea
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

    // Click "Preview"
    const previewClicked = await clickTestId(vaultA, "contacts-import-preview");
    expect(previewClicked).toBe(true);
    await wait(500);

    // Click "Add" to confirm import
    const submitClicked = await clickTestId(vaultA, "contacts-import-submit");
    expect(submitClicked).toBe(true);
    await wait(1000);

    // Verify contact exists in DB
    const contacts = await sqlQuery<{ id: string }>(
      vaultA,
      `SELECT id FROM haex_identities WHERE did = ?1 AND private_key IS NULL`,
      [identityB.did],
    );
    expect(contacts.length).toBe(1);

    // Verify endpointId claim was saved
    const claims = await sqlQuery<{ type: string; value: string }>(
      vaultA,
      `SELECT type, value FROM haex_identity_claims WHERE identity_id = ?1`,
      [contacts[0].id],
    );
    console.log(`[QUIC] Contact claims: ${JSON.stringify(claims)}`);
    const epClaim = claims.find((c) => c.type === "endpointId");
    expect(epClaim).toBeDefined();
    expect(epClaim!.value).toBe(nodeIdB);
  });
}
