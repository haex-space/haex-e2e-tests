// tests/limits/rate-limits.spec.ts
//
// E2E Tests for Extension Limit Management API
//
// These tests verify:
// 1. The Tauri API for managing extension database limits (get/update/reset)
// 2. Input validation for limit values
// 3. Persistence of custom limits across get/update cycles
//
// Note: Direct limit enforcement tests (e.g., triggering a rate limit error)
// require extension context which is complex to set up in E2E tests.
// The enforcement logic is tested via unit tests in haex-vault.

import { test, expect, VaultAutomation } from "../fixtures";

const LIMITS_COMMANDS = {
  getLimits: "get_extension_limits",
  updateLimits: "update_extension_limits",
  resetLimits: "reset_extension_limits",
} as const;

interface ExtensionLimitsResponse {
  extensionId: string;
  queryTimeoutMs: number;
  maxResultRows: number;
  maxConcurrentQueries: number;
  maxQuerySizeBytes: number;
  isCustom: boolean;
}

test.describe("Extension Database Limits API", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let extensionId: string;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    const extensions = await vault.invokeTauriCommand<
      Array<{ id: string; name: string }>
    >("get_all_extensions");

    if (extensions.length === 0) {
      throw new Error("No extensions registered - cannot run limit tests");
    }

    extensionId = extensions[0].id;
    console.log(`[Limits] Testing with extension: ${extensionId}`);
  });

  test.afterAll(async () => {
    try {
      await vault.invokeTauriCommand(LIMITS_COMMANDS.resetLimits, {
        extensionId,
      });
    } catch {
      // Ignore cleanup errors
    }
    await vault.deleteSession();
  });

  test("get_extension_limits returns valid response structure", async () => {
    const limits = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.getLimits,
      { extensionId }
    );

    expect(limits.extensionId).toBe(extensionId);
    expect(typeof limits.queryTimeoutMs).toBe("number");
    expect(typeof limits.maxResultRows).toBe("number");
    expect(typeof limits.maxConcurrentQueries).toBe("number");
    expect(typeof limits.maxQuerySizeBytes).toBe("number");
    expect(typeof limits.isCustom).toBe("boolean");

    // Reasonable bounds check
    expect(limits.queryTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(limits.maxResultRows).toBeGreaterThanOrEqual(100);
    expect(limits.maxConcurrentQueries).toBeGreaterThanOrEqual(1);
    expect(limits.maxQuerySizeBytes).toBeGreaterThanOrEqual(1024);
  });

  test("get_extension_limits rejects non-existent extension", async () => {
    await expect(
      vault.invokeTauriCommand(LIMITS_COMMANDS.getLimits, {
        extensionId: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toThrow(/not found/i);
  });

  test("update_extension_limits persists queryTimeoutMs", async () => {
    const newValue = 15000;

    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.updateLimits,
      { request: { extensionId, queryTimeoutMs: newValue } }
    );

    expect(updated.queryTimeoutMs).toBe(newValue);
    expect(updated.isCustom).toBe(true);

    // Verify persistence
    const fetched = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.getLimits,
      { extensionId }
    );
    expect(fetched.queryTimeoutMs).toBe(newValue);
  });

  test("update_extension_limits persists maxResultRows", async () => {
    const newValue = 500;

    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.updateLimits,
      { request: { extensionId, maxResultRows: newValue } }
    );

    expect(updated.maxResultRows).toBe(newValue);
  });

  test("update_extension_limits persists maxConcurrentQueries", async () => {
    const newValue = 3;

    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.updateLimits,
      { request: { extensionId, maxConcurrentQueries: newValue } }
    );

    expect(updated.maxConcurrentQueries).toBe(newValue);
  });

  test("update_extension_limits persists maxQuerySizeBytes", async () => {
    const newValue = 512 * 1024;

    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.updateLimits,
      { request: { extensionId, maxQuerySizeBytes: newValue } }
    );

    expect(updated.maxQuerySizeBytes).toBe(newValue);
  });

  test("update_extension_limits supports partial updates", async () => {
    // Set known baseline
    await vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
      request: { extensionId, queryTimeoutMs: 10000, maxResultRows: 1000 },
    });

    // Update only queryTimeoutMs
    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.updateLimits,
      { request: { extensionId, queryTimeoutMs: 20000 } }
    );

    expect(updated.queryTimeoutMs).toBe(20000);
    expect(updated.maxResultRows).toBe(1000); // Unchanged
  });

  test("update_extension_limits rejects queryTimeoutMs below minimum (1000ms)", async () => {
    await expect(
      vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
        request: { extensionId, queryTimeoutMs: 500 },
      })
    ).rejects.toThrow(/at least 1000/i);
  });

  test("update_extension_limits rejects maxResultRows below minimum (100)", async () => {
    await expect(
      vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
        request: { extensionId, maxResultRows: 50 },
      })
    ).rejects.toThrow(/at least 100/i);
  });

  test("update_extension_limits rejects maxConcurrentQueries below minimum (1)", async () => {
    await expect(
      vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
        request: { extensionId, maxConcurrentQueries: 0 },
      })
    ).rejects.toThrow(/at least 1/i);
  });

  test("update_extension_limits rejects maxQuerySizeBytes below minimum (1024)", async () => {
    await expect(
      vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
        request: { extensionId, maxQuerySizeBytes: 512 },
      })
    ).rejects.toThrow(/at least 1024/i);
  });

  test("reset_extension_limits restores defaults", async () => {
    // Set custom values
    await vault.invokeTauriCommand(LIMITS_COMMANDS.updateLimits, {
      request: { extensionId, queryTimeoutMs: 5000, maxResultRows: 200 },
    });

    const beforeReset = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.getLimits,
      { extensionId }
    );
    expect(beforeReset.isCustom).toBe(true);

    // Reset
    const afterReset = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.resetLimits,
      { extensionId }
    );

    expect(afterReset.isCustom).toBe(false);
    expect(afterReset.queryTimeoutMs).toBe(30000);
    expect(afterReset.maxResultRows).toBe(10000);
    expect(afterReset.maxConcurrentQueries).toBe(5);
    expect(afterReset.maxQuerySizeBytes).toBe(1048576);
  });

  test("reset_extension_limits is idempotent", async () => {
    // Reset twice should not error
    await vault.invokeTauriCommand(LIMITS_COMMANDS.resetLimits, { extensionId });

    const result = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      LIMITS_COMMANDS.resetLimits,
      { extensionId }
    );

    expect(result.isCustom).toBe(false);
  });
});
