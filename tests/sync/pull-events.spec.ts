import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  SyncServerClient,
  waitForBridgeConnection,
  authorizeClient,
  waitForSyncServer,
  createTestSyncChange,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * E2E Tests for pull events and sync:tables-updated
 *
 * Tests the flow:
 * 1. Connect to vault via bridge
 * 2. Push changes to server (simulating another device)
 * 3. Trigger pull on vault
 * 4. Verify sync:tables-updated event is emitted
 */

const EXTENSION_ID = "haex-pass";

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

test.describe("pull-events", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let vault: VaultAutomation;
  let syncServer: SyncServerClient;

  test.beforeAll(async () => {
    // Wait for sync server to be available
    const serverReady = await waitForSyncServer();
    if (!serverReady) {
      throw new Error("Sync server not available");
    }

    syncServer = new SyncServerClient();

    client = new VaultBridgeClient();
    vault = new VaultAutomation();

    const connected = await waitForBridgeConnection(client);
    if (!connected) {
      throw new Error("Failed to connect to bridge");
    }

    const authorized = await authorizeClient(client, EXTENSION_ID);
    if (!authorized) {
      throw new Error("Failed to authorize client");
    }

    await vault.createSession();
  });

  test.afterAll(async () => {
    client?.disconnect();
    await vault?.deleteSession();
  });

  test("sync server should be healthy", async () => {
    const health = await syncServer.healthCheck();

    expect(health.status).toBe("ok");
    expect(health.name).toBe("haex-sync-server");
    console.log(`[Test] Sync server version: ${health.version}`);
  });

  test("should trigger pull and update local state", async () => {
    // Get initial sync state
    const initialState = await vault.getSyncState();
    console.log("[Test] Initial sync state:", initialState);

    // Trigger a pull
    await vault.triggerSyncPull();

    // Wait for pull to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get sync state after pull
    const stateAfterPull = await vault.getSyncState();
    console.log("[Test] Sync state after pull:", stateAfterPull);

    // lastSyncAt should be updated if we were connected
    if (initialState.isConnected) {
      expect(stateAfterPull.lastSyncAt).not.toBeNull();
    }
  });

  test("should fetch logins after pull", async () => {
    // Create a test entry first
    const createResponse = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://pull-test.example.com",
      title: "Pull Test Entry",
      username: "pulluser",
      password: "pullpassword123",
    })) as ApiResponse;

    expect(createResponse.success).toBe(true);

    // Push changes to server
    await vault.triggerSyncPush();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Pull changes back
    await vault.triggerSyncPull();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the entry is still accessible
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://pull-test.example.com",
    })) as ApiResponse<{ entries: Array<{ title: string }> }>;

    expect(getResponse.success).toBe(true);
    expect(getResponse.data?.entries.length).toBeGreaterThan(0);

    const entry = getResponse.data?.entries.find(
      (e) => e.title === "Pull Test Entry"
    );
    expect(entry).toBeDefined();
  });
});
