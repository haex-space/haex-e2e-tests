// Regression test for the "Add Sync Backend" flow in the Tauri webview.
//
// Bug: production sync backends (e.g. sync.haex.space) — and the e2e test
// sync-server — do not include `tauri://localhost` in their CORS allowlist,
// so any browser-side `fetch()` to /identity-auth/* from the Tauri webview is
// blocked with "Origin tauri://localhost is not allowed by
// Access-Control-Allow-Origin". The user sees the Add Backend form sit there
// with a network error instead of loading the server's claim requirements.
//
// Fix: route the HTTP calls in useCreateSyncConnection through the
// @tauri-apps/plugin-http `fetch`, which proxies the request through Rust and
// bypasses browser CORS entirely. capabilities/default.json already allows
// `https://*.haex.space` and `http://localhost:*` so no permission change is
// needed.
//
// This test drives the real Add Backend UI:
//   1. Open Vault A
//   2. Open Settings → Sync → click "Add Backend"
//   3. Pick the "Custom" server URL option, enter the test sync-server URL
//   4. Pick the auto-created identity
//   5. Wait for the requirements section to render
//
// Before the fix the requirements fetch is blocked by CORS and the form shows
// a red UAlert with the network error → assertion fails.
// After the fix the fetch goes through the Rust HTTP plugin, requirements
// load, and the claim-consent UI renders → assertion passes.

import { test, expect, VaultAutomation } from "../fixtures";
import { getSyncServerUrl } from "../helpers";
import {
  initializeVaultViaUI,
  openSettingsCategory,
} from "../helpers/ui/ui-vault";
import {
  clickButton,
  clickTestId,
  elementExists,
} from "../helpers/ui/ui-primitives";
import { pollUntil, sqlQuery, wait } from "../helpers/ui/utils";

test.describe("Sync: Add Backend respects Tauri webview CORS", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  const syncServerUrl = getSyncServerUrl();

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Vault A is shared across the workflow shard. The previous suite may
    // have left the WebView URL at /vault/ but closed the underlying DB
    // (vault-lifecycle's open-close suite + restoreOriginalVault both
    // touch close_database). `initializeVaultViaUI` only checks the URL
    // for early-return, so without an explicit reset we'd skip the open
    // and hit "Connection to vault failed" on the first sqlQuery.
    // Force-close + navigate-back so the next initializeVaultViaUI call
    // takes the real create/open path against a known clean state.
    try { await vault.invokeTauriCommand("close_database", {}); } catch { /* may already be closed */ }
    try { await vault.navigateTo("/"); } catch { /* best effort */ }
  });

  test("open Vault A via UI", async () => {
    await initializeVaultViaUI(vault, "Sync CORS Test", "test-password-cors");
    const href = await vault.executeScript<string>("return location.href");
    expect(href).toContain("/vault/");
  });

  test("vault has a usable identity", async () => {
    const rows = await pollUntil(
      async () => {
        const r = await sqlQuery<{ id: string; did: string }>(
          vault,
          "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        );
        return r.length > 0 ? r : null;
      },
      { timeout: 30_000, interval: 2_000, label: "identity present" },
    );
    expect(rows![0].did).toContain("did:key:");
  });

  test("Add Backend → custom URL → requirements load without CORS error", async () => {
    // Step 1 — open Sync settings, drill into the "Backends" sub-view, then
    // open the Add Backend form. Sync settings is a drill-down menu — the
    // Add Backend button only renders inside the "Backends" sub-view.
    await openSettingsCategory(vault, "sync");
    await wait(800);

    await pollUntil(
      () => clickButton(vault, "Sync Backends", "Sync-Backends"),
      { timeout: 10_000, interval: 500, label: "Sync → Backends menu item" },
    );
    await wait(800);

    await pollUntil(
      () => clickTestId(vault, "sync-add-backend-button"),
      { timeout: 10_000, interval: 500, label: "Add Backend button" },
    );
    await wait(500);

    // Step 2 — open the server URL select and pick "Custom".
    // The trigger is the first reka-ui combobox button inside the form.
    const triggerClicked = await vault.executeScript<boolean>(`
      const btn = document.querySelector('button[aria-haspopup="listbox"]');
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      btn.click?.();
      return true;
    `);
    expect(triggerClicked).toBe(true);

    await pollUntil(
      () =>
        vault.executeScript<boolean>(
          `return document.querySelectorAll('[role="option"]').length > 0;`,
        ),
      { timeout: 10_000, interval: 500, label: "server-URL dropdown options" },
    );

    const customSelected = await vault.executeScript<boolean>(`
      const opts = [...document.querySelectorAll('[role="option"]')];
      const match = opts.find(o => {
        const t = (o.textContent ?? '').toLowerCase();
        return t.includes('custom') || t.includes('benutzerdefiniert');
      }) ?? opts[opts.length - 1];
      if (!match) return false;
      match.click?.();
      return true;
    `);
    expect(customSelected).toBe(true);

    // Step 3 — type the test sync-server URL. The custom URL input is a
    // Nuxt-UI <UiInput> wrapper around a native <input>; v-model is bound to
    // `customServerUrl`. We push the value through the native setter to make
    // sure Vue's reactivity actually picks it up — sendKeys can race with the
    // dropdown's close transition and leave the field empty.
    await pollUntil(
      () => elementExists(vault, '[data-testid="sync-custom-url-input"] input'),
      { timeout: 10_000, interval: 500, label: "custom URL input" },
    );

    const urlSet = await vault.executeScript<{ ok: boolean; value: string }>(`
      const input = document.querySelector('[data-testid="sync-custom-url-input"] input');
      if (!input) return { ok: false, value: '(no input)' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, ${JSON.stringify(syncServerUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: input.value };
    `);
    expect(urlSet.ok).toBe(true);
    expect(urlSet.value).toBe(syncServerUrl);
    await wait(300);

    // Step 4 — open the identity select and pick the first identity.
    // The form now has two `aria-haspopup="listbox"` triggers — the server one
    // and the identity one. Pick the second.
    const identityOpened = await vault.executeScript<boolean>(`
      const btns = [...document.querySelectorAll('button[aria-haspopup="listbox"]')];
      const btn = btns[btns.length - 1];
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      btn.click?.();
      return true;
    `);
    expect(identityOpened).toBe(true);

    await pollUntil(
      () =>
        vault.executeScript<boolean>(
          `return document.querySelectorAll('[role="option"]').length > 0;`,
        ),
      { timeout: 10_000, interval: 500, label: "identity dropdown options" },
    );

    const identityPicked = await vault.executeScript<boolean>(`
      const opts = [...document.querySelectorAll('[role="option"]')];
      if (opts.length === 0) return false;
      opts[0].click?.();
      return true;
    `);
    expect(identityPicked).toBe(true);

    // Step 5 — wait for the requirements fetch to settle. The component shows
    // either a red UAlert (CORS error) or claim-consent rows.
    const result = await pollUntil(
      async () => {
        const state = await vault.executeScript<{
          loading: boolean;
          errorText: string | null;
          claimCount: number;
        }>(`
          const loading = !!document.querySelector('.i-lucide-loader-2');
          const alerts = [...document.querySelectorAll('[role="alert"]')];
          const errorText = alerts.length > 0 ? (alerts[alerts.length - 1].textContent ?? '').trim() : null;
          const claimCount = document.querySelectorAll('[role="checkbox"]').length;
          return { loading, errorText, claimCount };
        `);
        if (state.loading) return null;
        if (state.errorText || state.claimCount > 0) return state;
        return null;
      },
      {
        timeout: 20_000,
        interval: 1_000,
        label: "requirements fetch resolves",
      },
    );

    // The fetch must not surface an error. Today this fails with a CORS error
    // string mentioning "Failed to fetch" / "CORS" / similar; after the fix
    // the alert never appears and claim-consent rows render.
    expect(
      result!.errorText,
      `requirements fetch errored: ${result!.errorText}`,
    ).toBeNull();
    expect(result!.claimCount).toBeGreaterThan(0);
  });

  // Why the previous test is meaningful: a plain `fetch()` from the Tauri
  // webview to the same URL is rejected by browser CORS. Capturing that here
  // proves the previous test isn't passing because CORS happened to be lax —
  // it's passing because the production code path routes through Rust
  // (tauri-plugin-http) instead of `window.fetch`.
  test("plain browser fetch is blocked by CORS (regression boundary)", async () => {
    const probe = await vault.executeScript<{
      ok: boolean;
      status: number;
      error: string | null;
    }>(`
      const url = ${JSON.stringify(syncServerUrl)} + '/identity-auth/requirements';
      try {
        const res = await fetch(url);
        return { ok: res.ok, status: res.status, error: null };
      } catch (e) {
        return { ok: false, status: 0, error: String(e && e.message ? e.message : e) };
      }
    `);

    // The webview origin is `tauri://localhost` and the e2e sync-server runs
    // without CORS_ORIGIN, so the preflight has no matching
    // Access-Control-Allow-Origin and the browser blocks the response. The
    // exact failure mode varies — WebKit raises a network exception
    // ("Load failed"), others return !ok — but it can never succeed.
    expect(probe.ok).toBe(false);
  });
});
