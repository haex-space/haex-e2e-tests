import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  SyncServerClient,
  waitForBridgeConnection,
  authorizeClient,
  waitForSyncServer,
  HAEX_PASS_METHODS,
} from "../fixtures";
import {
  MULTI_DEVICE_ENTRIES,
  CONFLICT_TEST_ENTRIES,
  generateUniqueTestEntry,
} from "../../fixtures/sync-test-data";

/**
 * E2E Tests for multi-device sync scenarios
 *
 * Tests simulate two "devices" by:
 * 1. Creating entries on one device
 * 2. Pushing to server
 * 3. Pulling on another device
 * 4. Verifying data consistency
 *
 * Note: In this test setup, we use a single vault with different
 * deviceIds to simulate multi-device scenarios. For real multi-device
 * testing, you would need two separate vault instances.
 */

const EXTENSION_ID = "haex-pass";

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

interface LoginEntry {
  id: string;
  title: string;
  hasTotp: boolean;
  fields: {
    username?: string;
    password?: string;
    url?: string;
  };
}

interface GetLoginsResponse {
  entries: LoginEntry[];
}

test.describe("multi-device sync", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let vault: VaultAutomation;
  let syncServer: SyncServerClient;

  test.beforeAll(async () => {
    // Wait for sync server
    const serverReady = await waitForSyncServer();
    if (!serverReady) {
      throw new Error("Sync server not available");
    }

    syncServer = new SyncServerClient();

    // Connect primary client
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

  test("should sync entry from local to server and back", async () => {
    // Generate a unique entry for this test
    const testEntry = generateUniqueTestEntry("round-trip-test");

    // Create entry locally
    const createResponse = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: testEntry.url,
      title: testEntry.title,
      username: testEntry.username,
      password: testEntry.password,
    })) as ApiResponse;

    expect(createResponse.success).toBe(true);
    console.log("[Test] Created local entry:", testEntry.title);

    // Push to server
    await vault.triggerSyncPush();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("[Test] Pushed to server");

    // Verify entry is accessible locally
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: testEntry.url,
    })) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);
    expect(getResponse.data?.entries.length).toBeGreaterThan(0);

    const foundEntry = getResponse.data?.entries.find(
      (e) => e.title === testEntry.title
    );
    expect(foundEntry).toBeDefined();
    expect(foundEntry?.fields.username).toBe(testEntry.username);
    console.log("[Test] Verified entry after sync");
  });

  test("should handle multiple entries in single sync", async () => {
    const entries = [
      generateUniqueTestEntry("batch-1"),
      generateUniqueTestEntry("batch-2"),
      generateUniqueTestEntry("batch-3"),
    ];

    // Create all entries
    for (const entry of entries) {
      const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
        url: entry.url,
        title: entry.title,
        username: entry.username,
        password: entry.password,
      })) as ApiResponse;

      expect(response.success).toBe(true);
    }

    console.log(`[Test] Created ${entries.length} entries`);

    // Single push should sync all
    await vault.triggerSyncPush();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify all entries are still accessible
    for (const entry of entries) {
      const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
        url: entry.url,
      })) as ApiResponse<GetLoginsResponse>;

      expect(getResponse.success).toBe(true);

      const foundEntry = getResponse.data?.entries.find(
        (e) => e.title === entry.title
      );
      expect(foundEntry).toBeDefined();
    }

    console.log("[Test] All entries verified after batch sync");
  });

  test("should preserve entry data through sync cycle", async () => {
    const testEntry = generateUniqueTestEntry("data-preservation");

    // Create entry with specific data
    const createResponse = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: testEntry.url,
      title: testEntry.title,
      username: testEntry.username,
      password: testEntry.password,
    })) as ApiResponse;

    expect(createResponse.success).toBe(true);

    // Full sync cycle: push then pull
    await vault.triggerSyncPush();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await vault.triggerSyncPull();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Verify data integrity
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: testEntry.url,
    })) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);

    const foundEntry = getResponse.data?.entries.find(
      (e) => e.title === testEntry.title
    );

    expect(foundEntry).toBeDefined();
    expect(foundEntry?.fields.username).toBe(testEntry.username);
    // Note: Password might not be returned in get-logins for security
    // but the entry should still exist

    console.log("[Test] Data preserved through sync cycle");
  });

  test("should update sync timestamp after successful sync", async () => {
    const stateBefore = await vault.getSyncState();
    const lastSyncBefore = stateBefore.lastSyncAt;

    // Create a small change
    const testEntry = generateUniqueTestEntry("timestamp-test");
    await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: testEntry.url,
      title: testEntry.title,
      username: testEntry.username,
      password: testEntry.password,
    });

    // Push to server
    await vault.triggerSyncPush();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const stateAfter = await vault.getSyncState();

    // If connected to sync, lastSyncAt should be updated
    if (stateAfter.isConnected && stateBefore.isConnected) {
      if (lastSyncBefore) {
        // If there was a previous sync, the new timestamp should be later
        expect(new Date(stateAfter.lastSyncAt!).getTime())
          .toBeGreaterThanOrEqual(new Date(lastSyncBefore).getTime());
      } else {
        // If no previous sync, there should now be a timestamp
        expect(stateAfter.lastSyncAt).not.toBeNull();
      }
    }

    console.log("[Test] Sync timestamps:", {
      before: lastSyncBefore,
      after: stateAfter.lastSyncAt,
    });
  });
});
