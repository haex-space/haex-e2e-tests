import type { VaultAutomation } from "../../fixtures";
import { pollUntil, wait } from "./utils";
import { clickTestId, elementExists, setInputValue } from "./ui-primitives";

const USER_NAME = '[data-testid="welcome-user-name"]';
const DEVICE_NAME = '[data-testid="welcome-device-name"]';
const TOUR_SKIP = '[data-testid="welcome-tour-skip"]';

/**
 * True when the redesigned WelcomeDialog (Step 1: name + device) is on screen.
 * Absence is the version-guard for vault builds that still use the old silent
 * device auto-register / reconciliation dialog.
 */
export async function isWelcomeDialogPresent(vault: VaultAutomation): Promise<boolean> {
  return elementExists(vault, USER_NAME);
}

/**
 * Drive the redesigned WelcomeDialog to completion against a real vault:
 * fill the name + device fields (Step 1 — which registers the haex_devices
 * row, replacing the old silent auto-register), then skip the tour offer
 * (Step 2) so the desktop is unblocked for downstream interactions.
 *
 * Version-tolerant: if the dialog never appears within `timeout` (e.g. a vault
 * build without the redesign, or a vault that already has a device row), it
 * resolves to `false` without throwing — callers treat that as "nothing to do".
 */
export async function completeWelcomeOnboarding(
  vault: VaultAutomation,
  opts: { userName?: string; deviceName?: string; timeout?: number } = {},
): Promise<boolean> {
  const { userName = "E2E User", deviceName = "e2e-device", timeout = 8000 } = opts;

  const appeared = await pollUntil(() => isWelcomeDialogPresent(vault), {
    timeout,
    interval: 500,
    label: "welcome dialog (step 1)",
  }).catch(() => false);
  if (!appeared) return false;

  await setInputValue(vault, "input", userName, USER_NAME);
  await setInputValue(vault, "input", deviceName, DEVICE_NAME);
  await wait(200);

  // Step 1 → Step 2: clicking Continue registers the device row. Retry until
  // the tour-offer step renders — the button is disabled until both fields
  // hold a value, so an early click is a harmless no-op.
  await pollUntil(
    async () => {
      await clickTestId(vault, "welcome-next");
      await wait(300);
      return elementExists(vault, TOUR_SKIP);
    },
    { timeout: 10_000, interval: 500, label: "welcome step 2 (tour offer)" },
  );

  // Skip the tour → the dialog closes.
  await pollUntil(
    async () => {
      await clickTestId(vault, "welcome-tour-skip");
      await wait(300);
      return !(await elementExists(vault, TOUR_SKIP));
    },
    { timeout: 10_000, interval: 500, label: "welcome dialog closed" },
  );

  return true;
}
