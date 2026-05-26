import type { VaultAutomation } from "../../../fixtures";

/** Click a <button> whose visible text matches one of `labels`. */
export async function clickButton(
  vault: VaultAutomation,
  ...labels: string[]
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const labels = ${JSON.stringify(labels)};
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    for (const label of labels) {
      const btn = btns.find(b => {
        const t = b.textContent?.trim();
        return t === label || t?.includes(label);
      });
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  `);
}

/** Click a button inside a specific container (scoped). */
export async function clickButtonIn(
  vault: VaultAutomation,
  containerSelector: string,
  ...labels: string[]
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const container = document.querySelector('${containerSelector}');
    if (!container) return false;
    const labels = ${JSON.stringify(labels)};
    const btns = [...container.querySelectorAll('button, [role="button"]')];
    for (const label of labels) {
      const btn = btns.find(b => {
        const t = b.textContent?.trim();
        return t === label || t?.includes(label);
      });
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    return false;
  `);
}

/** Click element by data-testid. */
export async function clickTestId(vault: VaultAutomation, testId: string): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="${testId}"]');
    if (el) { el.click(); return true; }
    return false;
  `);
}

/** Set the value of an <input> using the native setter (triggers Vue reactivity). */
export async function setInputValue(
  vault: VaultAutomation,
  selector: string,
  value: string,
  container = "document",
): Promise<void> {
  await vault.executeScript(`
    const root = ${container === "document" ? "document" : `document.querySelector('${container}')`};
    const input = root?.querySelector('${selector}');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  `);
}

/** Check whether an element matching `selector` exists in the DOM. */
export async function elementExists(vault: VaultAutomation, selector: string): Promise<boolean> {
  return vault.executeScript<boolean>(
    `return !!document.querySelector('${selector}');`,
  );
}
