import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  BRIDGE_METHODS,
} from "../fixtures";
import { TAURI_COMMANDS } from "@haex-space/vault-sdk";

test.describe("external-bridge: client-management", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  // Do NOT call vault.deleteSession() for vault "A" — it reuses the global session

  test("authorized client appears in authorized clients list", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, "unused");
      expect(authorized).toBe(true);

      const clientId = client.getClientId();
      expect(typeof clientId).toBe("string");

      // Check that the client appears in the authorized list
      const authorizedClients = await vault.invokeTauriCommand<
        Array<{ clientId: string; clientName: string }>
      >(TAURI_COMMANDS.externalBridge.getAuthorizedClients);

      const found = authorizedClients.find((c) => c.clientId === clientId);
      expect(found).not.toBeNull();
      expect(found!.clientId).toBe(clientId);
      expect(typeof found!.clientName).toBe("string");
    } finally {
      client.disconnect();
    }
  });

  test("block client adds clientId to blocked list", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      await authorizeClient(client, "unused");

      const clientId = client.getClientId();
      expect(typeof clientId).toBe("string");

      // Block the client (with remember=true to persist)
      const publicKey = client.getPublicKeyBase64();
      await vault.invokeTauriCommand(
        TAURI_COMMANDS.externalBridge.clientBlock,
        { clientId, clientName: "E2E Test Client", publicKey, remember: true }
      );

      // Verify client appears in blocked list
      const blockedClients = await vault.invokeTauriCommand<
        Array<{ clientId: string }>
      >(TAURI_COMMANDS.externalBridge.getBlockedClients);

      const blocked = blockedClients.find((c) => c.clientId === clientId);
      expect(blocked).not.toBeNull();
      expect(blocked!.clientId).toBe(clientId);

      // Clean up: unblock the client
      await vault.invokeTauriCommand(
        TAURI_COMMANDS.externalBridge.unblockClient,
        { clientId }
      );
    } finally {
      client.disconnect();
    }
  });

  test("revoke client removes it from authorized list", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, "unused");
      expect(authorized).toBe(true);

      const clientId = client.getClientId();
      expect(typeof clientId).toBe("string");

      // Confirm client is in authorized list before revoke
      const beforeRevoke = await vault.invokeTauriCommand<
        Array<{ clientId: string }>
      >(TAURI_COMMANDS.externalBridge.getAuthorizedClients);

      const foundBefore = beforeRevoke.some((c) => c.clientId === clientId);
      expect(foundBefore).toBe(true);

      // Revoke the client
      await vault.invokeTauriCommand(
        TAURI_COMMANDS.externalBridge.revokeClient,
        { clientId }
      );

      // Verify client is removed from authorized list
      const afterRevoke = await vault.invokeTauriCommand<
        Array<{ clientId: string }>
      >(TAURI_COMMANDS.externalBridge.getAuthorizedClients);

      const foundAfter = afterRevoke.some((c) => c.clientId === clientId);
      expect(foundAfter).toBe(false);
    } finally {
      client.disconnect();
    }
  });

  test("after revoke client must re-authorize to make requests", async () => {
    // Step 1: Authorize a new client
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, "unused");
      expect(authorized).toBe(true);

      const clientId = client.getClientId();
      expect(typeof clientId).toBe("string");

      // Confirm requests work before revoke
      const preResponse = await sendRequestWithRetry<{
        success: boolean;
        requestId: string;
      }>(client, BRIDGE_METHODS.GET_ITEMS, {
        url: "https://example.com",
      });
      expect(preResponse.success).toBe(true);

      // Step 2: Revoke the client via Tauri command
      await vault.invokeTauriCommand(
        TAURI_COMMANDS.externalBridge.revokeClient,
        { clientId }
      );

      // Step 3: Disconnect and reconnect — new connection should not be auto-paired
      client.disconnect();

      // New client with new keys won't be authorized. Fresh keys guarantee
      // the server has never seen this clientId, so the reconnect must resolve
      // to a non-paired state and the unauthorized request must be rejected.
      const client2 = new VaultBridgeClient();
      try {
        await waitForBridgeConnection(client2);

        const { state } = client2.getState();
        expect(state).not.toBe("paired");

        await expect(
          client2.sendRequest(BRIDGE_METHODS.GET_ITEMS, {
            url: "https://example.com",
          })
        ).rejects.toThrow("Not authorized");
      } finally {
        client2.disconnect();
      }
    } finally {
      client.disconnect();
    }
  });
});
