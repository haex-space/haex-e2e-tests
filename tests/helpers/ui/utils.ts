import type { VaultAutomation } from "../../fixtures";
import type { JsonValue } from "./types";

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `fn` returns a truthy value, or throw after `timeout` ms. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 15_000, interval = 1_000, label = "condition" } = opts;
  const start = Date.now();
  let last: T;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await wait(interval);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeout}ms`);
}

/**
 * SQL helper — verification only, not for driving user actions.
 *
 * Parses the SELECT clause to map row arrays back to column-keyed objects so
 * test assertions can read by column name instead of index.
 */
export async function sqlQuery<T extends Record<string, unknown>>(
  vault: VaultAutomation,
  sql: string,
  params: JsonValue[] = [],
): Promise<T[]> {
  const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);
  if (!selectMatch) throw new Error(`Cannot parse SELECT columns: ${sql}`);
  const columns = selectMatch[1]
    .split(",")
    .map((c) =>
      c.trim().replace(/.*\s+AS\s+/i, "").replace(/"/g, "").replace(/.*\./, ""),
    );
  const rows = await vault.invokeTauriCommand<JsonValue[][]>(
    "sql_select_with_crdt",
    { sql, params },
  );
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj as T;
  });
}
