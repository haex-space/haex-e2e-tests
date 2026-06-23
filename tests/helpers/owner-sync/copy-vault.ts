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
 * Find a vault file on disk by name via the `list_vaults` Tauri command.
 * `list_vaults` is on the proven webview ACL surface — `get_vaults_directory`
 * is not (a CI failure confirmed it). Returns null when the vault doesn't
 * exist on this container, which is informative rather than fatal: the
 * caller decides whether absence is OK.
 */
async function findVaultPath(
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
 * Vault names must be UNIQUE across the rig (per haex-vault's data model)
 * — callers should derive them from `Date.now()` so a retry's freshly
 * created vault doesn't collide with leftover state from a prior attempt.
 *
 * After this returns the target vault is staged but NOT opened — call
 * `initializeVaultViaUI(to, vaultName, password)` next to unlock it
 * through the existing welcome-dialog flow.
 *
 * Preconditions:
 * - `from` has the vault open (so `list_vaults` resolves its path).
 * - `to` does NOT already have a vault named `vaultName` (import_vault
 *   fails `VaultAlreadyExists` if it does — unique names per run avoid
 *   that automatically).
 * - The test process runs INSIDE `from`'s container (so Node `fs` sees
 *   `from`'s vaults directory directly).
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
  // Args use camelCase (Tauri v2 default for `#[tauri::command]` without
  // `rename_all`).
  await to.invokeTauriCommand<string>("import_vault", {
    sourcePath: exchangePath,
    vaultName,
  });

  return exchangePath;
}

/**
 * Remove a previously-staged vault from the shared `/exchange` volume.
 * The volume itself persists across `docker compose down`, so specs that
 * use a `vaultName` should call this in their teardown — even unique names
 * (Date.now()) would accumulate stale files over many CI runs without it.
 * Best-effort — silently swallows ENOENT.
 */
export async function clearExchangedVault(vaultName: string): Promise<void> {
  await rm(path.join(EXCHANGE_DIR, `${vaultName}.db`), { force: true });
}
