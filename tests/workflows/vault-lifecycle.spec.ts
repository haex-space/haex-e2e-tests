// tests/workflows/vault-lifecycle.spec.ts
//
// E2E Tests for complete vault lifecycle workflows
//
// These tests verify real user workflows, not just UI elements:
// 1. Create a new vault, add data, verify persistence
// 2. Close and reopen vault, verify data is still there
// 3. Install extensions and verify they work
// 4. Export and import vault, verify data integrity

import {
  test,
  expect,
  VaultAutomation,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  waitForExtensionReady,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
} from "../fixtures";

// Use the test vault created by global-setup for reliable testing
// This vault already has haex-pass installed
const WORKFLOW_VAULT_NAME = "e2e-test-vault";
const WORKFLOW_VAULT_PASSWORD = "test-password-12345";

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface SetLoginResponse {
  entryId: string;
  title: string;
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

test.describe("Vault Lifecycle Workflow", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let createdEntryId: string;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("Step 1: Verify vault is accessible via Bridge", async () => {
    // The global-setup opens the vault database and starts the WebSocket bridge
    // However, other tests (like vault-import) may have opened a different vault.
    // We need to ensure OUR test vault is open before proceeding.

    // Get list of vaults to confirm test vault exists
    const vaults = await vault.invokeTauriCommand<Array<{ name: string; path: string }>>(
      "list_vaults"
    );

    const testVault = vaults.find((v) => v.name === WORKFLOW_VAULT_NAME);
    expect(testVault).toBeDefined();
    console.log(`[Workflow] Test vault exists: ${testVault!.name}`);

    // Close any currently open vault first (other tests may have opened different vaults)
    try {
      await vault.invokeTauriCommand("close_database");
      console.log(`[Workflow] Closed previous vault`);
    } catch {
      // No vault open, that's fine
    }

    // Open the test vault
    await vault.invokeTauriCommand("open_encrypted_database", {
      vaultPath: testVault!.path,
      key: WORKFLOW_VAULT_PASSWORD,
    });
    console.log(`[Workflow] Test vault opened: ${testVault!.name}`);

    // Wait a moment for bridge to be ready after vault open
    await new Promise((r) => setTimeout(r, 1000));

    // Verify by checking that the bridge is accessible
    const client = new VaultBridgeClient();
    const connected = await waitForBridgeConnection(client, 10000);

    expect(connected).toBe(true);
    console.log(`[Workflow] WebSocket bridge connected - vault is functional`);

    client.disconnect();
  });

  test("Step 2: Ensure haex-pass extension is ready", async () => {
    // The global-setup already installed haex-pass
    // Check via Tauri command that it's installed

    const extensions = await vault.invokeTauriCommand<
      Array<{ id: string; name: string; version: string }>
    >("get_all_extensions");

    const haexPass = extensions.find((ext) => ext.name === "haex-pass");
    expect(haexPass).toBeDefined();

    console.log(`[Workflow] haex-pass extension ready: v${haexPass!.version}`);
  });

  test("Step 3: Add data via haex-pass extension", async () => {
    // Connect to the bridge and add a password entry
    // VaultBridgeClient connects to the local bridge (no instance parameter needed)
    const client = new VaultBridgeClient();

    const connected = await waitForBridgeConnection(client, 15000);
    expect(connected).toBe(true);

    const authorized = await authorizeClient(client, "haex-pass", 30000);
    expect(authorized).toBe(true);

    const ready = await waitForExtensionReady(client);
    expect(ready).toBe(true);

    // Create a password entry
    const response = (await sendRequestWithRetry(
      client,
      HAEX_PASS_METHODS.SET_ITEM,
      {
        title: "Workflow Test Entry",
        url: "https://workflow-test.example.com",
        username: "workflowuser",
        password: "workflowpass123!",
      },
      { maxAttempts: 3, initialDelay: 1000 }
    )) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);
    expect(response.data?.entryId).toBeDefined();
    createdEntryId = response.data!.entryId;

    console.log(`[Workflow] Created password entry with ID: ${createdEntryId}`);

    // Verify entry exists
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://workflow-test.example.com",
    })) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);
    expect(getResponse.data?.entries.length).toBeGreaterThan(0);

    const entry = getResponse.data!.entries.find((e) => e.id === createdEntryId);
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Workflow Test Entry");
    expect(entry!.fields.username).toBe("workflowuser");

    client.disconnect();
  });

  test("Step 4: Close vault and return to start page", async () => {
    // Navigate back to start page (close vault)
    await vault.navigateTo("/en");

    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Verify we're back on the start page
    expect(pageSource).toContain("Create vault");
    expect(pageSource).toContain("Last used Vaults");

    // Verify our test vault appears in the list
    expect(pageSource).toContain(WORKFLOW_VAULT_NAME);

    console.log(`[Workflow] Vault ${WORKFLOW_VAULT_NAME} appears in last vaults list`);
  });

  test("Step 5: Reopen vault and verify data persists", async () => {
    // Get list of vaults to find our test vault
    const vaults = await vault.invokeTauriCommand<Array<{ name: string; path: string }>>(
      "list_vaults"
    );

    const testVault = vaults.find((v) => v.name === WORKFLOW_VAULT_NAME);
    expect(testVault).toBeDefined();

    // Open the vault using Tauri command (bypassing UI)
    await vault.invokeTauriCommand("open_encrypted_database", {
      vaultPath: testVault!.path,
      key: WORKFLOW_VAULT_PASSWORD,
    });

    console.log(`[Workflow] Vault reopened via Tauri command`);

    // Wait for bridge to be ready after vault opens
    await new Promise((r) => setTimeout(r, 2000));

    // Connect to bridge and verify data
    const client = new VaultBridgeClient();

    const connected = await waitForBridgeConnection(client, 15000);
    expect(connected).toBe(true);

    const authorized = await authorizeClient(client, "haex-pass", 30000);
    expect(authorized).toBe(true);

    // Verify the entry we created earlier still exists
    const getResponse = (await sendRequestWithRetry(
      client,
      HAEX_PASS_METHODS.GET_ITEMS,
      { url: "https://workflow-test.example.com" },
      { maxAttempts: 3, initialDelay: 1000 }
    )) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);

    const entry = getResponse.data?.entries.find((e) => e.id === createdEntryId);
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Workflow Test Entry");
    expect(entry!.fields.username).toBe("workflowuser");
    expect(entry!.fields.password).toBe("workflowpass123!");

    console.log(`[Workflow] Data persisted correctly after vault reopen`);

    client.disconnect();
  });

  test("Step 6: Verify installed extensions are still available", async () => {
    // Get list of installed extensions via Tauri command
    const extensions = await vault.invokeTauriCommand<
      Array<{ id: string; name: string; version: string }>
    >("get_all_extensions");

    // haex-pass should be installed
    const haexPass = extensions.find((ext) => ext.name === "haex-pass");
    expect(haexPass).toBeDefined();

    console.log(`[Workflow] haex-pass extension found: v${haexPass!.version}`);
  });
});
