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
const SYNC_LOOP_SOURCE = "SyncLoop";

const ARTEFACT_DIR = "test-results/haex-logs-freeze-repro";

test.describe("sync: haex_logs_no_sync 2-device freeze repro (capture-only)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;

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

    await dumpSyncState(vaultA, "haex-logs-freeze-repro/post-import");
    await dumpSyncState(vaultB, "haex-logs-freeze-repro/post-import");
  });

  test("capture SyncLoop rows from both containers into JSONL artefacts", async () => {
    // Best-effort liveness nudge. autostart from PR #511 wires
    // peer_storage_start + owner_sync_start on vault-open, but
    // owner_sync_force short-circuits the poll interval.
    await vaultA.invokeTauriCommand("owner_sync_force", {}).catch(() => {});
    await vaultB.invokeTauriCommand("owner_sync_force", {}).catch(() => {});

    // Wait up to LIVENESS_TIMEOUT_MS for B's peer_storage to report
    // running. A freeze on B surfaces here as the poll timing out — we
    // swallow, because the capture below is the whole point.
    await pollUntil(
      async () => {
        const status = await vaultB
          .invokeTauriCommand<{ running: boolean }>("peer_storage_status", {})
          .catch(() => ({ running: false }));
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

    // Parallel capture windows on both sides. If B is frozen, its
    // log_read calls will start failing — captureSyncLoopLogs logs the
    // failure but keeps polling until the window closes.
    const [capturedA, capturedB] = await Promise.all([
      captureSyncLoopLogs(vaultA, CAPTURE_WINDOW_MS, CAPTURE_POLL_INTERVAL_MS),
      captureSyncLoopLogs(vaultB, CAPTURE_WINDOW_MS, CAPTURE_POLL_INTERVAL_MS),
    ]);

    await writeJsonl(path.join(ARTEFACT_DIR, "a.jsonl"), capturedA);
    await writeJsonl(path.join(ARTEFACT_DIR, "b.jsonl"), capturedB);

    console.log(
      `[E2E-DIAG haex-logs-freeze-repro] captured a=${capturedA.length} b=${capturedB.length} rows`,
    );
  });
});

/**
 * Poll log_read on the given vault for a fixed window, accumulating rows
 * with source = 'SyncLoop'. Rows are deduped by (id, timestamp) so the
 * DESC-ordered pages don't double-count each other. Returned oldest-first
 * so the JSONL file is chronologically readable.
 */
async function captureSyncLoopLogs(
  vault: VaultAutomation,
  windowMs: number,
  intervalMs: number,
): Promise<LogEntry[]> {
  const seen = new Map<string, LogEntry>();
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    try {
      const rows = await vault.invokeTauriCommand<LogEntry[]>("log_read", {
        query: {
          source: SYNC_LOOP_SOURCE,
          limit: 500,
        },
      });
      for (const row of rows) {
        seen.set(`${row.id}|${row.timestamp}`, row);
      }
    } catch (err) {
      // log_read failing IS a data point on a wedged container. Emit
      // to console so the CI log shows when the app stopped answering.
      console.log(
        `[E2E-DIAG haex-logs-freeze-repro ${vault.getInstance()}] log_read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await wait(intervalMs);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

async function writeJsonl(filePath: string, rows: LogEntry[]): Promise<void> {
  const body = rows.length
    ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
    : "";
  await writeFile(filePath, body, "utf8");
}
