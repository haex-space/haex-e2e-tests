import { test, expect, VaultAutomation } from "../fixtures";
import { wait, pollUntil } from "../helpers/ui/utils";
import { elementExists, mousedownClickFound } from "../helpers/ui/ui-primitives";

/**
 * Regression test for the password import dialogs (Bitwarden / LastPass / KeePass).
 *
 * PR #520 refactored the three importers to share a generic
 * ImportWizardShell.vue. Each importer's template referenced it as the SHORT
 * name `<ImportWizardShell>`, but Nuxt auto-imports components with their
 * path-prefixed name (HaexSystemPasswordsImportWizardShell). The mismatch made
 * Vue render an unresolved custom HTML element `<importwizardshell>` — no
 * error, no dialog, the import menu items were silently dead.
 *
 * Coverage:
 *   1. The DOM must not contain an unresolved `<importwizardshell>` element.
 *   2. Clicking each import menu entry must surface a visible drawer modal.
 */
test.describe("ui: passwords import dialogs (regression for #520)", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;

  const openPasswordsWindow = async (): Promise<boolean> => {
    return vault.executeScript<boolean>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const wm = pinia?._s?.get('windowManager');
      if (!wm?.openWindowAsync) return false;
      try {
        await wm.openWindowAsync({ sourceId: 'passwords', type: 'system' });
        return true;
      } catch (_) {
        return false;
      }
    `);
  };

  const closePasswordsWindow = async (): Promise<void> => {
    await vault.executeScript(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const wm = pinia?._s?.get('windowManager');
      if (!wm) return;
      const wins = (wm.currentWorkspaceWindows || []).slice();
      for (const w of wins) {
        const sid = w.sourceId || w.tabs?.[0]?.sourceId;
        if (sid === 'passwords') {
          try { wm.closeWindow(w.id); } catch (_) {}
        }
      }
    `);
  };

  // The "More" dropdown trigger in the passwords header carries aria-label
  // "More" (en) / "Mehr" (de). The locale is decided by the browser default,
  // so the test matches either.
  const MORE_BUTTON_SELECTOR =
    'button[aria-label="More"], button[aria-label="Mehr"]';

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    const opened = await openPasswordsWindow();
    expect(opened).toBe(true);

    // Wait for the passwords header (which owns the import dialogs) to mount.
    await pollUntil(() => elementExists(vault, MORE_BUTTON_SELECTOR), {
      timeout: 10_000,
      label: "passwords header more-button visible",
    });
  });

  test.afterAll(async () => {
    // Vault A is shared across the suite — make sure we don't leave the
    // passwords window open for downstream tests.
    await closePasswordsWindow();
  });

  test("no unresolved <importwizardshell> elements in the DOM", async () => {
    // Direct bug signature. If <ImportWizardShell> fails to resolve, Vue
    // renders the lowercase custom element instead. The element is always
    // present in the rendered header (3 instances, one per importer), so
    // a single document-wide query suffices.
    const count = await vault.executeScript<number>(
      `return document.querySelectorAll('importwizardshell').length;`,
    );
    expect(count).toBe(0);
  });

  for (const variant of ["Bitwarden", "LastPass", "KeePass"] as const) {
    test(`opens the ${variant} import dialog`, async () => {
      // Step 1 — open the more menu (Reka UI dropdown needs the full
      // pointerdown+mousedown+pointerup+mouseup sequence, not a plain click).
      const moreOpened = await mousedownClickFound(
        vault,
        `return document.querySelector(${JSON.stringify(MORE_BUTTON_SELECTOR)});`,
      );
      expect(moreOpened).toBe(true);

      await pollUntil(
        () => elementExists(vault, '[role="menuitem"]'),
        { timeout: 5_000, label: "more menu items visible" },
      );

      // Step 2 — click the variant's menu item. Match by textContent so we
      // stay locale-agnostic ("Import from Bitwarden" / "Import von Bitwarden").
      const itemClicked = await mousedownClickFound(
        vault,
        `
          const items = [...document.querySelectorAll('[role="menuitem"]')];
          return items.find(el => el.textContent?.includes(${JSON.stringify(variant)})) ?? null;
        `,
      );
      expect(itemClicked).toBe(true);

      // Step 3 — the drawer modal must become visible. Reka-UI / Nuxt UI
      // tags open dialogs with `data-state="open"`.
      const dialogVisible = await pollUntil(
        () =>
          elementExists(
            vault,
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          ),
        { timeout: 5_000, label: `${variant} dialog visible` },
      );
      expect(dialogVisible).toBe(true);

      // Step 4 — close the dialog so the next iteration starts from a clean
      // state. Escape closes Nuxt UI's UModal.
      await vault.executeScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
      );
      await wait(400);

      // Sanity-check that the dialog actually went away — otherwise the next
      // iteration's "dialog visible" assertion would always pass.
      const stillOpen = await elementExists(
        vault,
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
      expect(stillOpen).toBe(false);
    });
  }
});
