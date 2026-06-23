import { test, expect, VaultAutomation } from "../fixtures";

/**
 * Companion spec for haex-vault PR #529:
 * "Sync-table filter honors `Denied`" (extension_filter_sync_tables).
 *
 * Pre-#529, extension_filter_sync_tables only checked resource_type + target
 * match. A `Denied` row was treated identically to a missing row, so a broad
 * `haex_*` Granted row would still cause `haex_logs` to leak into the
 * extension's filtered list even when an explicit Denied row existed.
 *
 * Post-#529, the filter resolves matching rows via `deny_first_precedence`,
 * so any Denied row for a target wins over Granted rows that also match it.
 *
 * This spec calls the public `extension_filter_sync_tables` Tauri command
 * directly (it's the same surface the SyncEvent dispatcher uses), so the
 * test exercises the production wiring (`PermissionManager::get_permissions`
 * → table filter → result map). Vault unit tests in
 * `extension/tests/sync_tables_tests.rs` cover the helpers in isolation;
 * this spec proves the integration on the live AppState path.
 */

interface Extension {
  id: string;
  name: string;
  version: string;
  publicKey: string;
}

interface PermissionEntry {
  target: string;
  operation?: string | null;
  constraints?: Record<string, unknown> | null;
  status?: "granted" | "denied" | "ask" | null;
}

// Mirrors haex-vault's ExtensionPermissions struct
// (src-tauri/src/extension/core/manifest.rs).
interface EditablePermissions {
  database?: PermissionEntry[] | null;
  filesystem?: PermissionEntry[] | null;
  http?: PermissionEntry[] | null;
  shell?: PermissionEntry[] | null;
  syncServers?: PermissionEntry[] | null;
  cloudStorage?: PermissionEntry[] | null;
  syncRules?: PermissionEntry[] | null;
  spaces?: PermissionEntry[] | null;
  identities?: PermissionEntry[] | null;
  passwords?: PermissionEntry[] | null;
  mail?: PermissionEntry[] | null;
  notifications?: PermissionEntry[] | null;
}

interface FilteredSyncTablesResult {
  extensions: Record<string, string[]>;
}

test.describe("extensions: sync_tables honors Denied", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let extensionId: string;
  let originalPermissions: EditablePermissions;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    const extensions = await vault.invokeTauriCommand<Extension[]>(
      "get_all_extensions",
      {},
    );
    const haexNotes = extensions.find((ext) => ext.name === "haex-notes");
    expect(haexNotes, "haex-notes must be pre-installed for this spec").not
      .toBeUndefined();
    extensionId = haexNotes!.id;

    originalPermissions = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId },
    );
  });

  test.afterAll(async () => {
    // Always restore so we don't leak state into sibling specs.
    if (originalPermissions) {
      await vault.invokeTauriCommand("update_extension_permissions", {
        extensionId,
        permissions: originalPermissions,
      });
    }
  });

  test("denied row for haex_logs blocks it from extension_filter_sync_tables despite haex_* granted", async () => {
    // Set up the precedence collision:
    //   * Granted on `haex_*` (broad prefix wildcard) — would allow everything.
    //   * Denied on `haex_logs` (specific exact target) — must win.
    // `operation` must parse via DbAction::from_str — empty/missing makes
    // the manifest parser drop the entry silently. See actions.rs
    // (src-tauri/src/extension/permissions/types/actions.rs).
    const updated: EditablePermissions = {
      ...originalPermissions,
      database: [
        { target: "haex_*", operation: "read", status: "granted" },
        { target: "haex_logs", operation: "read", status: "denied" },
      ],
    };

    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: updated,
    });

    // Filter a candidate table list. Both haex_logs and haex_settings match
    // the broad `haex_*` Granted row; only haex_logs is also Denied.
    const result = await vault.invokeTauriCommand<FilteredSyncTablesResult>(
      "extension_filter_sync_tables",
      { tables: ["haex_logs", "haex_settings"] },
    );

    const allowed = result.extensions[extensionId] ?? [];

    // Post-#529: haex_settings is allowed (broad Granted, no Denied match),
    // haex_logs is filtered out (Denied wins over Granted).
    expect(allowed).toContain("haex_settings");
    expect(allowed).not.toContain("haex_logs");
  });

  test("denied row alone (no overlapping granted) also filters the table out", async () => {
    // Belt-and-braces: a Denied row with no broader Granted should also be
    // filtered. Pre-#529 would still drop it (because the row never granted
    // access in the first place), but this guards against a regression where
    // a Denied row is somehow treated as a granted-style match.
    const updated: EditablePermissions = {
      ...originalPermissions,
      database: [
        { target: "haex_logs", operation: "read", status: "denied" },
      ],
    };

    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: updated,
    });

    const result = await vault.invokeTauriCommand<FilteredSyncTablesResult>(
      "extension_filter_sync_tables",
      { tables: ["haex_logs"] },
    );

    const allowed = result.extensions[extensionId] ?? [];
    expect(allowed).not.toContain("haex_logs");
  });
});
