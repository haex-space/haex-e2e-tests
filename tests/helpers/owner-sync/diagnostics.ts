import type { VaultAutomation } from "../../fixtures";

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
        dialogText: dialog ? (dialog as HTMLElement).innerText.slice(0, 600) : null,
        toastText: toast ? (toast as HTMLElement).innerText.slice(0, 400) : null,
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
