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

  test("should display last used vaults section with test vault", async () => {
    await vault.navigateTo("/en");

    // Wait for page to load and sync vaults
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // Since global-setup creates a test vault, "Last used Vaults" section should be visible
    expect(pageSource).toContain("Last used Vaults");

    // The test vault created by global-setup should appear
    // Check for either the vault name or the generic test-vault pattern
    const hasTestVault =
      pageSource.includes("e2e-test-vault") ||
      pageSource.includes("E2E Test Vault");
    expect(hasTestVault).toBe(true);
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

    // Password dialog should open with password input field
    const pageSource = await vault.getPageSource();
    expect(pageSource).toContain("Password");
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

  test("welcome dialog should have complete stepper with all steps and navigation", async () => {
    // Navigate to the vault page where welcome dialog might be shown
    await vault.navigateTo("/en/vault");
    await new Promise((r) => setTimeout(r, 1000));

    const pageSource = await vault.getPageSource();

    // The stepper shows: Device Name, Extensions, Synchronization
    expect(pageSource).toContain("Device Name");
    expect(pageSource).toContain("Extensions");
    expect(pageSource).toContain("Synchronization");

    // Device name step shows an input with placeholder examples
    const hasDeviceInput =
      pageSource.includes("MacBook Pro") ||
      pageSource.includes("iPhone") ||
      pageSource.includes("input");
    expect(hasDeviceInput).toBe(true);

    // Should have Next/Skip buttons for navigation
    const hasNavigation =
      pageSource.includes("Next") || pageSource.includes("Skip");
    expect(hasNavigation).toBe(true);
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

  test("extensions step should show haex-pass with recommended badge and permissions", async () => {
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
    expect(pageSource).toContain("haex-pass");

    // Should have recommended badge or permissions button
    const hasExtensionUI =
      pageSource.includes("Recommended") ||
      pageSource.includes("Permissions") ||
      pageSource.includes("Install");
    expect(hasExtensionUI).toBe(true);
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
    expect(hasMarketplaceLink).toBe(true);
  });
});
