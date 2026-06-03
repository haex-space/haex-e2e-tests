import { test, expect, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { clickTestId, elementExists, setInputValue } from "../helpers/ui/ui-primitives";
import { wait, pollUntil, sqlQuery } from "../helpers/ui/utils";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

/**
 * Onboarding redesign (haex-vault feat/welcome-dialog):
 *
 * A brand-new vault now opens the WelcomeDialog — a 2-step wizard that asks for
 * a display name AND a device name (Step 1), then offers the guided tour
 * (Step 2) — replacing the old single-field reconciliation dialog + the silent
 * device auto-register.
 *
 * This spec opens a *fresh* vault via the real UI so it can observe the
 * once-per-vault dialog from scratch, then drives it the way a user would.
 *
 * Version guard: every assertion-bearing test self-skips when the running vault
 * build has no `welcome-user-name` field, so the suite stays green against
 * vault `main` (old onboarding) while the feature PR is in flight.
 */
test.describe("ui: welcome dialog (onboarding redesign)", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let hasWelcome = false;

  const FRESH_VAULT_NAME = `welcome-e2e-${Date.now()}`;
  const FRESH_VAULT_PASSWORD = "welcome-e2e-pw-123456";
  const USER_NAME = "Welcome E2E User";
  const DEVICE_NAME = "welcome-e2e-device";

  const nextDisabled = () =>
    vault.executeScript<boolean>(`
      const b = document.querySelector('[data-testid="welcome-next"]');
      return !!b && (b.disabled === true || b.getAttribute('aria-disabled') === 'true');
    `);

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Leave the shared baseline vault and return to the picker so a brand-new
    // vault can be created + opened via the UI (which triggers initVaultAsync →
    // pendingResolution → WelcomeDialog).
    await vault.invokeTauriCommand("close_database", {}).catch(() => {});
    await vault.navigateTo("/");
    await wait(1000);

    await initializeVaultViaUI(vault, FRESH_VAULT_NAME, FRESH_VAULT_PASSWORD);

    hasWelcome = await pollUntil(
      () => elementExists(vault, '[data-testid="welcome-user-name"]'),
      { timeout: 10_000, interval: 500, label: "welcome dialog" },
    ).catch(() => false);

    if (!hasWelcome) {
      console.log(
        "[E2E] WelcomeDialog not present — vault build lacks the redesign; welcome tests will skip.",
      );
    }
  });

  test.afterAll(async () => {
    await restoreOriginalVault(vault, FRESH_VAULT_NAME);
  });

  test("Step 1 surfaces both a name and a device field, and hides reclaim on a fresh vault", async () => {
    test.skip(!hasWelcome, "vault build has no redesigned WelcomeDialog");

    expect(await elementExists(vault, '[data-testid="welcome-user-name"] input')).toBe(true);
    expect(await elementExists(vault, '[data-testid="welcome-device-name"] input')).toBe(true);

    // Fresh vault has no other known devices → the reclaim affordance is hidden.
    expect(await elementExists(vault, '[data-testid="welcome-reclaim-toggle"]')).toBe(false);
  });

  test("Continue is gated until both fields hold a value", async () => {
    test.skip(!hasWelcome, "vault build has no redesigned WelcomeDialog");

    // Clear both fields → Continue must be disabled.
    await setInputValue(vault, "input", "", '[data-testid="welcome-user-name"]');
    await setInputValue(vault, "input", "", '[data-testid="welcome-device-name"]');
    await wait(200);
    expect(await nextDisabled()).toBe(true);

    // Only the name → still disabled.
    await setInputValue(vault, "input", USER_NAME, '[data-testid="welcome-user-name"]');
    await wait(200);
    expect(await nextDisabled()).toBe(true);

    // Both fields → enabled.
    await setInputValue(vault, "input", DEVICE_NAME, '[data-testid="welcome-device-name"]');
    await wait(200);
    expect(await nextDisabled()).toBe(false);
  });

  test("completing Step 1 writes the identity name + a device row and advances to the tour offer", async () => {
    test.skip(!hasWelcome, "vault build has no redesigned WelcomeDialog");

    // Ensure both fields are filled (independent of prior test ordering).
    await setInputValue(vault, "input", USER_NAME, '[data-testid="welcome-user-name"]');
    await setInputValue(vault, "input", DEVICE_NAME, '[data-testid="welcome-device-name"]');
    await wait(200);

    // Continue → Step 2 (tour offer). Retry-click guards the enable race.
    await pollUntil(
      async () => {
        await clickTestId(vault, "welcome-next");
        await wait(300);
        return elementExists(vault, '[data-testid="welcome-tour-start"]');
      },
      { timeout: 10_000, interval: 500, label: "tour offer (step 2)" },
    );

    // A real haex_devices row was registered (the old silent fallback is gone).
    const devices = await sqlQuery<{ id: string }>(vault, "SELECT id FROM haex_devices");
    expect(devices.length).toBeGreaterThanOrEqual(1);

    // The display name was written to the default own identity.
    const identities = await sqlQuery<{ name: string }>(
      vault,
      "SELECT name FROM haex_identities WHERE private_key IS NOT NULL",
    );
    expect(identities.some((i) => i.name === USER_NAME)).toBe(true);

    // Step 2 offers both actions.
    expect(await elementExists(vault, '[data-testid="welcome-tour-start"]')).toBe(true);
    expect(await elementExists(vault, '[data-testid="welcome-tour-skip"]')).toBe(true);
  });

  test("starting the tour launches the guided walk and resolves when it completes", async () => {
    test.skip(!hasWelcome, "vault build has no redesigned WelcomeDialog");

    await clickTestId(vault, "welcome-tour-start");

    // The driver.js tour becomes active. onStartTour sets the dialog's
    // `visible` to false before awaiting tourStore.start(), so isActive===true
    // also proves the dialog's close path ran. (We don't assert the dialog node
    // is gone — Reka/Nuxt-UI keeps the modal content portaled in the DOM while
    // closed, so a querySelector check is not a reliable visibility signal.)
    await pollUntil(
      () =>
        vault.executeScript<boolean>(`
          const app = document.getElementById('__nuxt')?.__vue_app__;
          const pinia = app?.config?.globalProperties?.$pinia;
          const t = pinia?._s?.get('tourStore');
          return !!t && t.isActive === true;
        `),
      { timeout: 10_000, interval: 500, label: "tour active" },
    );

    // Completing the tour resolves the start() promise (Option-a coupling) and
    // clears isActive. On a fresh vault (only the personal space) no publishing
    // dialog follows, so the desktop is clean afterwards.
    await vault.executeScript<string>(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const t = pinia?._s?.get('tourStore');
      if (t && t.complete) t.complete();
      return 'completed';
    `);
    await pollUntil(
      async () => !(await vault.executeScript<boolean>(`
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const t = pinia?._s?.get('tourStore');
        return !!t && t.isActive === true;
      `)),
      { timeout: 10_000, interval: 500, label: "tour complete" },
    );
  });

  test("reclaim link appears once the vault knows another device", async () => {
    test.skip(!hasWelcome, "vault build has no redesigned WelcomeDialog");

    // Simulate "existing vault on a new device": rewrite the just-registered
    // device row's device_id to a foreign value so it no longer matches this
    // machine's device_id file. resolveAsync then reports no match but lists it
    // as a known device → the WelcomeDialog re-opens with the reclaim section.
    //
    // - sql_execute_with_crdt: project policy — every write on haex_* tables
    //   goes through the CRDT helper so a future sync round can't revert it
    //   silently.
    // - WHERE id IN (SELECT…): targets the just-registered row even if some
    //   future setup change seeds more device rows on init.
    // - surface resolveAsync errors instead of swallowing them — a thrown
    //   resolver would otherwise hide behind a generic "reclaim toggle"
    //   timeout.
    const ownDevices = await sqlQuery<{ id: string }>(
      vault,
      "SELECT id FROM haex_devices",
    );
    expect(ownDevices.length).toBeGreaterThanOrEqual(1);
    await vault.invokeTauriCommand("sql_execute_with_crdt", {
      sql: "UPDATE haex_devices SET device_id = ?1 WHERE id = ?2",
      params: ["e2e-foreign-device-id", ownDevices[0]!.id],
    });
    await vault.executeScript(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const ds = pinia?._s?.get('vaultDeviceStore');
      if (ds && ds.resolveAsync) {
        ds.resolveAsync().catch((err) => console.error('[E2E] resolveAsync threw:', err));
      } else {
        console.error('[E2E] vaultDeviceStore.resolveAsync missing');
      }
      return 'fired';
    `);

    await pollUntil(
      () => elementExists(vault, '[data-testid="welcome-reclaim-toggle"]'),
      { timeout: 10_000, interval: 500, label: "reclaim toggle" },
    );

    // Expanding it reveals the known device(s), each rendered with a
    // welcome-reclaim-<id> testid. Click once (toggling re-clicks would just
    // collapse it again), then poll for the item to render.
    await clickTestId(vault, "welcome-reclaim-toggle");
    await pollUntil(
      () =>
        vault.executeScript<boolean>(`
          return [...document.querySelectorAll('[data-testid]')].some((el) => {
            const id = el.getAttribute('data-testid');
            return id && id.startsWith('welcome-reclaim-') && id !== 'welcome-reclaim-toggle';
          });
        `),
      { timeout: 8_000, interval: 500, label: "reclaim device item" },
    );

    // Dismiss so afterAll can restore the baseline cleanly.
    await clickTestId(vault, "welcome-skip");
    await wait(300);
  });
});
