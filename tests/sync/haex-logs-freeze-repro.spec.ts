import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { test, VaultAutomation } from "../fixtures";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";
import { pollUntil, wait } from "../helpers/ui/utils";
import {
  clearExchangedVault,
  copyVaultToDevice,
} from "../helpers/owner-sync/copy-vault";
import { dumpSyncState } from "../helpers/owner-sync/diagnostics";
import { restoreOriginalVault } from "../vault-lifecycle/vault-constants";

/**
 * Capture-only repro for the "same owner-vault on 2 devices freezes the 2nd
 * device" bug (memory `second-device-freeze-and-haex-logs-crdt`).
 *
 * Post haex-vault PR #709 the log table is `haex_logs_no_sync` and the
 * SyncLoop's per-cycle telemetry persists there with `source = 'SyncLoop'`
 * — historically it was stderr-only because writing CRDT-synced logs from
 * the sync loop created an amplification feedback loop. Now that log writes
 * bypass CRDT (dedicated `LogSink` connection), the sync loop's own state
 * transitions are readable from outside the container even when the app's
 * main thread is wedged.
 *
 * This spec DELIBERATELY makes no assertions on freeze presence or on the
 * shape of the captured rows. Its job is to produce two JSONL artefacts
 * (`test-results/haex-logs-freeze-repro/{a,b}.jsonl`) that the next iteration
 * of specs (Phase B in `docs/plans/2026-07-21-haex-logs-e2e-followup.md`,
 * lives in the haex-vault repo) will use as ground truth for what a healthy
 * vs. wedged 2-device sync looks like.
 *
 * Prerequisite: haex-vault PR #709 must be in the vault image the test
 * containers run — otherwise the SyncLoop source doesn't emit persisted
 * rows and b.jsonl comes back empty. See the plan's "Prerequisites" block.
 */

interface LogEntry {
  id: string;
  timestamp: string;
  level: string;
  source: string;
  extensionId: string | null;
  message: string;
  metadata: string | null;
  deviceId: string;
}

// Unique per run so a retry doesn't collide with prior state.
const VAULT_NAME = `haex-logs-freeze-repro-${Date.now()}`;
const VAULT_PASSWORD = "haex-logs-freeze-repro-pw-1234";
const SEED_ROW_COUNT = 5;

const LIVENESS_TIMEOUT_MS = 60_000;
const CAPTURE_WINDOW_MS = 90_000;
const CAPTURE_POLL_INTERVAL_MS = 2_000;
// Per-call deadline. Must be < CAPTURE_POLL_INTERVAL_MS so a stuck call
// times out within one poll cycle instead of stalling the whole window.
const TAURI_CALL_DEADLINE_MS = 5_000;
const SYNC_LOOP_SOURCE = "SyncLoop";

const ARTEFACT_DIR = "test-results/haex-logs-freeze-repro";

test.describe("sync: haex_logs_no_sync 2-device freeze repro (capture-only)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  // Baselines captured right after each vault is opened, so
  // captureSyncLoopLogs can exclude rows that predate the capture window.
  // In particular, copyVaultToDevice mirrors A's whole .db to B — including
  // the local haex_logs_no_sync table — so without this baseline B's
  // b.jsonl would inherit A's historical SyncLoop rows.
  const baselineA = new Set<string>();
  const baselineB = new Set<string>();

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Reset both webviews out of any /vault/... URL a sibling suite may
    // have left behind — same reasoning as owner-sync-vault-copy.spec.ts.
    for (const v of [vaultA, vaultB]) {
      await v.invokeTauriCommand("close_database", {}).catch(() => {});
      await v.navigateTo("/");
    }
    await wait(1000);

    await mkdir(ARTEFACT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await clearExchangedVault(VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultA, VAULT_NAME).catch(() => {});
    await restoreOriginalVault(vaultB, VAULT_NAME).catch(() => {});
  });

  test("A: create + seed vault", async () => {
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);

    // Baseline right after A is opened — any SyncLoop row already present
    // pre-dates this run's capture window and must not be counted.
    await snapshotBaseline(vaultA, baselineA);

    for (let i = 0; i < SEED_ROW_COUNT; i++) {
      await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
        sql: "INSERT INTO haex_passwords_item_details (id, password) VALUES (?1, ?2)",
        params: [`freeze-seed-${i}`, `freeze-secret-${i}`],
      });
    }
  });

  test("B: import A's vault file and open through the UI", async () => {
    await copyVaultToDevice(vaultA, vaultB, VAULT_NAME);
    // Re-open A after copyVaultToDevice closed it.
    await initializeVaultViaUI(vaultA, VAULT_NAME, VAULT_PASSWORD);
    await initializeVaultViaUI(vaultB, VAULT_NAME, VAULT_PASSWORD);

    // Baseline B AFTER the import — the imported .db carries A's whole
    // haex_logs_no_sync table, and we want to exclude that inherited
    // history from B's capture. Also refresh A's baseline in case its
    // sink caught up while B was importing.
    await snapshotBaseline(vaultA, baselineA);
    await snapshotBaseline(vaultB, baselineB);

    await dumpSyncState(vaultA, "haex-logs-freeze-repro/post-import");
    await dumpSyncState(vaultB, "haex-logs-freeze-repro/post-import");
  });

  test("capture SyncLoop rows from both containers into JSONL artefacts", async () => {
    // Best-effort liveness nudge. autostart from PR #511 wires
    // peer_storage_start + owner_sync_start on vault-open, but
    // owner_sync_force short-circuits the poll interval.
    await invokeWithDeadline(vaultA, "owner_sync_force", {}).catch(() => {});
    await invokeWithDeadline(vaultB, "owner_sync_force", {}).catch(() => {});

    // Wait up to LIVENESS_TIMEOUT_MS for B's peer_storage to report
    // running. A freeze on B surfaces here as the poll timing out — we
    // swallow, because the capture below is the whole point. The
    // per-call deadline stops a hung status call from wedging the poll.
    await pollUntil(
      async () => {
        const status = await invokeWithDeadline<{ running: boolean }>(
          vaultB,
          "peer_storage_status",
          {},
        ).catch(() => ({ running: false }));
        return status.running ? true : null;
      },
      {
        timeout: LIVENESS_TIMEOUT_MS,
        interval: 2_000,
        label: "B peer_storage_status.running",
      },
    ).catch(() => {
      // Non-fatal by design.
    });

    // Independent capture pipelines. Each writes its own JSONL as a
    // live tail so partial data survives a Playwright hard-timeout, and
    // a freeze on B does not block A's file from landing (or vice
    // versa). Promise.allSettled so one side's failure doesn't
    // short-circuit the other's completion.
    const results = await Promise.allSettled([
      capturePipeline(
        vaultA,
        baselineA,
        path.join(ARTEFACT_DIR, "a.jsonl"),
      ),
      capturePipeline(
        vaultB,
        baselineB,
        path.join(ARTEFACT_DIR, "b.jsonl"),
      ),
    ]);

    const countA = results[0].status === "fulfilled" ? results[0].value : "err";
    const countB = results[1].status === "fulfilled" ? results[1].value : "err";
    console.log(
      `[E2E-DIAG haex-logs-freeze-repro] captured a=${countA} b=${countB} rows`,
    );
  });
});

/**
 * Race an invokeTauriCommand call against a rejecting timeout. Prevents
 * a wedged webview from stalling the entire poll loop — the whole point
 * of the spec is that B may stop responding, so no call site here can
 * assume the underlying transport is live.
 *
 * The setTimeout handle is cleared on either outcome so we don't leak a
 * live timer after a fast resolve.
 */
async function invokeWithDeadline<T>(
  vault: VaultAutomation,
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number = TAURI_CALL_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`invokeTauriCommand(${command}) timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      vault.invokeTauriCommand<T>(command, args),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Read the current set of SyncLoop row keys on the given vault and
 * populate `into` with them. Used to establish the "before capture
 * begins" baseline — captureSyncLoopLogs then excludes any key it sees
 * during polling that was already in the baseline.
 *
 * Uses invokeWithDeadline so a wedged vault at baseline time yields an
 * empty baseline rather than hanging the test. That's the conservative
 * choice: unknown baseline → keep everything (the JSONL will over-
 * report but never lose data).
 */
async function snapshotBaseline(
  vault: VaultAutomation,
  into: Set<string>,
): Promise<void> {
  try {
    const rows = await invokeWithDeadline<LogEntry[]>(vault, "log_read", {
      query: { source: SYNC_LOOP_SOURCE, limit: 500 },
    });
    for (const row of rows) {
      into.add(`${row.id}|${row.timestamp}`);
    }
  } catch (err) {
    console.log(
      `[E2E-DIAG haex-logs-freeze-repro ${vault.getInstance()}] baseline failed (proceeding with empty baseline): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Run one vault's capture window end-to-end: poll log_read every
 * `CAPTURE_POLL_INTERVAL_MS`, dedupe by (id, timestamp), exclude
 * pre-baseline rows, and rewrite the JSONL file after each successful
 * poll so partial data survives a hard timeout on any other test in
 * the suite. Returns the total number of rows written.
 *
 * Runs independently per vault — a stalled call on this side does not
 * affect the other side's pipeline.
 */
async function capturePipeline(
  vault: VaultAutomation,
  baseline: ReadonlySet<string>,
  filePath: string,
): Promise<number> {
  const seen = new Map<string, LogEntry>();
  const deadline = Date.now() + CAPTURE_WINDOW_MS;
  // Write an empty file up front so the artefact upload always finds
  // it — even if the very first poll hangs past the test timeout.
  await writeJsonl(filePath, []);

  while (Date.now() < deadline) {
    try {
      const rows = await invokeWithDeadline<LogEntry[]>(vault, "log_read", {
        query: { source: SYNC_LOOP_SOURCE, limit: 500 },
      });
      for (const row of rows) {
        const key = `${row.id}|${row.timestamp}`;
        if (baseline.has(key)) continue;
        seen.set(key, row);
      }
      // Live-tail write: rewrite the JSONL after each successful poll,
      // oldest-first. Cheap because the row count is small; buys us
      // artefact durability across unexpected teardown.
      await writeJsonl(filePath, sortByTimestamp(seen.values()));
    } catch (err) {
      console.log(
        `[E2E-DIAG haex-logs-freeze-repro ${vault.getInstance()}] log_read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await wait(CAPTURE_POLL_INTERVAL_MS);
  }
  return seen.size;
}

function sortByTimestamp(entries: Iterable<LogEntry>): LogEntry[] {
  return Array.from(entries).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

async function writeJsonl(filePath: string, rows: LogEntry[]): Promise<void> {
  const body = rows.length
    ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    : "";
  await writeFile(filePath, body, "utf8");
}
