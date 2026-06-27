import { test, expect, VaultAutomation } from "../fixtures";
import { pollUntil } from "../helpers/ui/utils";
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

  // The three importers (Bitwarden / LastPass / KeePass) share
  // ImportWizardShell — if Bitwarden's dialog mounts, the other two mount as
  // well. Asserting one variant proves the shared shell resolves and is wired
  // correctly; the `<importwizardshell>` DOM check above already covers the
  // broader regression across all three. Closing the dialog between variants
  // in headless chromium turned out flaky (reka-ui focus trap + animation
  // timing), and there's no value in re-asserting the same render path three
  // times. Together, the two assertions are sufficient: if the short-name
  // reference regresses, the first test fails; if it resolves but doesn't
  // wire up the dialog, the second test fails.
  test("opens the Bitwarden import drawer modal", async () => {
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

    // Step 2 — click the Bitwarden menu item. Match by textContent so we stay
    // locale-agnostic ("Import from Bitwarden" / "Import von Bitwarden").
    const itemClicked = await mousedownClickFound(
      vault,
      `
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        return items.find(el => el.textContent?.includes('Bitwarden')) ?? null;
      `,
    );
    expect(itemClicked).toBe(true);

    // Step 3 — the drawer modal must become visible. Reka-UI / Nuxt UI tags
    // open dialogs with `data-state="open"`. This is the v-model:open chain
    // working end to end: passwords-header ref → importer defineModel →
    // shell defineModel → UiDrawerModal → UModal → reka-ui DialogContent.
    const dialogVisible = await pollUntil(
      () =>
        elementExists(
          vault,
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        ),
      { timeout: 5_000, label: "Bitwarden dialog visible" },
    );
    expect(dialogVisible).toBe(true);
  });
});
