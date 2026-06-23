import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { VaultAutomation } from "../../fixtures";
import { wait } from "../ui/utils";

/**
 * Shared docker volume `vault-exchange` mounted on both vault-a and vault-b
 * at `/exchange`. Defined in `docker/docker-compose.yml`. This is the bridge
 * between the two container filesystems; it's the only way a test inside
 * vault-a's container can hand a file to vault-b without `docker cp`.
 */
const EXCHANGE_DIR = "/exchange";

interface VaultInfoEntry {
  name: string;
  lastAccess: number;
  path: string;
}

/**
 * Path to a vault file on disk via the Tauri-side `list_vaults` command.
 *
 * `list_vaults` is the always-allowed lookup the standard
 * `initializeVaultViaUI` helper already uses. `get_vaults_directory` would
 * be the obvious shorter route, but it's not on the webview ACL — confirmed
 * by a CI failure: `Command get_vaults_directory not allowed by ACL`.
 *
 * Returns null when the vault does not exist on this container (e.g. before
 * creation, or after a successful cleanup). Callers should treat that as
 * "nothing to copy / nothing to delete".
 */
export async function findVaultPath(
  vault: VaultAutomation,
  vaultName: string,
): Promise<string | null> {
  const vaults = await vault.invokeTauriCommand<VaultInfoEntry[]>(
    "list_vaults",
    {},
  );
  return vaults.find((v) => v.name === vaultName)?.path ?? null;
}

/**
 * Close any open vault and remove the named vault's `.db` from this
 * container's vaults directory. Idempotent — safe to call when no vault
 * is open and no file exists (covers both first-run and retry scenarios).
 *
 * Playwright reruns the entire `describe.serial` block on retry, so a test
 * that creates a vault in step 1 + copies in step 2 will, on the second
 * attempt, try to create on top of the leftover .db (or to copy onto a
 * target that already has the file). Calling this in `beforeAll` makes the
 * whole describe block reentrant.
 *
 * Uses Node `fs.rm` instead of a Tauri `delete_vault` command for the same
 * reason `findVaultPath` uses `list_vaults` — staying inside the proven
 * ACL surface.
 */
export async function resetVaultOnDevice(
  vault: VaultAutomation,
  vaultName: string,
): Promise<void> {
  // close_database is safe to call when no vault is mounted (returns an
  // error which we swallow); navigateTo("/") matches the same
  // close→navigate-back pattern as `tests/ui/welcome-dialog.spec.ts:46-48`.
  await vault.invokeTauriCommand("close_database", {}).catch(() => {});
  await vault.navigateTo("/").catch(() => {});
  await wait(500);

  const existing = await findVaultPath(vault, vaultName);
  if (existing) {
    await rm(existing, { force: true });
    // Best-effort: SQLite leaves WAL/SHM siblings the OS will clean on next
    // open, but removing them keeps a stale partial vault from being
    // surfaced by `list_vaults` in the next run.
    await rm(`${existing}-wal`, { force: true }).catch(() => {});
    await rm(`${existing}-shm`, { force: true }).catch(() => {});
  }
}

/**
 * Replicate a vault from one container's filesystem to another via the
 * shared `/exchange` volume. Mirrors the real-world "I copied my vault to a
 * new device" flow: the source binary closes the file (clean snapshot,
 * WAL collapsed into the main `.db`), the test stages it in `/exchange`,
 * and the target binary ingests it via its own `import_vault` Tauri
 * command — exactly the code path a UI "Import vault" button would call.
 *
 * Each container has its own iroh secret key in its own filesystem, so the
 * copied vault picks up a NEW `endpoint_id` on the target device. That is
 * the whole point: same owner DID, different device.
 *
 * After this returns the target vault is staged but NOT opened — call
 * `initializeVaultViaUI(to, vaultName, password)` next to unlock it
 * through the existing welcome-dialog flow.
 *
 * Preconditions:
 * - `from` has the vault open (so `list_vaults` can resolve its path).
 * - `to` does NOT already have a vault with this name (import_vault fails
 *   `VaultAlreadyExists` if it does). Call `resetVaultOnDevice(to, name)`
 *   in `beforeAll` to guarantee this in the face of Playwright retries.
 * - The test process runs INSIDE `from`'s container (so Node `fs` sees
 *   `from`'s vaults directory directly). This matches the standard
 *   playwright entrypoint via `vault-a`.
 *
 * @returns the staged path inside the shared volume (caller-owned cleanup).
 */
export async function copyVaultToDevice(
  from: VaultAutomation,
  to: VaultAutomation,
  vaultName: string,
): Promise<string> {
  const sourcePath = await findVaultPath(from, vaultName);
  if (!sourcePath) {
    throw new Error(
      `copyVaultToDevice: vault "${vaultName}" not found on ${from.getInstance()}`,
    );
  }

  // 1. Make the source `.db` canonical. close_database flushes the WAL into
  // the main file and releases the file handle, so the next copyFile sees a
  // self-consistent snapshot. Without this the WAL/SHM siblings would carry
  // unmaterialized writes that `import_vault` (which only takes a `.db`
  // path) would silently ignore.
  await from.invokeTauriCommand<void>("close_database", {});

  // close_database tears down the AppState but does NOT navigate the WebView
  // away from the now-stale /vault/... URL — so a follow-up
  // `initializeVaultViaUI` would short-circuit on the cached location. Reset
  // it here so the caller can re-open without bookkeeping the navigation.
  // Mirrors the pattern in `tests/ui/welcome-dialog.spec.ts:46-48`.
  await from.navigateTo("/");
  await wait(1000);

  const exchangePath = path.join(EXCHANGE_DIR, `${vaultName}.db`);
  await mkdir(EXCHANGE_DIR, { recursive: true });
  await copyFile(sourcePath, exchangePath);

  // 2. import_vault accepts arbitrary paths (no Tauri scope check — see
  // `src-tauri/src/database/mod.rs:262`), copies the file into the target's
  // vaults/ directory, and surfaces it through the next `list_vaults` call.
  // Args use camelCase: Tauri v2's default arg-naming for `#[tauri::command]`
  // (no `rename_all` attribute on import_vault) — sending snake_case fails
  // with "missing required key sourcePath".
  await to.invokeTauriCommand<string>("import_vault", {
    sourcePath: exchangePath,
    vaultName,
  });

  return exchangePath;
}

/**
 * Remove a previously-staged vault from the shared `/exchange` volume.
 * The volume itself persists across `docker compose down`, so specs that
 * use the same `vaultName` across runs must call this in their teardown.
 * Best-effort — silently swallows ENOENT.
 */
export async function clearExchangedVault(vaultName: string): Promise<void> {
  await rm(path.join(EXCHANGE_DIR, `${vaultName}.db`), { force: true });
}
