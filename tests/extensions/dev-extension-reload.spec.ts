import { test, expect, VaultAutomation } from "../fixtures";

/**
 * Companion spec for haex-vault PR #529:
 * "Dev-server hardening — load_dev_extension always clears stale permissions"
 * (Tasks 12 + 13 of the PR).
 *
 * Pre-#529, `load_dev_extension` called `delete_permissions` only when the
 * new manifest had a non-empty permission set. A reload that *removed*
 * permissions (manifest went from "db.read.haex_*" to []) left the stale
 * row in place, so the extension kept access it no longer declared.
 *
 * The underlying fix is `PermissionManager::replace_permissions(state,
 * extension_id, &perms)` — a single SQLite transaction that does
 * delete + insert atomically and ALWAYS clears prior rows, regardless of
 * whether the new set is empty. `update_extension_permissions` now routes
 * through that helper too, which gives us a directly observable surface.
 *
 * ## Harness limitation
 *
 * `load_dev_extension` runs an HTTP health check against a dev server at
 * the host/port configured in `haextension.config.json`. The e2e Docker
 * harness does not provision a running dev server, so we cannot drive the
 * full load_dev_extension path end-to-end from a Playwright spec without
 * adding harness-side infrastructure (a sidecar Vite-style server + a
 * test manifest fixture).
 *
 * Instead, this spec exercises the SAME underlying fix via
 * `update_extension_permissions`, which (post-#529) is the only caller-
 * facing wrapper around `PermissionManager::replace_permissions`. The
 * scenario reproduces the exact failure mode that #529's Task 13 fixed:
 *
 *   1. Extension starts with N permissions in the DB.
 *   2. Reload writes a manifest with ZERO permissions.
 *   3. Old rows must be gone (not just the unchanged ones — the explicit
 *      stale-clearing path is what was broken).
 *
 * If/when the harness gains a dev-server fixture, this spec should be
 * extended (or replaced) with a true load_dev_extension reload test.
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

// Mirrors ExtensionPermissions in haex-vault (see permissions.spec.ts).
interface EditablePermissions {
  database: PermissionEntry[] | null;
  filesystem: PermissionEntry[] | null;
  http: PermissionEntry[] | null;
  shell: PermissionEntry[] | null;
  filesync: PermissionEntry[] | null;
  spaces: PermissionEntry[] | null;
  identities: PermissionEntry[] | null;
}

const EMPTY_PERMISSIONS: EditablePermissions = {
  database: [],
  filesystem: [],
  http: [],
  shell: [],
  filesync: [],
  spaces: [],
  identities: [],
};

function countEntries(perms: EditablePermissions): number {
  const lists: (PermissionEntry[] | null | undefined)[] = [
    perms.database,
    perms.filesystem,
    perms.http,
    perms.shell,
    perms.filesync,
    perms.spaces,
    perms.identities,
  ];
  return lists.reduce((acc, list) => acc + (list?.length ?? 0), 0);
}

test.describe("extensions: replace_permissions clears stale rows (dev reload analogue)", () => {
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
    if (originalPermissions) {
      await vault.invokeTauriCommand("update_extension_permissions", {
        extensionId,
        permissions: originalPermissions,
      });
    }
  });

  test("update to zero-permissions clears prior db.read.haex_* row", async () => {
    // 1. Seed a non-trivial permission set, mimicking what a dev manifest
    //    with `database: [{ target: "haex_*" }]` would produce.
    const seeded: EditablePermissions = {
      ...originalPermissions,
      database: [{ target: "haex_*", status: "granted" }],
    };
    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: seeded,
    });

    const readBackSeeded = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId },
    );
    const seededDb = readBackSeeded.database ?? [];
    expect(seededDb.some((p) => p.target === "haex_*")).toBe(true);

    // 2. Simulate the reload-with-zero-permissions case that Task 13 fixed.
    //    Pre-#529, the empty-set branch in load_dev_extension would skip
    //    delete_permissions entirely; here we drive the same code path via
    //    update_extension_permissions, which post-#529 always routes through
    //    PermissionManager::replace_permissions (the atomic helper).
    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: EMPTY_PERMISSIONS,
    });

    // 3. Stale rows must be gone.
    const cleared = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId },
    );
    const clearedDb = cleared.database ?? [];
    expect(clearedDb.some((p) => p.target === "haex_*")).toBe(false);
    expect(countEntries(cleared)).toEqual(0);
  });

  test("subsequent re-seed installs cleanly (no leftover rows from prior state)", async () => {
    // Re-seeds a different category (http) after the database clear and
    // asserts the database category stays empty — guards against the
    // cleared haex_* row resurrecting on the next update.
    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: EMPTY_PERMISSIONS,
    });

    const reSeeded: EditablePermissions = {
      ...EMPTY_PERMISSIONS,
      http: [{ target: "https://e2e-reload.example.com/*", status: "granted" }],
    };

    await vault.invokeTauriCommand("update_extension_permissions", {
      extensionId,
      permissions: reSeeded,
    });

    const readBack = await vault.invokeTauriCommand<EditablePermissions>(
      "get_extension_permissions",
      { extensionId },
    );

    const httpTargets = (readBack.http ?? []).map((p) => p.target);
    expect(httpTargets).toContain("https://e2e-reload.example.com/*");
    // Database should still be empty — no resurrection of the prior haex_*.
    expect(readBack.database ?? []).toEqual([]);
  });
});
