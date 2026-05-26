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

// Shared JS snippet that dispatches the full reka-ui-compatible activation
// sequence on `el`. reka-ui primitives (DropdownMenuTrigger, ComboboxTrigger,
// ComboboxItem, TabsTrigger, …) react to pointerdown/mousedown — not to
// `.click()` — and items additionally need pointerup before mouseup for the
// selection to register. Keeping all five events here means we only get this
// gotcha right in one place.
const REKA_CLICK_SEQUENCE = `
  el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  el.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  el.click?.();
`;

/**
 * Activate a reka-ui primitive (trigger/item) via the full mousedown+click
 * sequence. Use this instead of `clickTestId` for ComboboxTrigger,
 * DropdownMenuTrigger, TabsTrigger, ComboboxItem, MenuItem, etc.
 */
export async function mousedownClickTestId(
  vault: VaultAutomation,
  testId: string,
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    ${REKA_CLICK_SEQUENCE}
    return true;
  `);
}

/** Same as `mousedownClickTestId` but takes an arbitrary CSS selector. */
export async function mousedownClickSelector(
  vault: VaultAutomation,
  selector: string,
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    ${REKA_CLICK_SEQUENCE}
    return true;
  `);
}

/**
 * Like `mousedownClickSelector` but resolves the target element inside an
 * `executeScript` block — useful when the element must be located by a
 * predicate (e.g. textContent match) rather than a static selector.
 *
 * `finderExpression` runs in the page and must evaluate to an Element or null.
 */
export async function mousedownClickFound(
  vault: VaultAutomation,
  finderExpression: string,
): Promise<boolean> {
  return vault.executeScript<boolean>(`
    const el = (() => { ${finderExpression} })();
    if (!el) return false;
    ${REKA_CLICK_SEQUENCE}
    return true;
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
