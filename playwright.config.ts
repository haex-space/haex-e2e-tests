import { defineConfig, devices } from "@playwright/test";

// Set Playwright browsers path for Docker environment
process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/playwright-browsers";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // Run tests sequentially for now (shared state)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Global timeout for tests - extension initialization can be slow
  timeout: 60000, // 60 seconds per test
  expect: {
    timeout: 10000, // 10 seconds for expect assertions
  },
  reporter: [
    ["html", { outputFolder: "test-results/html-report" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["list"],
  ],
  outputDir: "test-results/artifacts",

  use: {
    trace: "on-first-retry",
    screenshot: "on",
    video: "on",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  // Global setup/teardown
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
});
