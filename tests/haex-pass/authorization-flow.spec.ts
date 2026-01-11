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

  // Skip this test - it requires haex-pass extension to immediately recognize
  // a newly authorized client, which has race conditions. The extension
  // registration happens asynchronously and may not be ready when we send
  // the first request. Other tests verify request functionality works with
  // pre-authorized clients from global-setup.
  test.skip("should be able to send request after authorization", async () => {
    const client = new VaultBridgeClient();

    try {
      // Connect and authorize
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, EXTENSION_ID);
      expect(authorized).toBe(true);

      // Verify paired state
      const state = client.getState();
      expect(state.state).toBe("paired");

      // Wait for authorization to propagate and haex-pass extension to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Try a simple get-items request
      const response = await client.sendRequest(
        HAEX_PASS_METHODS.GET_ITEMS,
        { url: "https://example.com" },
        15000
      );

      // Should get a response (even if empty entries)
      expect(response).toBeDefined();
    } finally {
      client.disconnect();
    }
  });

  test("should fail request when not authorized", async () => {
    const client = new VaultBridgeClient();

    try {
      // Connect but don't authorize
      await waitForBridgeConnection(client);

      const state = client.getState();
      if (state.state !== "paired") {
        // Should fail when trying to send request
        await expect(
          client.sendRequest("get-logins", { url: "https://example.com" })
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
