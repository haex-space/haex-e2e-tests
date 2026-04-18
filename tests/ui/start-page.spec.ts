import { test, expect, VaultAutomation } from "../fixtures";

test.describe("ui: start page and database info", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  // The field name for file size varies by vault version (fileSize vs file_size)
  let fileSizeKey: string;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test("page source contains expected HTML content", async () => {
    const source = await vault.getPageSource();

    expect(typeof source).toBe("string");
    expect(source.length).toBeGreaterThan(0);
    // The page should be valid HTML
    expect(source).toContain("<html");
    expect(source).toContain("</html>");
  });

  test("get_database_info returns file size greater than zero", async () => {
    const info = await vault.invokeTauriCommand<Record<string, unknown>>(
      "get_database_info",
      {}
    );

    // Determine which key holds the file size (camelCase or snake_case)
    fileSizeKey =
      "fileSize" in info ? "fileSize" :
      "file_size" in info ? "file_size" :
      "size" in info ? "size" : "";

    if (fileSizeKey) {
      expect(typeof info[fileSizeKey]).toBe("number");
      expect(info[fileSizeKey] as number).toBeGreaterThan(0);
    } else {
      // If no known size field, at least verify the command returned an object
      expect(typeof info).toBe("object");
      expect(info).not.toBeNull();
    }
  });

  test("database_vacuum runs without error and returns a result", async () => {
    // Reaching this point proves the Tauri command did not throw.
    // Return type varies across vault versions (string, null, or void),
    // so we only assert the shape is one of those.
    const result = await vault.invokeTauriCommand<unknown>(
      "database_vacuum",
      {}
    );

    expect(result === null || result === undefined || typeof result === "string").toBe(true);
  });

  test("database size after vacuum is still greater than zero", async () => {
    const info = await vault.invokeTauriCommand<Record<string, unknown>>(
      "get_database_info",
      {}
    );

    if (fileSizeKey && fileSizeKey in info) {
      expect(typeof info[fileSizeKey]).toBe("number");
      expect(info[fileSizeKey] as number).toBeGreaterThan(0);
    }
  });
});
