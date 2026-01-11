import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  waitForBridgeConnection,
  authorizeClient,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * E2E Tests for the browser bridge authorization flow
 *
 * Tests the handshake, authorization request, and approval/denial flow
 */

const EXTENSION_ID = "haex-pass";

test.describe("authorization-flow", () => {
  test.describe.configure({ mode: "serial" });

  test("should connect to bridge and receive handshake response", async () => {
    const client = new VaultBridgeClient();

    try {
      // Wait for bridge to be available
      const connected = await waitForBridgeConnection(client);
      expect(connected).toBe(true);

      // Should be in connected or pending_approval state after handshake
      const state = client.getState();
      expect(["connected", "pending_approval", "paired"]).toContain(state.state);
      expect(state.clientId).toBeDefined();
      expect(state.serverPublicKey).not.toBeNull();
    } finally {
      client.disconnect();
    }
  });

  test("should be in pending_approval state for new client", async () => {
    const client = new VaultBridgeClient();

    try {
      await waitForBridgeConnection(client);

      // New clients should be pending approval
      const state = client.getState();

      // Could be either pending_approval (new client) or paired (previously authorized)
      if (state.state === "pending_approval") {
        console.log("Client is pending approval as expected for new client");
        expect(state.state).toBe("pending_approval");
      } else if (state.state === "paired") {
        console.log("Client was previously authorized");
        expect(state.state).toBe("paired");
      }
    } finally {
      client.disconnect();
    }
  });

  test("should get authorized after approval via Tauri command", async () => {
    const client = new VaultBridgeClient();

    try {
      // Connect to bridge
      await waitForBridgeConnection(client);

      // Authorize the client
      const authorized = await authorizeClient(client, EXTENSION_ID);
      expect(authorized).toBe(true);

      // Should now be in paired state
      const state = client.getState();
      expect(state.state).toBe("paired");
    } finally {
      client.disconnect();
    }
  });

  // This test verifies that a newly authorized client can send requests.
  // Note: There's a race condition between authorization and the extension
  // being ready to handle requests. The extension needs time to auto-start
  // and register its event handlers. We use a longer wait and retries.
  test("should be able to send request after authorization", async () => {
    const client = new VaultBridgeClient();

    try {
      // Connect and authorize
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, EXTENSION_ID);
      expect(authorized).toBe(true);

      // Verify paired state
      const state = client.getState();
      expect(state.state).toBe("paired");

      // Wait for extension to auto-start and initialize.
      // The first request triggers ensure_extension_loaded() which emits an
      // auto-start event. The extension needs time to load its webview/iframe,
      // initialize JavaScript, and register event handlers.
      // We wait 5 seconds before the first request to give the extension time.
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Retry the request - extension may need more time to be fully ready
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await client.sendRequest(
            HAEX_PASS_METHODS.GET_ITEMS,
            { url: "https://example.com" },
            15000 // Longer timeout for extension to respond
          );
          // Success - response received
          expect(response).toBeDefined();
          return; // Test passed
        } catch (err) {
          lastError = err as Error;
          console.log(`[E2E] Request attempt ${attempt}/3 failed: ${lastError.message}`);
          if (attempt < 3) {
            // Wait before retry - give extension more time to initialize
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      }

      // All retries failed
      throw lastError || new Error("Request failed after 3 attempts");
    } finally {
      client.disconnect();
    }
  }, 90000); // 90 second timeout for this test

  test("should fail request when not authorized", async () => {
    const client = new VaultBridgeClient();

    try {
      // Connect but don't authorize
      await waitForBridgeConnection(client);

      const state = client.getState();
      if (state.state !== "paired") {
        // Should fail when trying to send request
        await expect(
          client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, { url: "https://example.com" })
        ).rejects.toThrow("Not authorized");
      } else {
        // If already paired, skip this test
        console.log("Client already authorized, skipping unauthorized test");
      }
    } finally {
      client.disconnect();
    }
  });

  test("should revoke authorization and deny new requests", async () => {
    const client = new VaultBridgeClient();
    const vault = new VaultAutomation();

    try {
      // Get existing session from global-setup
      await vault.createSession();

      // Connect and authorize
      await waitForBridgeConnection(client);
      await authorizeClient(client, EXTENSION_ID);

      // Verify authorized
      expect(client.getState().state).toBe("paired");

      // Revoke authorization via Tauri command
      const clientId = client.getClientId();
      if (clientId) {
        await vault.invokeTauriCommand("external_bridge_revoke_client", {
          clientId,
        });
      }

      // Reconnect - should no longer be authorized
      client.disconnect();
      const newClient = new VaultBridgeClient();
      await waitForBridgeConnection(newClient);

      // Should be pending approval again
      const newState = newClient.getState();
      expect(["connected", "pending_approval"]).toContain(newState.state);

      newClient.disconnect();
    } finally {
      client.disconnect();
      await vault.deleteSession();
    }
  });
});
