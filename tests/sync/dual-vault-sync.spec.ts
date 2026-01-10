import { test, expect, VaultAutomation, VAULT_CONFIG, waitFor, SyncServerClient } from "../fixtures";
import WebSocket from "ws";
import * as http from "node:http";
import * as crypto from "node:crypto";

/**
 * E2E Tests for Dual-Vault Realtime Sync
 *
 * This test suite uses TWO separate Docker containers (vault-a and vault-b):
 * - Vault A: Primary instance on ports 3000, 19455, 4444
 * - Vault B: Secondary instance on ports 3001, 19456, 4445
 *
 * Both connect to the same sync server and we test:
 * 1. Changes in Vault A should appear in Vault B via realtime sync
 * 2. Changes in Vault B should appear in Vault A via realtime sync
 * 3. Conflict resolution when both change the same entry
 */

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || "http://localhost:3002";

interface SyncBackend {
  id: string;
  name: string;
  url: string;
}

interface DirtyTable {
  tableName: string;
  lastModified: string;
}

/**
 * Wait for a WebSocket bridge to be available
 */
async function waitForBridge(host: string, port: number, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ws = new WebSocket(`ws://${host}:${port}`);
      const connected = await new Promise<boolean>((resolve) => {
        ws.on("open", () => {
          ws.close();
          resolve(true);
        });
        ws.on("error", () => resolve(false));
        setTimeout(() => resolve(false), 2000);
      });
      if (connected) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Wait for tauri-driver to be available
 * Note: When using socat proxy, we need to override the Host header
 * IMPORTANT: Node.js fetch (undici) doesn't properly handle Host header overrides,
 * so we use the http module instead for cross-container requests.
 */
async function waitForTauriDriver(
  url: string,
  hostHeader?: string,
  timeout = 30000
): Promise<boolean> {
  const start = Date.now();
  const parsedUrl = new URL(url);

  while (Date.now() - start < timeout) {
    try {
      // Use http module instead of fetch because undici doesn't properly
      // handle Host header overrides (closes connection)
      const result = await new Promise<boolean>((resolve) => {
        const options: http.RequestOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: "/status",
          method: "GET",
          headers: hostHeader ? { Host: hostHeader } : undefined,
          timeout: 5000,
        };

        const req = http.request(options, (res) => {
          if (res.statusCode === 200) {
            res.resume(); // Consume response data to free up memory
            resolve(true);
          } else {
            resolve(false);
          }
        });

        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });

        req.end();
      });

      if (result) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Dual-vault tests require special infrastructure:
 *
 * 1. Both vault containers need socat proxy running:
 *    socat TCP-LISTEN:4446,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:4444
 *
 * 2. IMPORTANT: tauri-driver validates Host header, so all cross-container
 *    requests must include "Host: localhost:4444" header
 *
 * 3. Tests run from vault-a container and connect to:
 *    - vault-a: http://localhost:4444 (direct)
 *    - vault-b: http://vault-b:4446 (via socat proxy with Host header override)
 */
// Test credentials for sync server
const TEST_EMAIL = `e2e-test-${Date.now()}@test.local`;
const TEST_PASSWORD = "test-password-123";

test.describe("dual-vault-sync", () => {
  test.describe.configure({ mode: "serial", timeout: 180000 });

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let syncBackendIdA: string;
  let syncBackendIdB: string;
  let syncClient: SyncServerClient;
  let testVaultId: string;

  test.beforeAll(async () => {
    console.log("[DualVault] Setting up dual-vault test environment...");
    console.log("[DualVault] Vault A config:", VAULT_CONFIG.A);
    console.log("[DualVault] Vault B config:", VAULT_CONFIG.B);

    // Check both tauri-drivers are available
    // Need to pass Host header when using socat proxy
    const [driverAReady, driverBReady] = await Promise.all([
      waitForTauriDriver(
        VAULT_CONFIG.A.tauriDriverUrl,
        VAULT_CONFIG.A.needsHostOverride ? VAULT_CONFIG.A.tauriDriverHostHeader : undefined
      ),
      waitForTauriDriver(
        VAULT_CONFIG.B.tauriDriverUrl,
        VAULT_CONFIG.B.needsHostOverride ? VAULT_CONFIG.B.tauriDriverHostHeader : undefined
      ),
    ]);

    if (!driverAReady) {
      throw new Error(`Vault A tauri-driver not available at ${VAULT_CONFIG.A.tauriDriverUrl}`);
    }
    if (!driverBReady) {
      throw new Error(`Vault B tauri-driver not available at ${VAULT_CONFIG.B.tauriDriverUrl}`);
    }

    console.log("[DualVault] Both tauri-drivers are ready");
  });

  test.afterAll(async () => {
    // Clean up sessions
    if (vaultA) {
      await vaultA.deleteSession();
    }
    if (vaultB) {
      await vaultB.deleteSession();
    }
  });

  test("sync server should be reachable", async () => {
    const response = await fetch(SYNC_SERVER_URL).catch(() => null);
    console.log(`[DualVault] Sync server response: ${response?.status}`);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
  });

  test("should connect to Vault A", async () => {
    vaultA = new VaultAutomation("A");
    await vaultA.createSession();

    // Wait for WebSocket bridge
    const bridgeReady = await waitForBridge(VAULT_CONFIG.A.bridgeHost, VAULT_CONFIG.A.bridgePort);
    expect(bridgeReady).toBe(true);

    console.log(`[DualVault] Vault A connected`);
  });

  test("should connect to Vault B and initialize vault", async () => {
    vaultB = new VaultAutomation("B");
    await vaultB.createSession();

    // Note: We don't need to test the WebSocket bridge for Vault B because:
    // - The bridge is for browser extension communication (local only)
    // - Sync between vaults happens through the sync server, not direct WebSocket
    // - Each vault's bridge only needs to be accessible within its own container

    // Initialize a test vault on Vault B (similar to global-setup for Vault A)
    console.log(`[DualVault] Checking for existing vaults on Vault B...`);
    const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults");
    console.log(`[DualVault] Vault B existing vaults:`, vaults);

    const testVaultName = "e2e-test-vault";
    const existingVault = vaults.find((v) => v.name === testVaultName);

    if (existingVault) {
      console.log(`[DualVault] Opening existing vault on Vault B: ${existingVault.path}`);
      await vaultB.invokeTauriCommand("open_encrypted_database", {
        vaultPath: existingVault.path,
        key: "test-password-123",
      });
    } else {
      console.log(`[DualVault] Creating new test vault on Vault B...`);
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: testVaultName,
        key: "test-password-123",
        vaultId: null,
      });
    }

    console.log(`[DualVault] Vault B connected and initialized`);
  });

  test("Vault A WebSocket bridge should be running", async () => {
    // Only test Vault A bridge since tests run from vault-a container
    // The bridge is for browser extension communication (local only)
    const wsA = new WebSocket(`ws://${VAULT_CONFIG.A.bridgeHost}:${VAULT_CONFIG.A.bridgePort}`);
    const connectedA = await new Promise<boolean>((resolve) => {
      wsA.on("open", () => {
        wsA.close();
        resolve(true);
      });
      wsA.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });
    expect(connectedA).toBe(true);
  });

  test("should get dirty tables from Vault A", async () => {
    const dirtyTables = await vaultA.getDirtyTables();
    console.log("[DualVault] Vault A dirty tables:", dirtyTables);
    expect(Array.isArray(dirtyTables)).toBe(true);
  });

  test("should get dirty tables from Vault B", async () => {
    const dirtyTables = await vaultB.getDirtyTables();
    console.log("[DualVault] Vault B dirty tables:", dirtyTables);
    expect(Array.isArray(dirtyTables)).toBe(true);
  });

  // Note: remote_storage_add_backend only supports "s3" backend type
  // haex-sync-server integration requires a different API
  // Skip these tests until the sync API is clarified
  test.skip("should add sync backend to Vault A", async () => {
    // remote_storage_add_backend only supports "s3" backend type
    // haex-sync integration needs a different approach
  });

  test.skip("should add sync backend to Vault B", async () => {
    // remote_storage_add_backend only supports "s3" backend type
  });

  test("should list remote storage backends on both vaults", async () => {
    // This verifies the remote_storage API is accessible on both vaults
    const backendsA = await vaultA.invokeTauriCommand<SyncBackend[]>("remote_storage_list_backends");
    const backendsB = await vaultB.invokeTauriCommand<SyncBackend[]>("remote_storage_list_backends");

    console.log("[DualVault] Vault A backends:", backendsA);
    console.log("[DualVault] Vault B backends:", backendsB);

    // Initially both should have no backends (or existing ones from previous runs)
    expect(Array.isArray(backendsA)).toBe(true);
    expect(Array.isArray(backendsB)).toBe(true);
  });

  // ==========================================
  // Sync Server Configuration Tests
  // ==========================================

  test("should register test user on sync server", async () => {
    syncClient = new SyncServerClient(SYNC_SERVER_URL);

    console.log(`[DualVault] Registering test user: ${TEST_EMAIL}`);

    try {
      const result = await syncClient.register(TEST_EMAIL, TEST_PASSWORD);
      console.log("[DualVault] Registration successful:", result.user);
      expect(result.user.email).toBe(TEST_EMAIL);
    } catch (error) {
      // User might already exist from previous test run
      if ((error as Error).message.includes("already exists") ||
          (error as Error).message.includes("409")) {
        console.log("[DualVault] User already exists, logging in instead...");
      } else {
        throw error;
      }
    }

    // Login to get the auth token
    const loginResult = await syncClient.login(TEST_EMAIL, TEST_PASSWORD);
    console.log("[DualVault] Login successful, got auth token");
    expect(loginResult.access_token).toBeTruthy();
  });

  test("should get vault ID from Vault A", async () => {
    // Get the vault ID from Vault A's database
    const result = await vaultA.invokeTauriCommand<Array<{ key: string; value: string }>>(
      "sql_select",
      {
        sql: "SELECT key, value FROM haex_crdt_configs WHERE key = 'vault_id'",
        params: [],
      }
    );

    if (result && result.length > 0) {
      testVaultId = result[0].value;
    } else {
      // Generate a new vault ID if not found
      testVaultId = crypto.randomUUID();
    }

    console.log("[DualVault] Using vault ID:", testVaultId);
    expect(testVaultId).toBeTruthy();
  });

  test("should store vault key on sync server", async () => {
    // Generate dummy encrypted vault key data
    // In a real scenario, this would be encrypted with the user's password
    const encryptedVaultKey = crypto.randomBytes(32).toString("base64");
    const salt = crypto.randomBytes(16).toString("base64");
    const nonce = crypto.randomBytes(12).toString("base64");

    console.log("[DualVault] Storing vault key on sync server...");

    await syncClient.storeVaultKey({
      vaultId: testVaultId,
      encryptedVaultKey,
      salt,
      nonce,
      encryptedVaultName: Buffer.from("e2e-test-vault").toString("base64"),
    });

    console.log("[DualVault] Vault key stored successfully");
  });

  test("should configure sync backend in Vault A (local DB)", async () => {
    console.log("[DualVault] Configuring sync backend in Vault A...");

    syncBackendIdA = await vaultA.configureSyncBackend({
      serverUrl: SYNC_SERVER_URL,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      vaultId: testVaultId,
      name: "E2E Test Sync",
      enabled: true, // Now enabled - auth is configured
    });

    console.log("[DualVault] Vault A sync backend ID:", syncBackendIdA);
    expect(syncBackendIdA).toBeTruthy();

    // Verify the backend was created
    const backends = await vaultA.getSyncBackends();
    console.log("[DualVault] Vault A sync backends:", backends);
    expect(backends.some(b => b.id === syncBackendIdA)).toBe(true);
  });

  test("should configure sync backend in Vault B (local DB)", async () => {
    console.log("[DualVault] Configuring sync backend in Vault B...");

    // Use the same vault ID so both vaults sync to the same data
    syncBackendIdB = await vaultB.configureSyncBackend({
      serverUrl: SYNC_SERVER_URL,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      vaultId: testVaultId,
      name: "E2E Test Sync",
      enabled: true, // Now enabled - auth is configured
    });

    console.log("[DualVault] Vault B sync backend ID:", syncBackendIdB);
    expect(syncBackendIdB).toBeTruthy();

    // Verify the backend was created
    const backends = await vaultB.getSyncBackends();
    console.log("[DualVault] Vault B sync backends:", backends);
    expect(backends.some(b => b.id === syncBackendIdB)).toBe(true);
  });

  test("should have sync backends configured in both vaults", async () => {
    const backendsA = await vaultA.getSyncBackends();
    const backendsB = await vaultB.getSyncBackends();

    console.log("[DualVault] Final Vault A sync backends:", backendsA);
    console.log("[DualVault] Final Vault B sync backends:", backendsB);

    // Both vaults should have at least one sync backend
    expect(backendsA.length).toBeGreaterThan(0);
    expect(backendsB.length).toBeGreaterThan(0);

    // Both should point to the same sync server and vault
    const backendA = backendsA.find(b => b.id === syncBackendIdA);
    const backendB = backendsB.find(b => b.id === syncBackendIdB);

    expect(backendA?.serverUrl).toBe(SYNC_SERVER_URL);
    expect(backendB?.serverUrl).toBe(SYNC_SERVER_URL);
    expect(backendA?.vaultId).toBe(testVaultId);
    expect(backendB?.vaultId).toBe(testVaultId);
  });

  test("should get all CRDT tables from both vaults", async () => {
    const crdtTablesA = await vaultA.invokeTauriCommand<string[]>("get_all_crdt_tables");
    const crdtTablesB = await vaultB.invokeTauriCommand<string[]>("get_all_crdt_tables");

    console.log("[DualVault] Vault A CRDT tables:", crdtTablesA.length);
    console.log("[DualVault] Vault B CRDT tables:", crdtTablesB.length);

    expect(crdtTablesA.length).toBeGreaterThan(0);
    expect(crdtTablesB.length).toBeGreaterThan(0);
  });

  test("should verify both vaults have vault settings", async () => {
    // Query settings from both vaults to verify CRDT tables are working
    // Using haex_vault_settings which is a core table
    const settingsTableA = await vaultA.invokeTauriCommand<string[]>("get_all_crdt_tables");
    const settingsTableB = await vaultB.invokeTauriCommand<string[]>("get_all_crdt_tables");

    console.log(`[DualVault] Vault A has ${settingsTableA.length} CRDT tables`);
    console.log(`[DualVault] Vault B has ${settingsTableB.length} CRDT tables`);

    // Both should have the haex_vault_settings table
    expect(settingsTableA.some((t) => t.includes("haex_vault_settings"))).toBe(true);
    expect(settingsTableB.some((t) => t.includes("haex_vault_settings"))).toBe(true);
  });

  test.skip("should sync changes from Vault A to Vault B", async () => {
    // This test requires:
    // 1. Both vaults to be configured with the same sync user/vault
    // 2. Triggering push from Vault A
    // 3. Triggering pull from Vault B (or waiting for realtime)
    // 4. Verifying the change appeared in Vault B

    // Trigger sync push from Vault A
    await vaultA.invokeTauriCommand("trigger_sync_push");
    console.log("[DualVault] Triggered sync push from Vault A");

    // Wait a moment for sync
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Trigger sync pull from Vault B
    await vaultB.invokeTauriCommand("trigger_sync_pull");
    console.log("[DualVault] Triggered sync pull from Vault B");

    // Wait and verify
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get dirty tables from Vault B - they should now include synced changes
    const dirtyTablesB = await vaultB.getDirtyTables();
    console.log("[DualVault] Vault B dirty tables after pull:", dirtyTablesB);
  });

  test.skip("should sync changes from Vault B to Vault A", async () => {
    // Similar to above but in reverse direction
    // Insert in Vault B, verify in Vault A
  });

  test.skip("should handle concurrent changes (conflict resolution)", async () => {
    // Both vaults change the same key
    // After sync, both should have the same value (last-writer-wins based on HLC)
  });
});
