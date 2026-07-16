import { test, expect, VaultAutomation } from "../fixtures";

/**
 * Real browser-extension integration test.
 *
 * Loads the actual `haex-pass-browser` extension in a headed Chromium context
 * and verifies it pairs with **haex-vault core** (not an extension). The
 * extension's background service worker auto-connects to the vault bridge
 * (`ws://localhost:<port>`) on startup and requests access to core via the
 * `__core__` / `core` sentinel (see haex-pass-browser/src/background/
 * connection.ts). We approve the pending client from the vault side and assert
 * it becomes an authorized client — proving the browser-extension → core flow
 * end-to-end through a real browser, not the WebSocket simulator used by the
 * tests/external-bridge specs.
 */
// Identity the haex-pass-browser background worker reports when it connects:
// see haextension apps/haex-pass-browser/src/background/connection.ts
// (`const CLIENT_NAME = 'haex-pass Browser Extension'`, sent as `clientName`).
// We match the pending authorization on this so the test validates THIS client,
// not whatever else might happen to be pending in the shared session.
const BROWSER_CLIENT_NAME = "haex-pass Browser Extension";

test.describe("browser-extension: pairing with haex-vault core", () => {
  test.describe.configure({ mode: "serial" });

  test("haex-pass-browser connects and pairs against __core__", async ({
    extensionId,
  }) => {
    // A non-empty extensionId means the background service worker booted, which
    // is what triggers the auto-connect to the vault bridge.
    expect(extensionId).toBeTruthy();

    const vault = new VaultAutomation("A");
    await vault.createSession();
    try {
      // Wait for the extension's client to show up as a pending authorization.
      let pending: Awaited<
        ReturnType<VaultAutomation["getPendingAuthorizations"]>
      >[number] | undefined;
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const list = await vault.getPendingAuthorizations();
        // Pick the specific haex-pass-browser client by its reported clientName,
        // not list[0] — the shared session may carry other pending clients.
        const match = list.find((p) => p.clientName === BROWSER_CLIENT_NAME);
        if (match) {
          pending = match;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      expect(
        pending,
        `haex-pass-browser ("${BROWSER_CLIENT_NAME}") should appear in the vault's pending authorizations`,
      ).toBeTruthy();
      expect(pending!.clientName).toBe(BROWSER_CLIENT_NAME);

      // Approve the real browser client for haex-vault core (__core__).
      await vault.approveClient(
        pending!.clientId,
        pending!.clientName,
        pending!.publicKey,
        ["__core__"],
      );

      // It must now be a persisted authorized client.
      const authorized = await vault.getAuthorizedClients();
      expect(authorized.some((c) => c.clientId === pending!.clientId)).toBe(
        true,
      );
    } finally {
      await vault.deleteSession();
    }
  });
});
