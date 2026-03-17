import { test, expect, VaultAutomation } from "../fixtures";

interface Extension {
  id: string;
  name: string;
  version: string;
  author: string;
  publicKey: string;
}

// Matches ExtensionLimitsResponse from haex-vault (camelCase via serde rename_all)
interface ExtensionLimitsResponse {
  extensionId: string;
  queryTimeoutMs: number;
  maxResultRows: number;
  maxConcurrentQueries: number;
  maxQuerySizeBytes: number;
  isCustom: boolean;
}

const LIMIT_FIELDS: (keyof Pick<
  ExtensionLimitsResponse,
  "queryTimeoutMs" | "maxResultRows" | "maxConcurrentQueries" | "maxQuerySizeBytes"
>)[] = [
  "queryTimeoutMs",
  "maxResultRows",
  "maxConcurrentQueries",
  "maxQuerySizeBytes",
];

test.describe("extensions: resource limits", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let extensionId: string;
  let defaultLimits: ExtensionLimitsResponse;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    const extensions = await vault.invokeTauriCommand<Extension[]>(
      "get_all_extensions",
      {}
    );
    const haexPass = extensions.find((ext) => ext.name === "haex-pass");
    expect(haexPass).not.toBeUndefined();
    extensionId = haexPass!.id;
  });

  test.afterAll(async () => {
    // Restore defaults
    await vault.invokeTauriCommand("reset_extension_limits", { extensionId });
  });

  test("get_extension_limits returns all expected fields", async () => {
    const limits = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      "get_extension_limits",
      { extensionId }
    );

    defaultLimits = limits;

    for (const field of LIMIT_FIELDS) {
      expect(typeof limits[field]).toEqual("number");
    }

    // Verify extensionId and isCustom are present
    expect(limits.extensionId).toEqual(extensionId);
    expect(typeof limits.isCustom).toEqual("boolean");
  });

  test("all limit values are positive numbers", async () => {
    for (const field of LIMIT_FIELDS) {
      expect(defaultLimits[field]).toBeGreaterThan(0);
    }
  });

  test("update_extension_limits changes a value and persists on re-read", async () => {
    const newTimeout = defaultLimits.queryTimeoutMs + 5000;

    // update_extension_limits expects a 'request' object wrapping all fields
    const updated = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      "update_extension_limits",
      {
        request: {
          extensionId,
          queryTimeoutMs: newTimeout,
        },
      }
    );

    expect(updated.queryTimeoutMs).toEqual(newTimeout);
    expect(updated.isCustom).toEqual(true);

    // Re-read to verify persistence
    const readBack = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      "get_extension_limits",
      { extensionId }
    );

    expect(readBack.queryTimeoutMs).toEqual(newTimeout);

    // Other limits should remain unchanged
    expect(readBack.maxResultRows).toEqual(defaultLimits.maxResultRows);
    expect(readBack.maxConcurrentQueries).toEqual(
      defaultLimits.maxConcurrentQueries
    );
    expect(readBack.maxQuerySizeBytes).toEqual(defaultLimits.maxQuerySizeBytes);
  });

  test("reset_extension_limits restores defaults", async () => {
    const resetLimits = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      "reset_extension_limits",
      { extensionId }
    );

    expect(resetLimits.isCustom).toEqual(false);

    for (const field of LIMIT_FIELDS) {
      expect(resetLimits[field]).toEqual(defaultLimits[field]);
    }
  });

  test("after reset, re-read matches original defaults", async () => {
    const readBack = await vault.invokeTauriCommand<ExtensionLimitsResponse>(
      "get_extension_limits",
      { extensionId }
    );

    expect(readBack.isCustom).toEqual(false);

    for (const field of LIMIT_FIELDS) {
      expect(readBack[field]).toEqual(defaultLimits[field]);
    }
  });
});
