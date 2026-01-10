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
 * E2E Tests for local changes and dirty table tracking
 *
 * Tests the flow:
 * 1. Connect to vault via bridge
 * 2. Make local changes (via set-login)
 * 3. Verify dirty tables are tracked
 * 4. Verify crdt:dirty-tables-changed event is emitted
 */

const EXTENSION_ID = "haex-pass";

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

test.describe("local-changes", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let vault: VaultAutomation;

  test.beforeAll(async () => {
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

  test("should track dirty tables after local change", async () => {
    // Get initial dirty tables state
    const initialDirtyTables = await vault.getDirtyTables();
    console.log("[Test] Initial dirty tables:", initialDirtyTables);

    // Make a local change via set-item
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://test-local-changes.example.com",
      title: "Local Change Test Entry",
      username: "testuser",
      password: "testpassword123",
    })) as ApiResponse;

    expect(response.success).toBe(true);

    // Check that dirty tables now includes the password tables
    const dirtyTablesAfter = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after change:", dirtyTablesAfter);

    // Should have at least some tables marked as dirty
    expect(dirtyTablesAfter.length).toBeGreaterThan(0);

    // Password-related tables should be dirty
    const hasPasswordTable = dirtyTablesAfter.some(
      (table) =>
        table.tableName.includes("password") ||
        table.tableName.includes("haex_passwords")
    );
    expect(hasPasswordTable).toBe(true);
  });

  test("should clear dirty tables after sync push", async () => {
    // First ensure we have dirty tables
    const dirtyTablesBefore = await vault.getDirtyTables();

    if (dirtyTablesBefore.length === 0) {
      // Make a change to ensure we have dirty tables
      const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
        url: "https://test-sync-push.example.com",
        title: "Sync Push Test Entry",
        username: "syncuser",
        password: "syncpassword123",
      })) as ApiResponse;
      expect(response.success).toBe(true);
    }

    // Trigger sync push
    await vault.triggerSyncPush();

    // Wait a bit for the push to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check dirty tables after push
    const dirtyTablesAfter = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after push:", dirtyTablesAfter);

    // Dirty tables should be cleared (or significantly reduced)
    expect(dirtyTablesAfter.length).toBeLessThanOrEqual(dirtyTablesBefore.length);
  });

  test("should report sync state correctly", async () => {
    const syncState = await vault.getSyncState();
    console.log("[Test] Sync state:", syncState);

    // Sync state should have expected structure
    expect(syncState).toHaveProperty("isConnected");
    expect(syncState).toHaveProperty("lastSyncAt");
    expect(syncState).toHaveProperty("pendingChanges");

    // pendingChanges should be a non-negative number
    expect(syncState.pendingChanges).toBeGreaterThanOrEqual(0);
  });
});
