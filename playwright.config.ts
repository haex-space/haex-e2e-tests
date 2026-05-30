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
    // Only capture artifacts on failure to reduce overhead
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  // Two projects, run sequentially because workers=1 and project order in
  // this array is the run order:
  //   1. `flake-prone-first` — the QUIC invite-flow suite (longest serial
  //      block, frequent UI-race failures). Running it first means we see
  //      its outcome in the first ~5 minutes of the e2e job instead of
  //      after the full ~20 min suite — faster iteration on the regressions
  //      that actually move.
  //   2. `chromium` — every other test. testIgnore matches the same glob
  //      flake-prone-first runs, so the two projects don't overlap.
  projects: [
    {
      name: "flake-prone-first",
      testMatch: /spaces\/invitations\/quic-invite-flow\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "chromium",
      testIgnore: /spaces\/invitations\/quic-invite-flow\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  // Global setup/teardown
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
});
