import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { VaultAutomation } from "../../fixtures";
import { wait } from "../ui/utils";

/**
 * Per-container vaults directory. Resolved by Tauri's `BaseDirectory::AppLocalData`
 * and pinned by the docker image to `$HOME=/root`. Mirrored in haex-vault's
 * `database::get_vaults_directory` (`src-tauri/src/database/mod.rs`).
 */
const VAULT_DIR_IN_CONTAINER = "/root/.local/share/space.haex.vault/vaults";

/**
 * Shared docker volume `vault-exchange` mounted on both vault-a and vault-b
 * at `/exchange`. Defined in `docker/docker-compose.yml`. This is the bridge
 * between the two container filesystems; it's the only way a test inside
 * vault-a's container can hand a file to vault-b without `docker cp`.
 */
const EXCHANGE_DIR = "/exchange";

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
 * - `from` has the vault open (so we can call close_database on it).
 * - The test process runs INSIDE `from`'s container (so Node `fs` sees
 *   `from`'s vaults directory directly). This matches the standard
 *   playwright entrypoint via `vault-a`. Calling from outside will fail
 *   the local `copyFile` with ENOENT.
 *
 * @returns the staged path inside the shared volume (caller-owned cleanup).
 */
export async function copyVaultToDevice(
  from: VaultAutomation,
  to: VaultAutomation,
  vaultName: string,
): Promise<string> {
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

  const sourcePath = path.join(VAULT_DIR_IN_CONTAINER, `${vaultName}.db`);
  const exchangePath = path.join(EXCHANGE_DIR, `${vaultName}.db`);

  await mkdir(EXCHANGE_DIR, { recursive: true });
  await copyFile(sourcePath, exchangePath);

  // 2. import_vault accepts arbitrary paths (no Tauri scope check — see
  // `src-tauri/src/database/mod.rs:262`), copies the file into the target's
  // vaults/ directory, and surfaces it through the next `list_vaults` call.
  await to.invokeTauriCommand<string>("import_vault", {
    source_path: exchangePath,
    vault_name: vaultName,
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
