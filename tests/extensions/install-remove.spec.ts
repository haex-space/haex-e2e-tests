import { test, expect, VaultAutomation } from "../fixtures";

interface Extension {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  publicKey: string;
}

test.describe("extensions: install & query", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let haexPass: Extension;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();
  });

  test("get_all_extensions returns list containing haex-pass", async () => {
    const extensions = await vault.invokeTauriCommand<Extension[]>(
      "get_all_extensions",
      {}
    );

    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThanOrEqual(1);

    const found = extensions.find((ext) => ext.name === "haex-pass");
    expect(found).not.toBeUndefined();
    haexPass = found!;
  });

  test("haex-pass has correct name, version, and author fields", async () => {
    expect(haexPass.name).toEqual("haex-pass");
    expect(typeof haexPass.version).toEqual("string");
    expect(haexPass.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(haexPass.author).toEqual("haex");
  });

  test("haex-pass has valid id, description, and publicKey", async () => {
    expect(typeof haexPass.id).toEqual("string");
    expect(haexPass.id.length).toBeGreaterThan(0);
    expect(typeof haexPass.description).toEqual("string");
    expect(haexPass.description.length).toBeGreaterThan(0);
    expect(typeof haexPass.publicKey).toEqual("string");
    expect(haexPass.publicKey.length).toBeGreaterThan(0);
  });

  test("is_extension_installed returns true for haex-pass", async () => {
    const installed = await vault.invokeTauriCommand<boolean>(
      "is_extension_installed",
      {
        publicKey: haexPass.publicKey,
        name: haexPass.name,
        extensionVersion: haexPass.version,
      }
    );

    expect(installed).toBe(true);
  });

  test("is_extension_installed returns false for non-existent extension", async () => {
    const installed = await vault.invokeTauriCommand<boolean>(
      "is_extension_installed",
      {
        publicKey: "nonexistent-key-00000000",
        name: "nonexistent-extension",
        extensionVersion: "0.0.0",
      }
    );

    expect(installed).toBe(false);
  });

  test("get_extension_info returns matching data for haex-pass", async () => {
    const info = await vault.invokeTauriCommand<Extension>(
      "get_extension_info",
      {
        publicKey: haexPass.publicKey,
        name: haexPass.name,
      }
    );

    expect(info.id).toEqual(haexPass.id);
    expect(info.name).toEqual("haex-pass");
    expect(info.version).toEqual(haexPass.version);
    expect(info.author).toEqual("haex");
    expect(info.publicKey).toEqual(haexPass.publicKey);
  });
});
