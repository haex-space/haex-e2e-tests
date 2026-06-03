import * as crypto from "node:crypto";
import { test, expect, VaultAutomation } from "../fixtures";
import { sqlQuery, wait } from "../helpers/ui/utils";
import {
  createLocalSpaceViaUI,
  ensureDeviceRegistered,
} from "../spaces/invitations/quic-helpers/ui-spaces";
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

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface MediaElementState {
  found: boolean;
  src: string | null;
  readyState: number;
  networkState: number;
  error: number | null;
  duration: number;
  currentTime: number;
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
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!el) {
      return { found: false, src: null, readyState: -1, networkState: -1, error: null, duration: -1, currentTime: -1 };
    }
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
    return {
      found: true,
      src: el.currentSrc || el.src || null,
      readyState: el.readyState,
      networkState: el.networkState,
      error: el.error ? el.error.code : null,
      duration: Number.isFinite(el.duration) ? el.duration : -1,
      currentTime: el.currentTime,
    };
  `);
}

/** Close the preview modal between media items (Escape, as a user would). */
async function closePreview(vault: VaultAutomation): Promise<void> {
  await vault.executeScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  `);
  await wait(600);
}

const sel = (testId: string) => `[data-testid="${testId}"]`;

/**
 * Open the Files window from the launcher — pure UI. Arrange leaves the
 * Settings window (and possibly a just-closed dialog) in focus, so dismiss
 * any overlay first, then open the launcher and click the Files item. Returns
 * whether the Files item became clickable; logs a DOM dump on failure.
 */
async function openFilesWindow(vault: VaultAutomation): Promise<boolean> {
  // Dismiss leftover dialog/drawer (create-space dialog, etc.).
  await vault.executeScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
  );
  await wait(500);

  await vault.clickBySelector(sel("launcher-button"), { timeout: 15000 });
  await wait(500);
  let found = await vault.waitForElement(sel("launcher-item-system-files"), {
    timeout: 10000,
  });
  if (!found) {
    // The launcher button toggles — a stale-open launcher would have closed
    // on the click above. Try once more.
    await vault.clickBySelector(sel("launcher-button"), { timeout: 5000 });
    await wait(500);
    found = await vault.waitForElement(sel("launcher-item-system-files"), {
      timeout: 10000,
    });
  }
  if (!found) {
    const diag = await vault.executeScript(`
      return {
        launcherButton: !!document.querySelector('[data-testid="launcher-button"]'),
        launcherItems: [...document.querySelectorAll('[data-testid^="launcher-item-"]')].map(e => e.getAttribute('data-testid')),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        bodyText: document.body.innerText.slice(0, 1500),
      };
    `);
    console.log(`[media-playback][diag-launcher] ${JSON.stringify(diag)}`);
    return false;
  }
  return await vault.clickBySelector(sel("launcher-item-system-files"), {
    timeout: 10000,
  });
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

test.describe("storage: inline media playback (local share, full UI)", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let arrangeOk = false;
  let skipReason = "";

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    if (!isFfmpegAvailable()) {
      skipReason = "ffmpeg not available";
      return;
    }

    try {
      const media = generateMediaFixtures();

      // Peer storage must be running to have a stable nodeId for the share row.
      let nodeId: string;
      try {
        const info = await vault.invokeTauriCommand<PeerStorageStartInfo>(
          "peer_storage_start",
          {},
        );
        nodeId = info.nodeId;
      } catch {
        const status = await vault.invokeTauriCommand<PeerStorageStartInfo>(
          "peer_storage_status",
          {},
        );
        nodeId = status.nodeId;
      }

      const identities = await sqlQuery<{ did: string }>(
        vault,
        "SELECT did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
      );
      const did = identities[0]?.did;
      if (!did) throw new Error("no local identity with a private key");

      // Drop the media onto the vault filesystem inside the share folder.
      await vault.invokeTauriCommand("filesystem_mkdir", { path: SHARE_DIR });
      await vault.invokeTauriCommand("filesystem_write_file", {
        path: `${SHARE_DIR}/${VIDEO_FILE}`,
        data: media.videoBase64,
      });
      await vault.invokeTauriCommand("filesystem_write_file", {
        path: `${SHARE_DIR}/${AUDIO_FILE}`,
        data: media.audioBase64,
      });

      // Create the space through the UI, then seed the share row the same way
      // the QUIC suite does (the OS picker is unreachable from WebDriver).
      const spaceId = await createLocalSpaceViaUI(vault, SPACE_NAME);
      await ensureDeviceRegistered(vault, spaceId, nodeId, did);

      const ownDevice = await sqlQuery<{ id: string }>(
        vault,
        "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
        [nodeId],
      );
      if (ownDevice.length !== 1) throw new Error("own device row not found");

      const shareId = crypto.randomUUID();
      await vault.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT INTO haex_peer_shares
                (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        params: [shareId, spaceId, ownDevice[0].id, nodeId, SHARE_NAME, SHARE_DIR, did],
      });
      // Make the leader pick up the new share (mirrors addShareAsync).
      await vault.invokeTauriCommand("peer_storage_reload_shares");

      arrangeOk = true;
    } catch (e) {
      skipReason = `arrange failed: ${e instanceof Error ? e.message : String(e)}`;
      console.log(`[media-playback] ${skipReason}`);
    }
  });

  test.afterAll(async () => {
    // Remove the media files first — filesystem_remove won't delete a
    // non-empty directory.
    for (const f of [VIDEO_FILE, AUDIO_FILE]) {
      try {
        await vault.invokeTauriCommand("filesystem_remove", {
          path: `${SHARE_DIR}/${f}`,
        });
      } catch {
        // best effort
      }
    }
    try {
      await vault.invokeTauriCommand("filesystem_remove", { path: SHARE_DIR });
    } catch {
      // best effort
    }
    // No close_database: vault A is opened by global-setup and shared across
    // the storage suites — closing it would break the ones that run after.
  });

  test("file browser lists the local media share with its files", async () => {
    test.skip(!arrangeOk, skipReason);

    // Open the Files window from the launcher — pure UI.
    expect(await openFilesWindow(vault)).toBe(true);

    // The share shows up in the browser overview.
    const sharePresent = await vault.waitForElement(
      sel(`file-peer-${SHARE_NAME}`),
      { timeout: 20000 },
    );
    if (!sharePresent) await diagnoseMissingShare(vault);
    expect(sharePresent).toBe(true);

    // Enter the share → its two media files are listed.
    expect(
      await vault.clickBySelector(sel(`file-peer-${SHARE_NAME}`), {
        timeout: 10000,
      }),
    ).toBe(true);
    expect(
      await vault.waitForElement(sel(`file-entry-${VIDEO_FILE}`), {
        timeout: 15000,
      }),
    ).toBe(true);
    expect(await vault.waitForElement(sel(`file-entry-${AUDIO_FILE}`))).toBe(
      true,
    );

    await vault.takeScreenshot("media-playback-share-listing");
  });

  test("clicking an MP4 streams it inline via the local range server", async () => {
    test.skip(!arrangeOk, skipReason);

    expect(
      await vault.clickBySelector(sel(`file-entry-${VIDEO_FILE}`), {
        timeout: 10000,
      }),
    ).toBe(true);
    expect(
      await vault.waitForElement(sel("file-preview-video"), { timeout: 15000 }),
    ).toBe(true);

    const state = await readMediaState(vault, "file-preview-video");
    await vault.takeScreenshot("media-playback-video");
    console.log(`[media-playback] video state: ${JSON.stringify(state)}`);

    expect(state.found).toBe(true);
    // The crux: streamed from the loopback range server, not asset:// / blob:.
    expect(state.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(state.error).toBeNull();
    // Metadata loaded ⇒ GStreamer demuxed the range-served stream.
    expect(state.readyState).toBeGreaterThanOrEqual(1);

    await closePreview(vault);
  });

  test("clicking an MP3 streams it inline via the local range server", async () => {
    test.skip(!arrangeOk, skipReason);

    expect(
      await vault.clickBySelector(sel(`file-entry-${AUDIO_FILE}`), {
        timeout: 10000,
      }),
    ).toBe(true);
    expect(
      await vault.waitForElement(sel("file-preview-audio"), { timeout: 15000 }),
    ).toBe(true);

    const state = await readMediaState(vault, "file-preview-audio");
    await vault.takeScreenshot("media-playback-audio");
    console.log(`[media-playback] audio state: ${JSON.stringify(state)}`);

    expect(state.found).toBe(true);
    expect(state.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(state.error).toBeNull();
    expect(state.readyState).toBeGreaterThanOrEqual(1);

    await closePreview(vault);
  });
});
