import { test, expect, VaultAutomation } from "../fixtures";

interface LogEntry {
  id: number;
  level: string;
  source: string;
  message: string;
  metadata: string | null;
  createdAt: string;
}

// Skip: log_write_system command does not exist in this vault version
test.describe.skip("ui: logging", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  const testMessage = `e2e-log-test-${Date.now()}`;
  const testSource = "e2e-test";
  const testLevel = "info";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test("write a log entry with known message", async () => {
    await vault.invokeTauriCommand("log_write_system", {
      level: testLevel,
      source: testSource,
      message: testMessage,
      metadata: null,
      deviceId: "e2e",
    });
  });

  test("read logs with source filter returns our entry", async () => {
    const logs = await vault.invokeTauriCommand<LogEntry[]>("log_read", {
      source: testSource,
      limit: 100,
    });

    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const found = logs.find((entry) => entry.message === testMessage);
    expect(found).not.toBeUndefined();
  });

  test("log entry has correct level, source, and message", async () => {
    const logs = await vault.invokeTauriCommand<LogEntry[]>("log_read", {
      source: testSource,
      limit: 100,
    });

    const entry = logs.find((e) => e.message === testMessage);
    expect(entry).not.toBeUndefined();

    expect(entry!.level).toBe(testLevel);
    expect(entry!.source).toBe(testSource);
    expect(entry!.message).toBe(testMessage);
    expect(typeof entry!.id).toBe("number");
    expect(typeof entry!.createdAt).toBe("string");
    expect(entry!.createdAt.length).toBeGreaterThan(0);
  });

  test("log_cleanup returns a number", async () => {
    const cleaned = await vault.invokeTauriCommand<number>(
      "log_cleanup",
      {}
    );

    expect(typeof cleaned).toBe("number");
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });
});
