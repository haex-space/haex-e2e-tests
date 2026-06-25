import type { VaultAutomation } from "../../fixtures";
import { sqlQuery } from "../ui/utils";

/**
 * Capture a snapshot of the visible UI state on the given vault and emit
 * it as a single `[E2E-DIAG ...]` stdout line. Cheap to call (one
 * executeScript round-trip) and lossless enough to reason about what was
 * on screen at a failure point — buttons, inputs, dialog presence,
 * visible body text — without having to download trace artifacts.
 *
 * Designed for the close → navigate → reopen scenario where the timeout
 * is on `pollUntil(/vault/)` and Playwright's own trace cannot capture
 * the tauri-driver WebView state.
 */
export async function snapshotUi(
  vault: VaultAutomation,
  label: string,
): Promise<void> {
  try {
    const snap = await vault.executeScript<Record<string, unknown>>(`(() => {
      const buttons = [...document.querySelectorAll('button')]
        .map(b => ({
          text: (b.textContent || '').trim().slice(0, 80),
          disabled: b.disabled,
          testid: b.getAttribute('data-testid'),
        }))
        .filter(b => b.text);
      const inputs = [...document.querySelectorAll('input')]
        .map(i => ({
          type: i.type,
          placeholder: i.placeholder,
          testid: i.getAttribute('data-testid'),
          valueFilled: i.value ? true : false,
        }));
      const dialog = document.querySelector('[role="dialog"]');
      const toast = document.querySelector('[role="alert"], [role="status"]');
      return {
        href: location.href,
        title: document.title,
        bodyHeader: (document.body.innerText || '').slice(0, 1000),
        buttonCount: buttons.length,
        buttons: buttons.slice(0, 25),
        inputs: inputs.slice(0, 12),
        dialogOpen: !!dialog,
        dialogText: dialog ? (dialog.innerText || '').slice(0, 600) : null,
        toastText: toast ? (toast.innerText || '').slice(0, 400) : null,
      };
    })()`);
    console.log(
      `[E2E-DIAG ${label} ${vault.getInstance()}] ${JSON.stringify(snap)}`,
    );
  } catch (err) {
    console.log(
      `[E2E-DIAG ${label} ${vault.getInstance()}] (snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

interface PeerStorageStatus {
  running: boolean;
  nodeId?: string | null;
  connectedPeers?: string[] | null;
}

type DeviceRow = Record<string, unknown> & {
  endpoint_id?: string | null;
  device_id?: string | null;
  name?: string | null;
};

type IdentityRow = Record<string, unknown> & {
  did?: string | null;
  has_private_key?: number | null;
};

/**
 * Capture sync-relevant state (P2P endpoint + DB rows that drive owner-sync)
 * and emit it as a single `[E2E-SYNC ...]` stdout line. Designed to answer
 * "why didn't B see A's row" without trace artifacts: shows whether the P2P
 * endpoint is up, which peer endpoints either side knows about, and the
 * current row count on the table under test.
 *
 * No assertions — purely observational, so it can sit on every failure
 * path without changing test outcomes.
 */
export async function dumpSyncState(
  vault: VaultAutomation,
  label: string,
): Promise<void> {
  const instance = vault.getInstance();
  const out: Record<string, unknown> = { vault: instance };

  try {
    out.peerStorage = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {},
    );
  } catch (err) {
    out.peerStorage = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const devices = await sqlQuery<DeviceRow>(
      vault,
      "SELECT endpoint_id, device_id, name FROM haex_devices ORDER BY endpoint_id",
    );
    out.devices = devices.map((d) => ({
      endpoint_id: d.endpoint_id,
      device_id: d.device_id,
      name: d.name,
    }));
  } catch (err) {
    out.devices = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const identities = await sqlQuery<IdentityRow>(
      vault,
      "SELECT did, (private_key IS NOT NULL) AS has_private_key FROM haex_identities ORDER BY did",
    );
    out.identities = identities;
  } catch (err) {
    out.identities = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const passwords = await sqlQuery<{ id: string }>(
      vault,
      "SELECT id FROM haex_passwords_item_details ORDER BY id",
    );
    out.passwordIds = passwords.map((p) => p.id);
  } catch (err) {
    out.passwordIds = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  console.log(`[E2E-SYNC ${label} ${instance}] ${JSON.stringify(out)}`);
}

/**
 * Run a sync-related async block (typically a `pollUntil`) with a
 * `dumpSyncState` snapshot of BOTH vaults before AND on failure. Mirrors
 * `diagnosed()` but for sync-state queries instead of UI snapshots — the
 * timeout itself yields no clue about WHY the row didn't appear, so this
 * captures the surrounding state both sides actually see.
 */
export async function diagnosedSync<T>(
  vaults: { a: VaultAutomation; b: VaultAutomation },
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  await dumpSyncState(vaults.a, `${label}/BEFORE`);
  await dumpSyncState(vaults.b, `${label}/BEFORE`);
  try {
    return await fn();
  } catch (err) {
    await dumpSyncState(vaults.a, `${label}/ON_FAIL`);
    await dumpSyncState(vaults.b, `${label}/ON_FAIL`);
    throw err;
  }
}

/**
 * Run an async block with a UI snapshot before AND on failure. The
 * `BEFORE` snapshot tells us the starting state (e.g. did the click in a
 * previous step actually leave the UI on the picker, or did it short-
 * circuit because /vault/ was already in the URL). The `ON_FAIL` snapshot
 * captures whatever was on screen when the failure surfaced — typically
 * the answer to "the click went where?".
 */
export async function diagnosed<T>(
  vault: VaultAutomation,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  await snapshotUi(vault, `${label}/BEFORE`);
  try {
    return await fn();
  } catch (err) {
    await snapshotUi(vault, `${label}/ON_FAIL`);
    throw err;
  }
}
