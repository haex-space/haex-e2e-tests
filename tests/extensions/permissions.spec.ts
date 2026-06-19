import { test, expect, VaultAutomation } from "../fixtures";

interface Extension {
  id: string;
  name: string;
  version: string;
  author: string;
  publicKey: string;
}

// EditablePermissions (= ExtensionPermissions) from haex-vault.
// Each field is Option<Vec<PermissionEntry>> - serialized as null or array.
interface EditablePermissions {
  database: PermissionEntry[] | null;
  filesystem: PermissionEntry[] | null;
  http: PermissionEntry[] | null;
  shell: PermissionEntry[] | null;
  filesync: PermissionEntry[] | null;
  spaces: PermissionEntry[] | null;
  identities: PermissionEntry[] | null;
}

interface PermissionEntry {
  target: string;
  operation?: string | null;
  constraints?: Record<string, unknown> | null;
  status?: string | null;
}

// All expected keys in the permissions response
const PERMISSION_KEYS: (keyof EditablePermissions)[] = [
  "database",
  "filesystem",
  "http",
  "shell",
  "filesync",
  "spaces",
  "identities",
];

test.describe("extensions: permissions", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let extensionId: string;
  let originalPermissions: EditablePermissions;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    const extensions = await vault.invokeTauriCommand<Extension[]>(
      "get_all_extensions",
      {}
    );
    const haexPass = extensions.find((ext) => ext.name === "haex-notes");
    expect(haexPass).not.toBeUndefined();
    extensionId = haexPass!.id;
  });

  test.afterAll(async () => {
    // Restore original permissions
    if (originalPermissions) {
      await vault.invokeTauriCommand("update_extension_permissions", {
        extensionId,
        permissions: originalPermissions,
      });
    }
  });

  test("get_extension_permissions returns valid structure with all permission categories", async () => {
    const permissions = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId }
    );

    originalPermissions = permissions;

    // Each field should be either null or an array (Option<Vec<PermissionEntry>>)
    for (const key of PERMISSION_KEYS) {
      const value = permissions[key];
      expect(
        value === null || value === undefined || Array.isArray(value)
      ).toBe(true);
    }
  });

  test("permissions object has the expected keys", async () => {
    const permissions = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId }
    );

    const keys = Object.keys(permissions);
    // Must contain at least the core permission categories
    for (const expected of ["database", "filesystem", "http", "shell"]) {
      expect(keys).toContain(expected);
    }
  });

  test("update_extension_permissions with new http rule persists", async () => {
    const currentHttp = originalPermissions.http ?? [];
    const updatedPermissions: EditablePermissions = {
      ...originalPermissions,
      http: [
        ...currentHttp,
        { target: "https://e2e-test.example.com/*" },
      ],
    };

    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: updatedPermissions,
    });

    // Re-read and verify the update persisted
    const readBack = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId }
    );

    const readBackHttp = readBack.http ?? [];
    expect(readBackHttp.length).toEqual(updatedPermissions.http!.length);

    const targets = readBackHttp.map((rule) => rule.target);
    expect(targets).toContain("https://e2e-test.example.com/*");

    // Other categories should remain unchanged
    expect(readBack.database ?? null).toEqual(originalPermissions.database ?? null);
    expect(readBack.filesystem ?? null).toEqual(originalPermissions.filesystem ?? null);
    expect(readBack.shell ?? null).toEqual(originalPermissions.shell ?? null);
  });
});
