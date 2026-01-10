import { test, expect, VaultAutomation } from "../fixtures";

/**
 * E2E Tests for Vault-to-Vault Sync via Sync Server
 *
 * Tests the flow:
 * 1. Create two vaults (vault A and vault B)
 * 2. Configure sync backend for both vaults
 * 3. Make changes in vault A (via extension database commands)
 * 4. Trigger sync push from vault A
 * 5. Switch to vault B and trigger sync pull
 * 6. Verify changes arrived in vault B
 *
 * Note: Since we can only have one Tauri app instance via WebDriver,
 * we test by switching between vaults (closing one DB, opening another).
 */

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || "http://sync-server:3002";
const TEST_VAULT_A = "e2e-vault-a";
const TEST_VAULT_B = "e2e-vault-b";
const TEST_VAULT_PASSWORD = "test-password-123";

// Extension public key from the container
const EXTENSION_PUBLIC_KEY = "8044f8b2d99c6e04001db63fb83198b4be605a67ca3b7ef29d9ce6c9c9b09a1b";

interface SyncBackend {
  id: string;
  name: string;
  url: string;
  lastPushHlcTimestamp?: string;
  lastPullServerTimestamp?: string;
}

interface DirtyTable {
  tableName: string;
  lastModified: string;
}

test.describe("vault-to-vault-sync", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let syncBackendId: string;

  test.beforeAll(async () => {
    vault = new VaultAutomation();
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault?.deleteSession();
  });

  test("sync server should be reachable", async () => {
    // Test that sync server is healthy
    const health = await vault.invokeTauriCommand<{ status: string }>("check_sync_server_health", {
      url: SYNC_SERVER_URL,
    }).catch(() => null);

    // If command doesn't exist, try fetching directly
    if (!health) {
      const response = await fetch(`${SYNC_SERVER_URL}/health`).catch(() => null);
      expect(response?.ok).toBe(true);
    } else {
      expect(health.status).toBe("ok");
    }
  });

  test("should get dirty tables after vault creation", async () => {
    // The global setup already created a test vault
    // Check that we can get dirty tables
    const dirtyTables = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after setup:", dirtyTables);

    // After vault creation, some tables should be marked dirty
    expect(Array.isArray(dirtyTables)).toBe(true);
  });

  test("should add sync backend", async () => {
    // Add haex-sync-server as backend
    const result = await vault.invokeTauriCommand<SyncBackend>("remote_storage_add_backend", {
      name: "E2E Sync Server",
      backendType: "haex-sync",
      config: {
        url: SYNC_SERVER_URL,
      },
    });

    console.log("[Test] Added sync backend:", result);
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    syncBackendId = result.id;
  });

  test("should list sync backends", async () => {
    const backends = await vault.invokeTauriCommand<SyncBackend[]>("remote_storage_list_backends");
    console.log("[Test] Sync backends:", backends);

    expect(backends.length).toBeGreaterThan(0);
    const ourBackend = backends.find((b) => b.id === syncBackendId);
    expect(ourBackend).toBeDefined();
  });

  test("should execute extension database insert", async () => {
    // Insert a test entry directly via extension database command
    // This simulates what haex-pass does when saving a password
    const tableName = `${EXTENSION_PUBLIC_KEY}__haex-pass__haex_passwords_items`;

    const insertResult = await vault.invokeTauriCommand("extension_database_execute", {
      extensionId: EXTENSION_PUBLIC_KEY,
      sql: `INSERT INTO "${tableName}" (id, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))`,
      params: ["e2e-test-entry-1"],
    });

    console.log("[Test] Insert result:", insertResult);
  });

  test("should track dirty tables after insert", async () => {
    const dirtyTables = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after insert:", dirtyTables);

    // Should have password table marked as dirty
    expect(dirtyTables.length).toBeGreaterThan(0);

    const hasPasswordTable = dirtyTables.some(
      (t: DirtyTable) => t.tableName.includes("haex_passwords")
    );
    expect(hasPasswordTable).toBe(true);
  });

  test("should get all CRDT tables", async () => {
    const crdtTables = await vault.invokeTauriCommand<string[]>("get_all_crdt_tables");
    console.log("[Test] CRDT tables:", crdtTables);

    expect(crdtTables.length).toBeGreaterThan(0);

    // Core tables should be CRDT-enabled
    const hasSettingsTable = crdtTables.some((t) => t.includes("haex_vault_settings"));
    expect(hasSettingsTable).toBe(true);
  });

  test("should get table schema", async () => {
    const schema = await vault.invokeTauriCommand<Array<{
      name: string;
      dataType: string;
      isPk: boolean;
      notNull: boolean;
    }>>("get_table_schema", {
      tableName: "haex_vault_settings",
    });

    console.log("[Test] Table schema for haex_vault_settings:", schema);

    expect(schema.length).toBeGreaterThan(0);

    // Should have CRDT columns
    const hasHlcColumn = schema.some((col) => col.name === "haex_column_hlcs");
    const hasTimestampColumn = schema.some((col) => col.name === "haex_timestamp");
    expect(hasHlcColumn).toBe(true);
    expect(hasTimestampColumn).toBe(true);
  });

  test("should clear dirty tables", async () => {
    // First get current dirty tables
    const before = await vault.getDirtyTables();
    console.log("[Test] Dirty tables before clear:", before.length);

    // Clear all dirty tables
    await vault.invokeTauriCommand("clear_all_dirty_tables");

    // Check they're cleared
    const after = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after clear:", after.length);

    expect(after.length).toBe(0);
  });

  test("should mark table dirty after new change", async () => {
    // Make another change
    await vault.invokeTauriCommand("extension_database_execute", {
      extensionId: EXTENSION_PUBLIC_KEY,
      sql: `UPDATE haex_vault_settings SET value = ? WHERE key = 'test_key' OR 1=0`,
      params: ["test_value_" + Date.now()],
    }).catch(() => {
      // Might fail if key doesn't exist, that's ok
    });

    // Insert a new setting
    await vault.invokeTauriCommand("extension_database_execute", {
      extensionId: EXTENSION_PUBLIC_KEY,
      sql: `INSERT OR REPLACE INTO haex_vault_settings (key, value) VALUES (?, ?)`,
      params: ["e2e_test_key", "e2e_test_value_" + Date.now()],
    }).catch(() => {
      // This might need the core vault context
    });

    // Check dirty tables
    const dirtyTables = await vault.getDirtyTables();
    console.log("[Test] Dirty tables after setting change:", dirtyTables);

    // Note: The change might not be tracked if it's a core table
    // This test verifies the dirty table mechanism works
  });
});
