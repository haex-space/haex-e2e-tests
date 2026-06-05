import type { VaultAutomation } from "../../fixtures";
import { pollUntil, wait } from "./utils";
import { clickTestId, elementExists } from "./ui-primitives";

const SKIP = '[data-testid="publishing-skip"]';

/**
 * Dismiss the SpacePublishingDialog if it is currently open.
 *
 * The dialog is opened automatically by the vault after:
 *   - `spacesStore.createLocalSpaceAsync` (settings → spaces → Create) and
 *   - `acceptLocalInvite` (invite-claim flow),
 * via `useSpacePublishingStore().openForNewSpace(spaceId)`. It is a UiDrawerModal
 * that overlays the active route. Specs that drive UI after either of those
 * actions need to dismiss it so subsequent clicks reach the page underneath.
 *
 * Version-tolerant: if the dialog doesn't appear within `waitMs`, resolves to
 * `false`. The dialog can also pop in late due to Vue reactivity (the trigger
 * fires synchronously after `createLocalSpaceAsync` resolves, but the drawer's
 * mount + open transition can land a few frames later) — `waitMs` is the budget
 * for waiting it out.
 */
export async function dismissPublishingDialog(
  vault: VaultAutomation,
  opts: { waitMs?: number; timeout?: number } = {},
): Promise<boolean> {
  const { waitMs = 1000, timeout = 5000 } = opts;

  const appeared = await pollUntil(
    () => elementExists(vault, SKIP),
    { timeout: waitMs, interval: 100, label: "publishing dialog open" },
  ).catch(() => false);
  if (!appeared) return false;

  // Click Skip and poll until the dialog tears down. Reka's UiDrawerModal
  // close has an animation, so the testid lingers briefly after the click.
  await pollUntil(
    async () => {
      await clickTestId(vault, "publishing-skip");
      await wait(200);
      return !(await elementExists(vault, SKIP));
    },
    { timeout, interval: 300, label: "publishing dialog closed" },
  );

  return true;
}
