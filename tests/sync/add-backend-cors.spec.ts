// Regression test for the "Add Sync Backend" flow in the Tauri webview.
//
// Bug: production sync backends (e.g. sync.haex.space) — and the e2e test
// sync-server — do not include `tauri://localhost` in their CORS allowlist,
// so any browser-side `fetch()` to /identity-auth/* from the Tauri webview
// is blocked with "Origin tauri://localhost is not allowed by
// Access-Control-Allow-Origin". The user sees the Add Backend form sit
// there with a network error instead of loading the server's claim
// requirements.
//
// Fix: route the HTTP calls in `useCreateSyncConnection` (and friends)
// through `@tauri-apps/plugin-http`'s `fetch`, which proxies the request
// through Rust and bypasses browser CORS. The capability scope was also
// widened from `*.haex.space` + localhost to all `http(s)://**` to support
// BYO sync-servers (including the e2e rig's `http://sync-server:3002`).
//
// This spec exercises the production fetch path directly via plugin-http
// rather than driving the Add Backend UI form. The UI form layers Nuxt
// UI's combobox + reactive watchers on top of the same fetch, but
// reproducing the reactive trigger chain via WebDriver-injected DOM
// mutation is brittle in CI. The bug under regression is in the FETCH
// PATH (capability scope + plugin selection), not the form — so we test
// what's actually load-bearing.

import { test, expect, VaultAutomation } from "../fixtures";
import { getSyncServerUrl } from "../helpers";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, sqlQuery } from "../helpers/ui/utils";

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

  test("plugin-http reaches sync-server (the production fetch path)", async () => {
    // The Add Backend flow's `fetchRequirementsAsync` calls
    // `@tauri-apps/plugin-http`'s `fetch` against
    // `${originUrl}/identity-auth/requirements`. We exercise the exact
    // same Rust plugin (`plugin:http|fetch` + `plugin:http|fetch_send`)
    // directly via Tauri internals to verify the production path works
    // end-to-end: capability scope allows the URL, the Rust HTTP client
    // reaches the server, the response comes back without CORS preflight
    // blocking.
    //
    // We deliberately skip the UI-driven flow here because driving Nuxt
    // UI's combobox + reactive watchers from WebDriver is brittle in CI
    // (the watcher chain that turns customServerUrl → originUrl → fetch
    // doesn't always fire deterministically when the input value is set
    // via DOM mutation). The bug under regression is the FETCH PATH, not
    // the UI form, so we test what's actually load-bearing.
    //
    // We call invoke() directly rather than `import('@tauri-apps/plugin-
    // http')` because dynamic ES-module imports aren't resolvable in the
    // bundled production webview the test runs against (bare specifiers
    // are baked in at build time, not available to WebDriver-injected
    // scripts).
    const result = await vault.executeScript<{
      status: number;
      error: string | null;
    }>(`
      const url = ${JSON.stringify(syncServerUrl)} + '/identity-auth/requirements';
      try {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        const rid = await invoke('plugin:http|fetch', {
          clientConfig: {
            method: 'GET',
            url,
            headers: [],
            maxRedirections: 10,
          },
        });
        const response = await invoke('plugin:http|fetch_send', { rid });
        return { status: response.status, error: null };
      } catch (e) {
        return { status: 0, error: String(e && e.message ? e.message : e) };
      }
    `);

    // Pre-fix this would fail with a capability-denied error ("URL not
    // allowed by scope") because the e2e sync-server hostname isn't
    // under the original `*.haex.space` + localhost scope. Post-fix the
    // request lands and the server responds with HTTP 200 (or any
    // non-network status).
    expect(
      result.error,
      `plugin-http fetch to ${syncServerUrl} errored: ${result.error}`,
    ).toBeNull();
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(500);
  });

  // Why the previous test is meaningful: a plain `fetch()` from the Tauri
  // webview to the same URL is rejected by browser CORS. Capturing that here
  // proves the previous test isn't passing because CORS happened to be lax —
  // it's passing because the production code path routes through Rust
  // (tauri-plugin-http) instead of `window.fetch`.
  test("plain browser fetch is blocked by CORS (regression boundary)", async () => {
    // The plugin-http reachability is already proven by the previous
    // test, so we don't repeat the positive control here.

    // Now drive the actual regression check: a plain `fetch()` from the
    // webview must be blocked by the browser's CORS preflight. WebKit
    // raises a network-style exception ("Load failed", "NetworkError"),
    // Chromium returns the response as opaque + !ok — either way the
    // failure surface is one of a known set of CORS-blocked markers.
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

    expect(probe.ok).toBe(false);
    // Narrow the failure cause so the test can't pass on an unrelated
    // network error (DNS, server down, etc.). If probe.error is set we
    // expect a CORS-style marker; if probe.error is null then status
    // must be 0/opaque (some browsers return that for blocked requests
    // instead of throwing).
    if (probe.error !== null) {
      expect(probe.error).toMatch(
        /CORS|Failed to fetch|Load failed|NetworkError|Access-Control/i,
      );
    } else {
      expect(probe.status).toBe(0);
    }
  });

  // Vault A is shared across every suite in this workflow shard. Mirror the
  // beforeAll reset so the next suite starts from a clean slate — without
  // this the next test that hits Vault A's DB would get "Connection to vault
  // failed" if it doesn't call initializeVaultViaUI itself (cf. memory:
  // cross-vault-followup, e2e-prebuilt-binary-broken).
  test.afterAll(async () => {
    try { await vault.invokeTauriCommand("close_database", {}); } catch { /* best effort */ }
    try { await vault.navigateTo("/"); } catch { /* best effort */ }
  });
});
