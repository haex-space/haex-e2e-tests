import type { VaultAutomation } from "../../fixtures";
import { pollUntil, wait } from "./utils";
import { clickTestId, elementExists, setInputValue } from "./ui-primitives";

const USER_NAME = '[data-testid="welcome-user-name"]';
const DEVICE_NAME = '[data-testid="welcome-device-name"]';
const NEXT = '[data-testid="welcome-next"]';
const TOUR_SKIP = '[data-testid="welcome-tour-skip"]';

/** Whether the Continue button is currently disabled (native or aria). */
function nextDisabled(vault: VaultAutomation): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const b = document.querySelector(${JSON.stringify(NEXT)});
    return !!b && (b.disabled === true || b.getAttribute('aria-disabled') === 'true');
  `);
}

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

  // Wait for Vue's reactivity tick to flip canProceed → button enabled,
  // *then* click once. Avoids the brittle "click every 500 ms until Step 2
  // appears" pattern, which can race a re-validation cycle that briefly
  // re-disables the button.
  await pollUntil(
    async () => !(await nextDisabled(vault)),
    { timeout: 5_000, interval: 100, label: "welcome-next enabled" },
  );
  await clickTestId(vault, "welcome-next");

  // Step 1 → Step 2: clicking Continue registers the device row.
  await pollUntil(
    () => elementExists(vault, TOUR_SKIP),
    { timeout: 10_000, interval: 250, label: "welcome step 2 (tour offer)" },
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
