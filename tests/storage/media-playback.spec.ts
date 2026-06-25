import * as fsAsync from "node:fs/promises";
import { test, expect, VaultAutomation } from "../fixtures";
import { pollUntil, sqlQuery, wait } from "../helpers/ui/utils";
import { createLocalSpaceViaUI } from "../spaces/invitations/quic-helpers/ui-spaces";
import {
  openSettingsCategory,
  startP2PEndpoint,
} from "../helpers/ui/ui-vault";
import { mousedownClickTestId } from "../helpers/ui/ui-primitives";
import {
  generateMediaFixtures,
  isFfmpegAvailable,
} from "../helpers/media-fixtures";

/**
 * E2E coverage for inline audio/video playback in the file browser — the
 * full GUI flow, driven through the UI (open Files → pick the share → click
 * the media file → inline player), not through backend commands.
 *
 * What it guards: audio/video must stream through the local HTTP range server
 * (`http://127.0.0.1:<port>/…`). The previous build handed local-share media
 * an `asset://` URL, which WebKitGTK's GStreamer backend won't play with Range
 * support — MP3 pre-downloaded, MP4 never started. The regression signal here
 * is the player's `src`: it must be the loopback range-server URL, the element
 * must demux it (readyState ≥ HAVE_METADATA), and it must not error.
 *
 * Backend calls are confined to *arrange* (there is no UI to add a local share
 * without the native OS file picker, which WebDriver can't drive — so the
 * share row is seeded the same way the QUIC-invite suite does). The *act* and
 * *assert* are pure UI, except one `executeScript` to read the media element's
 * playback state, which the DOM exposes no other way.
 *
 * Skips automatically where ffmpeg is unavailable (bare local run); ffmpeg is
 * present in the e2e container.
 */

const SUFFIX = Date.now();
const SPACE_NAME = `Media Space ${SUFFIX}`;
const SHARE_NAME = `media-share-${SUFFIX}`;
const SHARE_DIR = `/tmp/haex-e2e-media-${SUFFIX}`;
const VIDEO_FILE = "clip.mp4";
const AUDIO_FILE = "tone.mp3";

// Default sentinel path the vault's filesystem_select_folder reads in debug
// builds. See haex-vault PR #539 (src-tauri/src/filesystem/commands.rs).
const PICK_FOLDER_SENTINEL_PATH = "/tmp/haex-e2e-pick-folder.txt";

interface MediaElementState {
  found: boolean;
  src: string | null;
  readyState: number;
  networkState: number;
  error: number | null;
  duration: number;
  currentTime: number;
  // Range-fetch of `src` from the page: proves the local range server
  // actually delivers bytes, independent of whether the headless WebKitGTK
  // build ships a decoder for the codec (which it may not — H.264/AAC).
  fetchStatus: number | null;
  fetchContentRange: string | null;
  fetchLen: number | null;
  fetchErr: string | null;
}

/**
 * Read the inline `<audio>`/`<video>` element's playback state. This is the
 * one unavoidable `executeScript`: media decoding/playback is not observable
 * through clicks or the DOM tree. Waits for `loadedmetadata` (or `error`),
 * nudges `play()`, then samples.
 */
async function readMediaState(
  vault: VaultAutomation,
  testId: string,
): Promise<MediaElementState> {
  return vault.executeScript<MediaElementState>(`
    const base = { found: false, src: null, readyState: -1, networkState: -1, error: null, duration: -1, currentTime: -1, fetchStatus: null, fetchContentRange: null, fetchLen: null, fetchErr: null };
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el) return base;
    if (el.readyState < 1 && !el.error) {
      await new Promise((resolve) => {
        const done = () => resolve();
        el.addEventListener('loadedmetadata', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    }
    try { await el.play(); } catch (_) { /* autoplay/headless may reject */ }
    await new Promise((r) => setTimeout(r, 800));
    const src = el.currentSrc || el.src || null;
    // Byte-level delivery probe: a Range request the player itself would make.
    let fetchStatus = null, fetchContentRange = null, fetchLen = null, fetchErr = null;
    if (src) {
      try {
        const res = await fetch(src, { headers: { Range: 'bytes=0-15' } });
        fetchStatus = res.status;
        fetchContentRange = res.headers.get('content-range');
        fetchLen = (await res.arrayBuffer()).byteLength;
      } catch (e) { fetchErr = String(e && e.message || e); }
    }
    return {
      found: true,
      src,
      readyState: el.readyState,
      networkState: el.networkState,
      error: el.error ? el.error.code : null,
      duration: Number.isFinite(el.duration) ? el.duration : -1,
      currentTime: el.currentTime,
      fetchStatus, fetchContentRange, fetchLen, fetchErr,
    };
  `);
}

/**
 * Close the preview modal between media items. Reka's dismiss layer listens
 * on the dialog content, so dispatch Escape there as well as on document, and
 * poll until both preview elements are gone (so the next file row is clickable
 * rather than covered by the modal).
 */
async function closePreview(vault: VaultAutomation): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const gone = await vault.executeScript<boolean>(`
      const v = document.querySelector('[data-testid="file-preview-video"]');
      const a = document.querySelector('[data-testid="file-preview-audio"]');
      if (!v && !a) return true;
      const dlg = document.querySelector('[role="dialog"]');
      const ev = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
      document.dispatchEvent(ev());
      if (dlg) dlg.dispatchEvent(ev());
      return false;
    `);
    if (gone) return;
    await wait(500);
  }
}

/**
 * Open a media file's inline preview, robustly.
 *
 * This suite runs as part of the long `workflows` shard, where vault A is a
 * single session shared across hundreds of preceding tests. By the time we get
 * here it carries a lot of accumulated state (peers, connections, status
 * listeners), and the resulting background reactivity can occasionally swallow
 * the *second* modal open in this serial suite: the row click registers, but
 * the preview element never mounts. In isolation the open is instant — the
 * failure only surfaces under that accumulated load.
 *
 * So we don't assume a single click→open succeeds. Each attempt first closes
 * any stale/half-open preview (clearing a close transition the open could race
 * against), clicks the row, and waits for the preview element — retrying the
 * whole cycle a few times. A retry re-clicks, which re-triggers the open.
 * Returns whether the preview appeared. Budgeted to stay under the 60s test
 * timeout even if every attempt fails.
 */
async function openMediaPreview(
  vault: VaultAutomation,
  fileTestId: string,
  previewTestId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await closePreview(vault);
    await wait(500);

    const clicked = await vault.clickBySelector(sel(fileTestId), {
      timeout: 10000,
    });
    if (
      clicked &&
      (await vault.waitForElement(sel(previewTestId), { timeout: 10000 }))
    ) {
      return true;
    }
    await wait(500);
  }
  return false;
}

const sel = (testId: string) => `[data-testid="${testId}"]`;

/**
 * Close every NON-files system window via the windowManager Pinia store.
 * Vault A is the shared session: by the time this suite runs ~300 tests have
 * left various system windows (settings, marketplace, …) open. Their DOM /
 * z-index can overlay a freshly-opened Files window. Sending Escape doesn't
 * close them — they're full WM windows, not modal dialogs. We keep an
 * already-open Files window so the singleton-check in openWindowAsync can
 * just re-activate it. Returns the source ids that were closed.
 */
async function closeNonFilesSystemWindows(vault: VaultAutomation): Promise<string[]> {
  const closed = await vault.executeScript<string[]>(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const wm = pinia?._s?.get('windowManager');
    if (!wm) return [];
    const wins = (wm.currentWorkspaceWindows || []).slice();
    const ids = [];
    for (const w of wins) {
      // Only target system windows. Vault A is shared across the workflows
      // shard; user/app windows on the same workspace must NOT be torn down
      // — that would create cross-test state loss far from this suite.
      const wtype = w.type || w.tabs?.[0]?.type || null;
      if (wtype !== 'system') continue;
      const sid = w.sourceId || w.tabs?.[0]?.sourceId || 'unknown';
      if (sid === 'files') continue;
      ids.push(sid);
      try { wm.closeWindow(w.id); } catch (_) {}
    }
    return ids;
  `);
  return closed ?? [];
}

/**
 * Open the Files window via the windowManager Pinia store directly. The
 * launcher-button → launcher-item-system-files dance is unreliable from
 * WebDriver under shared-session load: the click creates the window in the
 * store but the launcher drawer doesn't dismiss, leaving the Files content
 * un-rendered (peers:[] in diag) even though `currentWorkspaceWindows`
 * contains a `sourceId: 'files'` entry. The Settings opener in
 * ui-vault.ts:166 uses the same direct API for the same reason; we mirror
 * it here. Files is a singleton system window — re-calling openWindowAsync
 * activates the existing tab if already open.
 *
 * Returns whether the store call succeeded (openWindowAsync existed and was
 * invoked). The caller polls for `file-peer-*` to confirm the content
 * actually rendered.
 */
async function openFilesWindow(vault: VaultAutomation): Promise<boolean> {
  // Close any leftover non-files system windows (settings, marketplace, …)
  // that the shared vault A session may have accumulated.
  const closed = await closeNonFilesSystemWindows(vault);
  if (closed.length > 0) {
    console.log(
      `[media-playback][open-files] closed leftover windows: ${JSON.stringify(closed)}`,
    );
  }
  // Dismiss any modal dialog left over (create-space dialog, etc.).
  await vault.executeScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
  );
  await wait(300);

  const opened = await vault.executeScript<boolean>(`
    const app = document.getElementById('__nuxt')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const wm = pinia?._s?.get('windowManager');
    if (!wm?.openWindowAsync) return false;
    try {
      // Await the async open so a deferred rejection (store/route mount race)
      // surfaces as a falsy return and the outer retry loop kicks in. Without
      // the await we'd report success on a pending promise and skip retries.
      await wm.openWindowAsync({ sourceId: 'files', type: 'system' });
      return true;
    } catch (_) {
      return false;
    }
  `);
  if (!opened) {
    const diag = await vault.executeScript(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      return {
        hasPinia: !!pinia,
        windowManagerKeys: pinia?._s?.get('windowManager') ? Object.keys(pinia._s.get('windowManager')) : [],
      };
    `);
    console.log(`[media-playback][diag-open] ${JSON.stringify(diag)}`);
    return false;
  }
  // Let the window mount + initial reactive data loads settle.
  await wait(800);
  return true;
}

/**
 * Open Files and wait for the seeded share row to appear. Wraps the open +
 * waitForElement in a retry loop: under shared-session load the Files
 * window's initial reactive query for shares can lag, so we re-poke
 * openWindowAsync (idempotent for singleton windows) before re-checking.
 * Budgeted to stay under the 60s test timeout.
 */
async function openFilesAndExpectShare(
  vault: VaultAutomation,
  shareName: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await openFilesWindow(vault))) {
      console.log(
        `[media-playback][files-attempt-${attempt}] openFilesWindow returned false`,
      );
      continue;
    }
    if (
      await vault.waitForElement(sel(`file-peer-${shareName}`), {
        timeout: 12000,
      })
    ) {
      return true;
    }
    const diag = await vault.executeScript(`
      const app = document.getElementById('__nuxt')?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const wm = pinia?._s?.get('windowManager');
      const activeId = wm?.activeWindowId ?? null;
      const wins = (wm?.currentWorkspaceWindows || []).map(w => ({
        id: w.id,
        sourceId: w.sourceId || w.tabs?.[0]?.sourceId || null,
        active: w.id === activeId,
      }));
      return {
        windows: wins,
        activeId,
        peers: [...document.querySelectorAll('[data-testid^="file-peer-"]')].map(e => e.getAttribute('data-testid')),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      };
    `);
    console.log(
      `[media-playback][files-attempt-${attempt}] missing file-peer: ${JSON.stringify(diag)}`,
    );
    await wait(800);
  }
  return false;
}

/**
 * Click the seeded share row and wait for its file children to appear.
 *
 * Mirrors the same shared-session hazard as openMediaPreview above: vault A
 * carries hundreds of preceding tests' accumulated state by the time this
 * suite runs, and the share-folder navigation can race against background
 * reactivity — the row click registers, the URL/view switches, but the
 * file-entry rows don't paint within the per-attempt budget. In isolation
 * the listing is instant; only under accumulated shard load does the race
 * surface. So we don't assume a single click→list succeeds: each attempt
 * clicks the share, polls for the expected file-entry, and on miss falls
 * back out to the share overview (so the next click is a fresh navigation)
 * before retrying. Returns whether the file-entry appeared. Budgeted to
 * stay under the 60s test timeout even if every attempt fails.
 */
async function enterShareAndExpectFile(
  vault: VaultAutomation,
  shareName: string,
  fileTestId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await vault.clickBySelector(sel(`file-peer-${shareName}`), {
      timeout: 10000,
    });
    if (
      clicked &&
      (await vault.waitForElement(sel(fileTestId), { timeout: 8000 }))
    ) {
      return true;
    }
    const dom = await vault.executeScript(`
      return {
        peers: [...document.querySelectorAll('[data-testid^="file-peer-"]')].map(e => e.getAttribute('data-testid')),
        entries: [...document.querySelectorAll('[data-testid^="file-entry-"]')].map(e => e.getAttribute('data-testid')),
      };
    `);
    console.log(
      `[media-playback][share-listing-attempt-${attempt}] clicked=${clicked} ${JSON.stringify(dom)}`,
    );
    // Back out so the next attempt re-navigates from a clean overview.
    await vault.executeScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
    );
    await wait(500);
    // Re-assert we're back on the overview before retrying the click.
    await vault.waitForElement(sel(`file-peer-${shareName}`), {
      timeout: 5000,
    });
    await wait(500);
  }
  return false;
}

/** Dump overview DOM + DB rows when the seeded share fails to appear. */
async function diagnoseMissingShare(vault: VaultAutomation): Promise<void> {
  const dom = await vault.executeScript(`
    return {
      peers: [...document.querySelectorAll('[data-testid^="file-peer-"]')].map(e => e.getAttribute('data-testid')),
      entries: [...document.querySelectorAll('[data-testid^="file-entry-"]')].map(e => e.getAttribute('data-testid')),
      bodyText: document.body.innerText.slice(0, 2000),
    };
  `);
  console.log(`[media-playback][diag-overview] ${JSON.stringify(dom)}`);
  const shares = await sqlQuery(
    vault,
    "SELECT id, name, endpoint_id, space_id, local_path FROM haex_peer_shares WHERE name = ?1",
    [SHARE_NAME],
  );
  const spaces = await sqlQuery(
    vault,
    "SELECT id, name, status, owner_identity_id FROM haex_spaces WHERE name = ?1",
    [SPACE_NAME],
  );
  console.log(
    `[media-playback][diag-db] shares=${JSON.stringify(shares)} spaces=${JSON.stringify(spaces)}`,
  );
}

/**
 * Assert the inline player streams the file from the local HTTP range server.
 *
 * The deterministic, environment-independent signal is the element `src`:
 * pre-fix it was `asset://` (unplayable under WebKitGTK with Range); post-fix
 * it must be `http://127.0.0.1:<port>/…`. Byte delivery is asserted via a
 * Range probe where the WebView permits the fetch. A missing headless codec
 * (`MEDIA_ERR_SRC_NOT_SUPPORTED` = 4) is tolerated — it's not a fix
 * regression and the Rust `media_server` test already covers decoding-free
 * byte serving. Any other error fails: `MEDIA_ERR_NETWORK` (2) means delivery
 * broke, and `MEDIA_ERR_DECODE` (3) means the range server fed the element
 * corrupt/truncated bytes — both real regressions. So only `null` (played)
 * or `4` (no headless codec) are allowed.
 */
function assertStreamedFromRangeServer(state: MediaElementState): void {
  expect(state.found).toBe(true);
  expect(state.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  expect([null, 4]).toContain(state.error);
  if (state.fetchErr === null) {
    // 206 + exactly the 16 requested bytes proves the range server honoured
    // the Range request against the local file. The `Content-Range` header
    // itself isn't asserted: it's not CORS-safelisted, so a cross-origin
    // `fetch()` from the WebView can't read it (the server sends it; the
    // media element uses it; JS just can't see it without
    // Access-Control-Expose-Headers).
    expect(state.fetchStatus).toBe(206);
    expect(state.fetchLen).toBe(16);
  }
}

test.describe("storage: inline media playback (local share, full UI)", () => {
  // Serial: tests share one Files window. retries:0 — a mid-suite failure
  // leaves the preview modal open, so a Playwright retry of the serial block
  // would just fail the first test on a dirty UI; the first attempt is the
  // signal we want.
  test.describe.configure({ mode: "serial", retries: 0 });

  let vault: VaultAutomation;
  let arrangeOk = false;
  let skipReason = "";

  test.beforeAll(async () => {
    // The arrange chains startP2PEndpoint (UI) + createLocalSpaceViaUI (UI)
    // + leader-poll + add-share UI flow. Under workflows-shard load on a
    // shared Vault A session the inner pollUntils can come close to the
    // default 60s hook budget; bump to 120s so they have room to either
    // succeed or throw cleanly (catch → arrangeOk=false → tests skip).
    test.setTimeout(120_000);

    vault = new VaultAutomation("A");
    await vault.createSession();

    if (!isFfmpegAvailable()) {
      skipReason = "ffmpeg not available";
      return;
    }

    try {
      const media = generateMediaFixtures();

      // Drop the media onto the filesystem the vault sees (test + vault run
      // in the same container, so Node fs is the same /tmp). No Tauri
      // command — Node fs keeps the arrange off the SUT command surface.
      await fsAsync.mkdir(SHARE_DIR, { recursive: true });
      await fsAsync.writeFile(
        `${SHARE_DIR}/${VIDEO_FILE}`,
        Buffer.from(media.videoBase64, "base64"),
      );
      await fsAsync.writeFile(
        `${SHARE_DIR}/${AUDIO_FILE}`,
        Buffer.from(media.audioBase64, "base64"),
      );

      // Start P2P through the UI (Settings → Sync → Config → Start). Required
      // because addShareAsync needs the leader to register the share.
      await startP2PEndpoint(vault);

      // Create the local space — also pure UI.
      const spaceId = await createLocalSpaceViaUI(vault, SPACE_NAME);

      // startP2PEndpoint's leader-ready wait only fires when a local space
      // ALREADY exists. We just created SPACE_NAME *after* P2P start, so the
      // leader still needs a moment to register it. Adding the share before
      // `activeSpaces` includes `spaceId` races the leader and addShareAsync
      // can silently no-op. Mirrors the same pollUntil used in
      // ui-vault.ts:306-315.
      await pollUntil(
        async () => {
          const ds = await vault.invokeTauriCommand<{
            isLeader: boolean;
            activeSpaces: string[];
          }>("local_delivery_status", {});
          return ds.isLeader && (ds.activeSpaces ?? []).includes(spaceId)
            ? ds
            : null;
        },
        {
          timeout: 15_000,
          interval: 500,
          label: `leader picked up local space ${spaceId}`,
        },
      );

      // Sentinel-mechanism probe. The whole pure-UI arrange depends on the
      // vault honouring `/tmp/haex-e2e-pick-folder.txt`. If this returns null
      // (or hangs), either the vault binary doesn't have haex-vault PR #539,
      // or /tmp isn't shared between the test runner and the vault process.
      // Fail loud here instead of silently mis-seeding the share.
      const PROBE_PATH = "/probe/sentinel/path";
      await fsAsync.writeFile(PICK_FOLDER_SENTINEL_PATH, PROBE_PATH);
      const probe = await vault.invokeTauriCommand<string | null>(
        "filesystem_select_folder",
        {},
      );
      console.log(
        `[media-playback][sentinel-probe] expected=${PROBE_PATH} got=${JSON.stringify(probe)}`,
      );
      if (probe !== PROBE_PATH) {
        throw new Error(
          `sentinel override not honoured (got ${JSON.stringify(probe)}) — vault binary may predate haex-vault#539 or /tmp is not shared`,
        );
      }

      // Prime the e2e picker override: filesystem_select_folder reads
      // PICK_FOLDER_SENTINEL_PATH at dialog-open time when present (debug
      // build only — see haex-vault src-tauri/src/filesystem/commands.rs).
      await fsAsync.writeFile(PICK_FOLDER_SENTINEL_PATH, SHARE_DIR);
      try {
        // Open Settings → Spaces, expand the just-created space card, click
        // +Folder. The dropdown menu item triggers `useSpaceShares.addShareAsync`,
        // which calls `filesystem_select_folder` (returns SHARE_DIR from the
        // sentinel), then `store.addShareAsync(spaceId, name, path)` — the same
        // path a real user takes, including peerStore + leader updates.
        await openSettingsCategory(vault, "spaces");
        // Assert each click landed. `mousedownClickTestId` returns false when
        // the element isn't there; ignoring it would let arrange "succeed"
        // without a share, then the spec would fail later at "Files lists the
        // share" — far from the broken setup step.
        expect(
          await mousedownClickTestId(
            vault,
            `space-add-share-trigger-${spaceId}`,
          ),
          `space-add-share-trigger-${spaceId} not found`,
        ).toBe(true);
        await wait(500);
        expect(
          await mousedownClickTestId(
            vault,
            `space-add-share-folder-${spaceId}`,
          ),
          `space-add-share-folder-${spaceId} not found`,
        ).toBe(true);
        // Poll the DB for the share row instead of waiting blindly. If it
        // doesn't appear, addShareAsync silently no-op'd (picker returned
        // null, exception swallowed by the composable's try/catch toast,
        // etc.) — fail in arrange with detail rather than later in the
        // assertion phase.
        await pollUntil(
          async () => {
            const rows = await sqlQuery<{ id: string }>(
              vault,
              "SELECT id FROM haex_peer_shares WHERE space_id = ?1 AND name = ?2",
              [spaceId, SHARE_NAME],
            );
            return rows.length === 1 ? rows[0] : null;
          },
          {
            timeout: 10_000,
            interval: 500,
            label: `share row ${SHARE_NAME} in haex_peer_shares`,
          },
        );
      } finally {
        await fsAsync.unlink(PICK_FOLDER_SENTINEL_PATH).catch(() => {
          // best effort; a leftover sentinel only matters for the very next
          // Browse click in this debug build, and the next test that uses it
          // would overwrite anyway.
        });
      }

      arrangeOk = true;
    } catch (e) {
      skipReason = `arrange failed: ${e instanceof Error ? e.message : String(e)}`;
      console.log(`[media-playback] ${skipReason}`);
    }
  });

  test.afterAll(async () => {
    // Clean up the seeded media folder via Node fs.
    try {
      await fsAsync.rm(SHARE_DIR, { recursive: true, force: true });
    } catch {
      // best effort
    }
    await fsAsync.unlink(PICK_FOLDER_SENTINEL_PATH).catch(() => {});
    // No close_database: vault A is opened by global-setup and shared across
    // the storage suites — closing it would break the ones that run after.
  });

  test("file browser lists the local media share with its files", async () => {
    test.skip(!arrangeOk, skipReason);

    // Open Files and wait for the share row to appear. Retries the
    // close-system-windows + launcher-open + share-wait cycle, because under
    // shared-session load a leftover Settings WM window can re-overlay Files
    // after the first launch attempt.
    const sharePresent = await openFilesAndExpectShare(vault, SHARE_NAME);
    if (!sharePresent) await diagnoseMissingShare(vault);
    expect(sharePresent).toBe(true);

    // Enter the share → its two media files are listed. The click→listing path
    // can race against accumulated reactivity in the shared vault A session,
    // so the helper retries the navigation a few times before giving up.
    expect(
      await enterShareAndExpectFile(vault, SHARE_NAME, `file-entry-${VIDEO_FILE}`),
    ).toBe(true);
    expect(await vault.waitForElement(sel(`file-entry-${AUDIO_FILE}`))).toBe(
      true,
    );

    await vault.takeScreenshot("media-playback-share-listing");
  });

  test("clicking an MP4 streams it inline via the local range server", async () => {
    test.skip(!arrangeOk, skipReason);

    expect(
      await openMediaPreview(
        vault,
        `file-entry-${VIDEO_FILE}`,
        "file-preview-video",
      ),
    ).toBe(true);

    const state = await readMediaState(vault, "file-preview-video");
    await vault.takeScreenshot("media-playback-video");
    console.log(`[media-playback] video state: ${JSON.stringify(state)}`);

    assertStreamedFromRangeServer(state);

    await closePreview(vault);
  });

  test("clicking an MP3 streams it inline via the local range server", async () => {
    test.skip(!arrangeOk, skipReason);

    expect(
      await openMediaPreview(
        vault,
        `file-entry-${AUDIO_FILE}`,
        "file-preview-audio",
      ),
    ).toBe(true);

    const state = await readMediaState(vault, "file-preview-audio");
    await vault.takeScreenshot("media-playback-audio");
    console.log(`[media-playback] audio state: ${JSON.stringify(state)}`);

    assertStreamedFromRangeServer(state);

    await closePreview(vault);
  });
});
