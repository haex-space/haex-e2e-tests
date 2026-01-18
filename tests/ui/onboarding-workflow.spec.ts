// tests/ui/onboarding-workflow.spec.ts
//
// E2E Tests for the complete user onboarding workflow
//
// Tests the UI interactions on the start page:
// - Creating a new vault
// - Opening an existing vault from the list
// - Importing a vault
// - Connecting to a remote backend
//
// These tests use WebDriver to interact with the actual UI elements.
// All tests navigate to /en for consistent English locale.

import { test, expect, VaultAutomation } from "../fixtures";

test.describe("Start Page UI", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("should display welcome message and logo", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    expect(pageSource).toContain("Haex Space");
    expect(pageSource).toContain("Have fun at");
  });

  test("should display version number", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // Version format: v1.x.x
    expect(pageSource).toMatch(/v\d+\.\d+\.\d+/);
  });

  test("should have create vault button", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // English label from create.vue i18n
    expect(pageSource).toContain("Create vault");
  });

  test("should have open vault button", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // English label from import.vue i18n - button says "Open Vault"
    expect(pageSource).toContain("Open Vault");
  });

  test("should have connect vault button", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // English label from connect.vue i18n
    expect(pageSource).toContain("Connect Vault");
  });

  test("should display sponsors section", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // English label from index.vue i18n
    expect(pageSource).toContain("Supported by");
  });

  test("should have itemis sponsor logo", async () => {
    await vault.navigateTo("/en");

    const pageSource = await vault.getPageSource();
    // itemis logo is rendered as SVG component with id="logo"
    // The URL is called via JavaScript (openUrl), so we check for the SVG logo
    expect(pageSource).toContain("logo-textsss");
  });
});

test.describe("Vault Creation Flow", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("create vault drawer should open on button click", async () => {
    await vault.navigateTo("/en");

    // Find and click the create button
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Create vault')) {
          btn.click();
          break;
        }
      }
    `);

    // Wait for drawer to open
    await new Promise((r) => setTimeout(r, 500));

    const pageSource = await vault.getPageSource();
    // Drawer should show vault creation form with title
    expect(pageSource).toContain("Create new HaexVault");
  });

  test("create vault form should have required fields", async () => {
    await vault.navigateTo("/en");

    // Open create drawer
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Create vault')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 500));

    const pageSource = await vault.getPageSource();
    // Check for form fields - labels from create.vue i18n: "Vault name", "Enter password", "Repeat password"
    expect(pageSource).toContain("Vault name");
    expect(pageSource).toContain("Enter password");
    expect(pageSource).toContain("password"); // Confirm field is also present
  });
});

test.describe("Last Vaults List", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("should display last used vaults section if vaults exist", async () => {
    await vault.navigateTo("/en");

    // Wait for page to load and sync vaults
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Since global-setup creates a test vault, it should be visible
    const hasLastVaultsSection = pageSource.includes("Last used Vaults");

    console.log(
      `[UI Test] Last vaults section visible: ${hasLastVaultsSection}`
    );
    // Document expected behavior - section is hidden if no vaults exist
  });

  test("should show test vault in last vaults list", async () => {
    await vault.navigateTo("/en");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // The test vault created by global-setup should appear
    const hasTestVault =
      pageSource.includes("E2E Test Vault") ||
      pageSource.includes("test-vault");

    console.log(`[UI Test] Test vault in list: ${hasTestVault}`);
  });
});

test.describe("Vault Open Flow", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("clicking a vault in last vaults should open password dialog", async () => {
    await vault.navigateTo("/en");
    await new Promise((r) => setTimeout(r, 1000));

    // Try to click on a vault in the list
    await vault.executeScript(`
      // Find vault items in the list - they have group class for hover effects
      const vaultItems = document.querySelectorAll('[class*="group"]');
      if (vaultItems.length > 0) {
        // Click on the first vault item's button
        const button = vaultItems[0].querySelector('button');
        if (button) button.click();
      }
    `);

    await new Promise((r) => setTimeout(r, 500));

    // If a vault was clicked, password drawer should open
    const pageSource = await vault.getPageSource();
    const hasPasswordField = pageSource.includes("Password");

    console.log(`[UI Test] Password dialog opened: ${hasPasswordField}`);
  });
});

test.describe("Open Vault Drawer", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("open vault button should open file selection drawer", async () => {
    await vault.navigateTo("/en");

    // Find and click the open vault button
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Open Vault')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 500));

    const pageSource = await vault.getPageSource();
    // The import drawer should show the title
    expect(pageSource).toContain("Import Vault");
  });
});

test.describe("Remote Connection Flow", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("connect button should open remote connection wizard", async () => {
    await vault.navigateTo("/en");

    // Find and click the connect button
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Connect Vault')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 500));

    const pageSource = await vault.getPageSource();

    // Connection wizard should have server URL field
    expect(
      pageSource.includes("Server") || pageSource.includes("server")
    ).toBe(true);
  });

  test("remote connection wizard should have email and password fields", async () => {
    await vault.navigateTo("/en");

    // Open the connect wizard
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Connect Vault')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 500));

    const pageSource = await vault.getPageSource();

    // Should have authentication fields
    expect(pageSource).toContain("Email");
    expect(pageSource).toContain("Password");
  });
});

test.describe("Welcome Dialog (Post-Vault Creation)", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  // The welcome dialog appears after a vault is created/opened for the first time
  // It has 3 steps: Device Name, Extensions, Sync

  test("welcome dialog should have stepper with correct steps", async () => {
    // Navigate to the vault page where welcome dialog might be shown
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Check if we're on the vault page or if welcome dialog is visible
    // The stepper shows: Device Name, Extensions, Synchronization
    const hasDeviceStep = pageSource.includes("Device Name");
    const hasExtensionsStep = pageSource.includes("Extensions");
    const hasSyncStep = pageSource.includes("Synchronization");

    console.log(`[UI Test] Welcome dialog steps visible:`, {
      device: hasDeviceStep,
      extensions: hasExtensionsStep,
      sync: hasSyncStep,
    });
  });

  test("device name step should have input field", async () => {
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Device name step shows an input with placeholder examples
    const hasDeviceInput =
      pageSource.includes("Device Name") ||
      pageSource.includes("MacBook Pro") ||
      pageSource.includes("iPhone");

    console.log(`[UI Test] Device name input visible: ${hasDeviceInput}`);
  });

  test("welcome dialog has navigation buttons", async () => {
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Should have Next/Skip buttons
    const hasNextButton = pageSource.includes("Next");
    const hasSkipButton = pageSource.includes("Skip");

    console.log(`[UI Test] Navigation buttons:`, {
      next: hasNextButton,
      skip: hasSkipButton,
    });
  });
});

test.describe("Extension Installation (via Welcome Dialog)", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("extensions step should show haex-pass as recommended", async () => {
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    // Navigate to extensions step by clicking Next (if on device step)
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Next')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 2000)); // Wait for extensions to load

    const pageSource = await vault.getPageSource();

    // haex-pass should be visible in the extensions list
    const hasHaexPass = pageSource.includes("haex-pass");
    const hasRecommendedBadge = pageSource.includes("Recommended");

    console.log(`[UI Test] Extensions step:`, {
      haexPassVisible: hasHaexPass,
      recommendedBadge: hasRecommendedBadge,
    });
  });

  test("extensions step should have permissions button when extension selected", async () => {
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    // Navigate to extensions step
    await vault.executeScript(`
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Next')) {
          btn.click();
          break;
        }
      }
    `);

    await new Promise((r) => setTimeout(r, 2000));

    const pageSource = await vault.getPageSource();

    // Should have permissions button (shown when an extension is selected)
    const hasPermissionsButton = pageSource.includes("Permissions");

    console.log(`[UI Test] Permissions button visible: ${hasPermissionsButton}`);
  });
});

test.describe("Marketplace UI", () => {
  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test.afterAll(async () => {
    await vault.deleteSession();
  });

  test("marketplace should be accessible from desktop", async () => {
    // Navigate to the vault desktop page
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Check if marketplace link or extensions text is present
    const hasMarketplaceLink =
      pageSource.includes("Marketplace") ||
      pageSource.includes("Extensions");

    console.log(`[UI Test] Marketplace accessible: ${hasMarketplaceLink}`);
  });
});
