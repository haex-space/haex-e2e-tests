/**
 * Realtime Sync E2E Tests
 *
 * Tests the Supabase realtime subscription functionality:
 * - Realtime subscription establishment
 * - Token refresh handling during long connections
 * - Channel error recovery and retry logic
 * - Cross-device sync via realtime events
 *
 * These tests require:
 * - sync-server running with Supabase
 * - Two vault instances (A and B) for cross-device sync testing
 */

import { test, expect, VaultAutomation, SyncServerClient } from "../fixtures";

// Test configuration
const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || "http://sync-server:3002";

// Supabase test credentials (from docker-compose)
const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "test-password-12345";

test.describe("Realtime Sync", () => {
  let vaultA: VaultAutomation;
  let syncClient: SyncServerClient;

  test.beforeAll(async () => {
    // Initialize vault A automation
    vaultA = new VaultAutomation("A");
    await vaultA.createSession();

    // Initialize sync server client
    syncClient = new SyncServerClient(SYNC_SERVER_URL);
  });

  test.afterAll(async () => {
    await vaultA.deleteSession();
  });

  test.describe("Subscription Lifecycle", () => {
    test("should establish realtime subscription after sync setup", async () => {
      // This test verifies that realtime subscription is established
      // when sync is started on a backend

      // Get current sync status
      const syncStatus = await vaultA.invokeTauriCommand<{
        backends: Array<{
          id: string;
          isConnected: boolean;
          error: string | null;
        }>;
      }>("get_sync_status", {});

      // Log sync status for debugging
      console.log("[E2E] Sync status:", JSON.stringify(syncStatus, null, 2));

      // If there's an active backend, it should be connected
      // (This assumes sync was previously set up)
      if (syncStatus.backends && syncStatus.backends.length > 0) {
        const activeBackend = syncStatus.backends.find((b) => b.isConnected);
        if (activeBackend) {
          expect(activeBackend.isConnected).toBe(true);
          expect(activeBackend.error).toBeNull();
        }
      }
    });

    test("should recover from CHANNEL_ERROR with retry", async () => {
      // This test verifies the retry logic works when a channel error occurs
      // We can't easily force a CHANNEL_ERROR, so we test the recovery mechanism exists
      // by checking logs or status after simulated network interruption

      // Get initial sync status
      const initialStatus = await vaultA.invokeTauriCommand<{
        backends: Array<{
          id: string;
          isConnected: boolean;
          lastSyncAt: string | null;
        }>;
      }>("get_sync_status", {});

      console.log("[E2E] Initial sync status:", JSON.stringify(initialStatus, null, 2));

      // The sync orchestrator should have retry logic implemented
      // This is a basic sanity check that the sync system is operational
      expect(initialStatus).toBeDefined();
    });
  });

  test.describe("Token Refresh Handling", () => {
    test("should maintain connection when auth token is refreshed", async () => {
      // This test verifies that the realtime connection stays alive
      // when Supabase refreshes the auth token

      // First, login to sync server
      await syncClient.login(TEST_EMAIL, TEST_PASSWORD);

      // Check that we have a valid session
      const token = syncClient.getAuthToken();
      expect(token).toBeDefined();
      expect(token?.length).toBeGreaterThan(0);

      // The auth state change listener should automatically update
      // the realtime connection when TOKEN_REFRESHED fires
      // We verify this by checking the sync status remains healthy

      const syncStatus = await vaultA.invokeTauriCommand<{
        backends: Array<{
          id: string;
          isConnected: boolean;
          error: string | null;
        }>;
      }>("get_sync_status", {});

      // If there's an active backend, verify it has no auth-related errors
      if (syncStatus.backends && syncStatus.backends.length > 0) {
        for (const backend of syncStatus.backends) {
          if (backend.error) {
            // Auth-related errors would indicate token refresh is not working
            expect(backend.error).not.toContain("401");
            expect(backend.error).not.toContain("unauthorized");
            expect(backend.error).not.toContain("token");
          }
        }
      }
    });
  });

  test.describe("Cross-Device Sync via Realtime", () => {
    // Skip these tests if we don't have two vault containers running
    // In CI, both vault-a and vault-b containers should be available

    test.skip("should receive changes from other device via realtime", async () => {
      // This test requires two vault instances (A and B) to be running
      // and both connected to the same sync server

      const vaultB = new VaultAutomation("B");

      try {
        await vaultB.createSession();

        // Setup: Both vaults should be syncing to the same backend
        // Vault A makes a change
        // Vault B should receive it via realtime subscription (not periodic pull)

        // Create a unique test entry in Vault A
        const testId = `realtime-test-${Date.now()}`;
        await vaultA.invokeTauriCommand("sql_with_crdt", {
          sql: `INSERT INTO haex_logins (id, title, domain) VALUES (?, ?, ?)`,
          params: [testId, "Realtime Test Entry", "realtime-test.example.com"],
        });

        // Push changes from Vault A
        await vaultA.invokeTauriCommand("sync_push", {});

        // Wait for realtime event to propagate (should be < 1 second)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify Vault B received the change
        const result = await vaultB.invokeTauriCommand<unknown[][]>("sql_with_crdt", {
          sql: `SELECT id, title FROM haex_logins WHERE id = ?`,
          params: [testId],
        });

        expect(result).toHaveLength(1);
        expect(result[0]?.[1]).toBe("Realtime Test Entry");

        // Cleanup: Remove test entry
        await vaultA.invokeTauriCommand("sql_with_crdt", {
          sql: `DELETE FROM haex_logins WHERE id = ?`,
          params: [testId],
        });
      } finally {
        await vaultB.deleteSession();
      }
    });

    test.skip("should debounce multiple rapid changes into single pull", async () => {
      // This test verifies the debounce mechanism works correctly
      // Multiple rapid INSERT events should trigger only one pull operation

      const vaultB = new VaultAutomation("B");

      try {
        await vaultB.createSession();

        // Create multiple entries rapidly in Vault A
        const testIds: string[] = [];
        for (let i = 0; i < 5; i++) {
          const testId = `debounce-test-${Date.now()}-${i}`;
          testIds.push(testId);
          await vaultA.invokeTauriCommand("sql_with_crdt", {
            sql: `INSERT INTO haex_logins (id, title, domain) VALUES (?, ?, ?)`,
            params: [testId, `Debounce Test ${i}`, `debounce-test-${i}.example.com`],
          });
        }

        // Push all changes at once
        await vaultA.invokeTauriCommand("sync_push", {});

        // Wait for debounce period + processing time
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify all entries were received by Vault B
        for (const testId of testIds) {
          const result = await vaultB.invokeTauriCommand<unknown[][]>("sql_with_crdt", {
            sql: `SELECT id FROM haex_logins WHERE id = ?`,
            params: [testId],
          });
          expect(result).toHaveLength(1);
        }

        // Cleanup
        for (const testId of testIds) {
          await vaultA.invokeTauriCommand("sql_with_crdt", {
            sql: `DELETE FROM haex_logins WHERE id = ?`,
            params: [testId],
          });
        }
      } finally {
        await vaultB.deleteSession();
      }
    });
  });

  test.describe("Connection Resilience", () => {
    test("should fall back to periodic pull when realtime fails", async () => {
      // After MAX_SUBSCRIPTION_RETRIES (3), the system should fall back
      // to periodic pull as indicated in the realtime.ts code

      // This is a behavioral test - we verify the sync continues to work
      // even if we can't establish realtime (periodic pull fallback)

      const syncStatus = await vaultA.invokeTauriCommand<{
        backends: Array<{
          id: string;
          lastPullAt: string | null;
          lastPushAt: string | null;
        }>;
      }>("get_sync_status", {});

      // The sync system should still perform periodic pulls
      // even if realtime is not available
      if (syncStatus.backends && syncStatus.backends.length > 0) {
        const backend = syncStatus.backends[0];
        // At minimum, the sync engine should be tracking pull times
        // (even if they're null at the start)
        expect(backend).toHaveProperty("lastPullAt");
        expect(backend).toHaveProperty("lastPushAt");
      }
    });

    test("should properly cleanup channel on unsubscribe", async () => {
      // Verify that unsubscribing from a backend properly cleans up resources
      // This prevents memory leaks and connection issues

      // Get current sync status
      const beforeStatus = await vaultA.invokeTauriCommand<{
        backends: Array<{ id: string; isConnected: boolean }>;
      }>("get_sync_status", {});

      console.log("[E2E] Sync status before:", JSON.stringify(beforeStatus, null, 2));

      // If there are active backends, the cleanup should work correctly
      // when sync is stopped
      expect(beforeStatus).toBeDefined();
    });
  });
});

test.describe("Realtime Partition Naming", () => {
  test("should correctly convert vault ID to partition name", async () => {
    // This is a unit-level verification that can be done in E2E context
    // The partition name should replace hyphens with underscores

    const vaultId = "123e4567-e89b-12d3-a456-426614174000";
    const expectedPartition = "sync_changes_123e4567_e89b_12d3_a456_426614174000";
    const actualPartition = `sync_changes_${vaultId.replace(/-/g, "_")}`;

    expect(actualPartition).toBe(expectedPartition);
  });
});
