import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execSync, execFileSync } from "node:child_process";
import { setupMarketplace } from "./marketplace-setup";
import { VaultAutomation } from "./fixtures";
import { completeWelcomeOnboarding } from "./helpers/ui/ui-welcome";

// tauri-driver WebDriver URL
const TAURI_DRIVER_URL = "http://localhost:4444";
const SESSION_FILE = path.join(os.tmpdir(), "e2e-webdriver-session.json");
const FFMPEG_PID_FILE = "/tmp/e2e-ffmpeg-recording.pid";
const VIDEO_OUTPUT_PATH = "/app/test-results/artifacts/desktop-recording.webm";

// Test vault configuration
const TEST_VAULT_NAME = "e2e-test-vault";
const TEST_VAULT_PASSWORD = "test-password-12345";

/**
 * Wait for X11 display to be ready
 */
async function waitForX11Display(timeout = 60000): Promise<boolean> {
  const start = Date.now();
  console.log("[Setup] Waiting for X11 display :1 to be ready...");

  while (Date.now() - start < timeout) {
    try {
      execSync("DISPLAY=:1 xdpyinfo >/dev/null 2>&1", { encoding: "utf-8" });
      console.log("[Setup] X11 display is ready");
      return true;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("[Setup] WARNING: X11 display not ready within timeout");
  return false;
}

/**
 * Get the current X11 display resolution
 */
function getDisplayResolution(): string {
  try {
    // Use xrandr to get the actual screen resolution (more reliable than xdpyinfo)
    // xdpyinfo can return the virtual screen size which may be larger than actual display
    const output = execSync("DISPLAY=:1 xrandr 2>/dev/null | grep ' connected' | head -1", {
      encoding: "utf-8",
    });
    // Output format: "Virtual-1 connected primary 1024x768+0+0 ..."
    const match = output.match(/(\d+x\d+)/);
    if (match) {
      console.log("[Setup] Detected display resolution (xrandr):", match[1]);
      return match[1];
    }
  } catch {
    console.log("[Setup] xrandr failed, trying xdpyinfo...");
  }

  // Fallback to xdpyinfo with explicit screen 0
  try {
    const output = execSync("DISPLAY=:1.0 xdpyinfo 2>/dev/null | grep -A1 'screen #0' | grep dimensions", {
      encoding: "utf-8",
    });
    const match = output.match(/(\d+x\d+)/);
    if (match) {
      console.log("[Setup] Detected display resolution (xdpyinfo):", match[1]);
      return match[1];
    }
  } catch {
    console.log("[Setup] Could not detect display resolution, using default");
  }
  return "1024x768"; // webtop default
}

/**
 * Start desktop screen recording using ffmpeg
 * Records the X11 display to a webm file for debugging test failures
 */
function startScreenRecording(): void {
  // Ensure output directory exists
  const outputDir = "/app/test-results/artifacts";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("[Setup] Starting desktop screen recording...");

  // Get actual display resolution
  const resolution = getDisplayResolution();

  // Use ffmpeg to record the X11 display
  // -f x11grab: capture X11 display
  // -video_size: detected from xdpyinfo
  // -framerate 10: 10 fps is enough for debugging, keeps file size small
  // -i :1: display number (webtop uses :1)
  // -c:v libvpx-vp9: VP9 codec for webm
  // -crf 35: quality (higher = smaller file, lower quality)
  // -b:v 0: let CRF control quality
  const ffmpegProcess = spawn("ffmpeg", [
    "-f", "x11grab",
    "-video_size", resolution,
    "-framerate", "10",
    "-i", ":1",
    "-c:v", "libvpx-vp9",
    "-crf", "35",
    "-b:v", "0",
    "-y", // Overwrite output file
    VIDEO_OUTPUT_PATH,
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Log ffmpeg output for debugging
  ffmpegProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[ffmpeg] ${data.toString().trim()}`);
  });
  ffmpegProcess.stderr?.on("data", (data: Buffer) => {
    // ffmpeg writes progress to stderr
    const msg = data.toString().trim();
    if (msg && !msg.startsWith("frame=")) {
      console.log(`[ffmpeg] ${msg}`);
    }
  });

  ffmpegProcess.on("error", (err: Error) => {
    console.error("[Setup] ffmpeg error:", err.message);
  });

  // Save PID for teardown to stop recording
  if (ffmpegProcess.pid) {
    fs.writeFileSync(FFMPEG_PID_FILE, ffmpegProcess.pid.toString());
    console.log("[Setup] Screen recording started, PID:", ffmpegProcess.pid);
  }

  // Unref so the process doesn't prevent Node from exiting
  ffmpegProcess.unref();
}

/**
 * Wait for tauri-driver to be ready
 */
async function waitForTauriDriver(timeout = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${TAURI_DRIVER_URL}/status`);
      if (response.ok) {
        console.log("[Setup] tauri-driver is ready");
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Create a WebDriver session with tauri-driver
 */
async function createWebDriverSession(): Promise<string> {
  // Defaults to the Linux Docker container path; the native Windows/macOS
  // runners (see scripts/start-vault-windows.ps1, start-vault-macos.sh) set
  // HAEX_VAULT_BINARY_PATH to the downloaded artifact's actual location.
  const applicationPath =
    process.env.HAEX_VAULT_BINARY_PATH || "/repos/haex-vault/src-tauri/target/release/haex-vault";
  const response = await fetch(`${TAURI_DRIVER_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          "tauri:options": {
            application: applicationPath,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create WebDriver session: ${response.status}`);
  }

  const data = await response.json();
  const sessionId = data.value?.sessionId || data.sessionId;
  console.log("[Setup] WebDriver session created:", sessionId);
  return sessionId;
}

/**
 * Execute a Tauri command via WebDriver (Tauri v2 compatible)
 */
async function invokeTauriCommand<T = unknown>(
  sessionId: string,
  command: string,
  args: object = {}
): Promise<T> {
  const script = `
    const callback = arguments[arguments.length - 1];
    const { invoke } = window.__TAURI_INTERNALS__;
    invoke('${command}', ${JSON.stringify(args)})
      .then(result => callback({ success: true, data: result }))
      .catch(error => callback({ success: false, error: JSON.stringify(error) }));
  `;

  const response = await fetch(
    `${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script,
        args: [],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to execute Tauri command '${command}': ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const result = data.value;

  if (result && typeof result === "object" && "success" in result) {
    if (!result.success) {
      console.error(`[E2E] Tauri command '${command}' error — full result:`, JSON.stringify(result));
      const errorDetails = typeof result.error === "object"
        ? JSON.stringify(result.error, null, 2)
        : String(result.error);
      throw new Error(`Tauri command '${command}' failed: ${errorDetails}`);
    }
    return result.data as T;
  }

  return result;
}

/**
 * Wait for WebSocket bridge to be ready
 */
async function waitForWebSocketBridge(timeout = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket("ws://localhost:19455");

      const result = await Promise.race([
        new Promise<boolean>((resolve) => {
          ws.on("open", () => {
            ws.close();
            resolve(true);
          });
          ws.on("error", () => resolve(false));
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);

      if (result) {
        console.log("[Setup] WebSocket bridge is ready");
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}


interface VaultInfo {
  name: string;
  lastAccess: number;
  path: string;
}

/**
 * Get all window handles and switch to the correct one
 */
async function switchToAppWindow(sessionId: string): Promise<void> {
  // Get all window handles
  const handleResponse = await fetch(
    `${TAURI_DRIVER_URL}/session/${sessionId}/window/handles`,
    { method: "GET" }
  );

  if (!handleResponse.ok) {
    console.log("[Setup] Could not get window handles, trying default window");
    return;
  }

  const handleData = await handleResponse.json();
  const handles = handleData.value || [];
  console.log("[Setup] Available window handles:", handles);

  // Try each handle and find one with Tauri
  for (const handle of handles) {
    try {
      // Switch to this window
      await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      });

      // Check for frames in this window
      const frameScript = `
        const callback = arguments[arguments.length - 1];
        const frames = [];
        for (let i = 0; i < window.frames.length; i++) {
          try {
            frames.push({
              index: i,
              href: window.frames[i].location.href,
              hasTauri: !!window.frames[i].__TAURI_INTERNALS__
            });
          } catch (e) {
            frames.push({ index: i, error: e.message });
          }
        }
        callback({
          hasTauri: !!window.__TAURI_INTERNALS__,
          href: window.location.href,
          origin: window.location.origin,
          frameCount: window.frames.length,
          frames: frames
        });
      `;
      const checkResponse = await fetch(
        `${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: frameScript, args: [] }),
        }
      );

      if (checkResponse.ok) {
        const checkData = await checkResponse.json();
        console.log(`[Setup] Window ${handle}:`, JSON.stringify(checkData.value));

        if (checkData.value?.hasTauri && checkData.value?.href !== "about:blank") {
          console.log("[Setup] Found Tauri window with real URL:", handle);
          return;
        }

        // Check if there's a frame with Tauri
        if (checkData.value?.frames) {
          for (const frame of checkData.value.frames) {
            if (frame.hasTauri && frame.href !== "about:blank") {
              console.log("[Setup] Found Tauri frame:", frame.index);
              // Switch to this frame
              await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/frame`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: frame.index }),
              });
              return;
            }
          }
        }
      }
    } catch (e) {
      console.log(`[Setup] Error checking window ${handle}:`, (e as Error).message);
    }
  }

  console.log("[Setup] No Tauri window found with real URL, using current window");
}

/**
 * Wait for the window/document to be ready - must have a real URL (not about:blank)
 */
async function waitForDocumentReady(sessionId: string, timeout = 60000): Promise<void> {
  const start = Date.now();

  // Wait for app to start loading (reduced from 5s to 1s - poll-based approach is more efficient)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  while (Date.now() - start < timeout) {
    // Try to switch to the correct window each iteration
    await switchToAppWindow(sessionId);

    try {
      // Check if document is ready and has a real URL
      const script = `
        const callback = arguments[arguments.length - 1];
        callback({
          ready: document.readyState === 'complete',
          hasTauri: !!window.__TAURI_INTERNALS__,
          origin: window.location.origin,
          href: window.location.href,
          protocol: window.location.protocol,
          host: window.location.host,
          isRealUrl: window.location.href !== 'about:blank' && window.location.protocol !== 'about:'
        });
      `;

      const response = await fetch(
        `${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script, args: [] }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log("[Setup] Document state:", JSON.stringify(data.value));

        // Need document ready, Tauri available, AND a real URL
        if (data.value?.ready && data.value?.hasTauri && data.value?.isRealUrl) {
          console.log("[Setup] Document fully ready, origin:", data.value.origin, "protocol:", data.value.protocol, "href:", data.value.href);
          return;
        }

        // If we have Tauri but still on about:blank, keep waiting
        if (data.value?.hasTauri && !data.value?.isRealUrl) {
          console.log("[Setup] Tauri available but still on about:blank, waiting for navigation...");
        }
      }
    } catch (e) {
      console.log("[Setup] Wait error:", (e as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Document not ready or still on about:blank within ${timeout}ms`);
}

/**
 * Wait for the Tauri app to be ready to accept commands
 */
async function waitForAppReady(sessionId: string, timeout = 30000): Promise<void> {
  // First, ensure document is loaded
  await waitForDocumentReady(sessionId);

  // Small delay to ensure Tauri IPC is fully initialized (reduced from 2s to 500ms)
  await new Promise((resolve) => setTimeout(resolve, 500));

  const start = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - start < timeout) {
    try {
      // Try a simple command to check if app is ready
      await invokeTauriCommand(sessionId, "list_vaults", {});
      console.log("[Setup] Tauri app is ready to accept commands");
      return;
    } catch (error) {
      lastError = error as Error;
      console.log("[Setup] Waiting for Tauri IPC...", (error as Error).message?.substring(0, 80));
      // Wait and retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error(`Tauri app not ready within ${timeout}ms: ${lastError?.message}`);
}

/**
 * Create and open a test vault
 */
async function initializeTestVault(sessionId: string): Promise<void> {
  console.log("[Setup] Waiting for Tauri app to be ready...");
  await waitForAppReady(sessionId);

  console.log("[Setup] Checking for existing vaults...");

  // List existing vaults to check if our test vault exists
  const vaults = await invokeTauriCommand<VaultInfo[]>(
    sessionId,
    "list_vaults",
    {}
  );

  const existingVault = vaults.find((v) => v.name === TEST_VAULT_NAME);

  if (!existingVault) {
    // Create vault if it doesn't exist. create_encrypted_database creates AND opens it.
    console.log("[Setup] Creating new test vault...");
    try {
      await invokeTauriCommand(sessionId, "create_encrypted_database", {
        vaultName: TEST_VAULT_NAME,
        key: TEST_VAULT_PASSWORD,
        spaceId: null,
      });
    } catch (e: any) {
      console.error("[Setup] create_encrypted_database error:", e?.message || e);
      console.error("[Setup] Error type:", typeof e, "keys:", e ? Object.keys(e) : "null");
      console.error("[Setup] Full error:", JSON.stringify(e, null, 2));
      throw e;
    }
    // Close it again so the UI flow can open it properly (with Pinia store + extensions)
    await invokeTauriCommand(sessionId, "close_database", {}).catch(() => {});
    console.log("[Setup] Test vault created (will be opened via UI)");
  } else {
    console.log("[Setup] Test vault already exists (will be opened via UI)");
  }

  // Open the vault through the real UI flow so the full Nuxt lifecycle runs:
  // vault picker → password dialog → vaultStore.openAsync() → router push →
  // vault.vue mount → loadExtensionsAsync()
  // This is essential for extensions to register their request handlers.
  console.log("[Setup] Opening vault through UI...");
  // The vault list uses UiButtonContext which wraps the actual <button> inside
  // <div> → <span> (UContextMenu) → <span> (UiButton) → <UTooltip> → <button data-slot="base">.
  // The vault name text lives in a <span class="block"> inside the button.
  // We use a TreeWalker to find any text node containing the vault name,
  // then walk up to the nearest <button> ancestor and click it.
  const clickScript = `
    const cb = arguments[arguments.length - 1];
    const vaultName = '${TEST_VAULT_NAME}';
    // Strategy 1: Find button with data-slot="base" whose textContent includes the vault name
    const slotBtns = [...document.querySelectorAll('button[data-slot="base"]')];
    const slotMatch = slotBtns.find(b => b.textContent?.trim().includes(vaultName));
    if (slotMatch) { slotMatch.click(); cb('clicked'); return; }
    // Strategy 2: Find any element containing the vault name text and click closest button
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent?.trim() === vaultName) {
        const btn = node.parentElement?.closest('button');
        if (btn) { btn.click(); cb('clicked'); return; }
        // No button ancestor - click the parent element directly
        node.parentElement?.click();
        cb('clicked-parent');
        return;
      }
    }
    // Strategy 3: Fallback - broad button search (original approach)
    const btns = [...document.querySelectorAll('button,[role=button]')];
    const vaultBtn = btns.find(b => b.textContent?.trim() === vaultName);
    if (vaultBtn) { vaultBtn.click(); cb('clicked'); return; }
    cb('not-found:' + btns.map(b=>b.textContent?.trim()).filter(Boolean).join(','));
  `;

  // Retry the click script a few times - the vault list may take a moment to render.
  // Between retries, reload the page to re-trigger onMounted → syncLastVaultsAsync().
  // This is needed because onMounted only runs once: if the vault was created via
  // Tauri command AFTER the page loaded, the list stays empty.
  let clickData: { value: string } = { value: "" };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      console.log(`[Setup] Vault button not found, reloading page (${attempt + 1}/5)...`);
      await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    const clickRes = await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: clickScript, args: [] }),
    });
    clickData = await clickRes.json();
    console.log("[Setup] Vault button click:", clickData.value);
    if (clickData.value === "clicked" || clickData.value === "clicked-parent") break;
  }

  if (clickData.value === "clicked" || clickData.value === "clicked-parent") {
    // Wait for password dialog
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Type password using WebDriver sendKeys (more reliable than dispatchEvent)
    const pwInputRes = await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/element`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using: "css selector", value: 'input[type="password"]' }),
    });
    const pwInputData = await pwInputRes.json();
    const inputId = pwInputData.value?.ELEMENT || pwInputData.value?.["element-6066-11e4-a52e-4f735466cecf"];

    if (inputId) {
      await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/element/${inputId}/value`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: TEST_VAULT_PASSWORD }),
      });

      // Click Unlock button
      const unlockScript = `
        const cb = arguments[arguments.length - 1];
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b => b.textContent?.trim() === 'Unlock' || b.textContent?.trim() === 'Entsperren');
        if (btn && !btn.disabled) { btn.click(); cb('unlocked'); }
        else { cb('not-found-or-disabled'); }
      `;
      const unlockRes = await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: unlockScript, args: [] }),
      });
      const unlockData = await unlockRes.json();
      console.log("[Setup] Unlock click:", unlockData.value);
    }

    // Wait for navigation to desktop page and extensions to load
    const maxWait = 30000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      const checkRes = await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/execute/async`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: 'const cb=arguments[arguments.length-1]; cb(location.href);', args: [] }),
      });
      const url = (await checkRes.json()).value;
      if (url?.includes("/vault/")) {
        console.log("[Setup] Desktop page reached:", url);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Wait for extensions to finish loading
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  // Redesigned onboarding: a brand-new vault now shows the WelcomeDialog
  // (name + device + tour offer) instead of silently auto-registering the
  // device. Complete it here so the shared session lands on a clean desktop
  // for every downstream spec — exactly what the old silent fallback did.
  //
  // Version-tolerance is handled INSIDE completeWelcomeOnboarding: it returns
  // false (without throwing) when the dialog never appears, covering both
  // older vault builds and runs where the vault is already onboarded. Any
  // exception that escapes the helper is therefore a real failure (broken
  // click flow, mid-dialog crash, …) and must surface — silently swallowing
  // it would leave the WelcomeDialog blocking the desktop and produce cryptic
  // "launcher-button not found" errors in every downstream spec.
  const welcomeVault = new VaultAutomation("A");
  await welcomeVault.createSession();
  const handled = await completeWelcomeOnboarding(welcomeVault, {
    userName: "E2E User",
    deviceName: "e2e-setup-device",
    timeout: 12_000,
  });
  console.log(
    `[Setup] Welcome onboarding ${handled ? "completed" : "not present (older vault / already onboarded) — skipped"}`,
  );

  console.log("[Setup] Test vault initialized and ready");
}

async function globalSetup() {
  console.log("=== Starting E2E Test Environment ===");

  // Services are now auto-started by /custom-cont-init.d/99-start-services.sh
  // when the container starts. We just need to wait for them to be ready.
  console.log("[Setup] Waiting for services (started by container init)...");

  // Setup marketplace (publish the haex-notes extension)
  // This runs early so the extension is available in the marketplace for UI tests.
  //
  // When haex-notes is the framework-test subject and gets INSTALLED from the
  // marketplace (the default, i.e. SKIP_EXTENSION_INSTALL !== "true"), a publish
  // failure is fatal: if the bundle never lands in the marketplace, every
  // extension spec fails downstream with a cryptic 60s "not found" timeout. So
  // rethrow and log the full error here to surface the real cause in CI.
  //
  // Only stay graceful when the marketplace is genuinely optional for this run
  // (SKIP_EXTENSION_INSTALL=true — extension-agnostic specs that talk to core).
  const marketplaceRequired = process.env.SKIP_EXTENSION_INSTALL !== "true";
  try {
    await setupMarketplace();
  } catch (error) {
    if (marketplaceRequired) {
      // Surface the FULL error: message, any attached HTTP body, and stack.
      console.error("[Setup] Marketplace setup FAILED (required for marketplace-installed haex-notes):");
      console.error(error);
      throw error;
    }
    console.log(
      "[Setup] Marketplace setup failed (SKIP_EXTENSION_INSTALL=true — marketplace optional):",
      (error as Error).message,
    );
  }

  // Seed 'free' tier in sync-server DB if missing.
  // The Drizzle migration creates the tiers table but doesn't insert data.
  // Without a tier, quota checks fail (maxBytes=0 → over-quota on first push).
  try {
    const seedResult = execFileSync("psql", [
      "-U", "postgres",
      "-h", "sync-db",
      "-d", "postgres",
      "-c", "INSERT INTO public.tiers (name, max_storage_bytes, max_spaces, description) VALUES ('free', '104857600', 3, 'Free tier - 100MB') ON CONFLICT (name) DO NOTHING",
    ], { encoding: "utf-8", timeout: 5000 }).trim();
    console.log("[Setup] Tier seeding:", seedResult);
  } catch (error) {
    console.log("[Setup] Tier seeding skipped:", (error as Error).message?.substring(0, 100));
  }

  // Wait for X11 display to be ready before starting screen recording
  await waitForX11Display();

  // Start screen recording early to capture the entire test session
  startScreenRecording();

  // Clean up any old WebDriver session before creating a new one
  await cleanupOldSession();

  // Wait for tauri-driver to be ready
  const driverReady = await waitForTauriDriver();
  if (!driverReady) {
    throw new Error("tauri-driver did not start within timeout");
  }

  // Create WebDriver session - this will start haex-vault via tauri-driver
  // The app uses embedded production assets (no dev server needed)
  console.log("[Setup] Starting haex-vault via tauri-driver...");
  const sessionId = await createWebDriverSession();

  // Increase WebDriver async script timeout from default 30s to 120s.
  // QUIC peer operations (invites, P2P file transfers) can exceed 30s in CI.
  await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}/timeouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: 120_000 }),
  });

  // Save session ID for tests to reuse
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }));
  console.log("[Setup] Session ID saved to", SESSION_FILE);

  // Initialize test vault - this must happen before waiting for WebSocket bridge
  // because the bridge only starts after a vault is opened
  await initializeTestVault(sessionId);

  // Wait for WebSocket bridge to be ready (starts after vault is opened)
  console.log("[Setup] Waiting for WebSocket bridge...");
  const bridgeReady = await waitForWebSocketBridge();
  if (!bridgeReady) {
    throw new Error("WebSocket bridge did not start within timeout");
  }

  // Install haex-notes from the marketplace (the real user flow) so the
  // extension-framework specs (tests/extensions) have a real extension to
  // query. The external-bridge specs talk to haex-vault core (__core__) and
  // need no extension, so they (and other extension-agnostic specs like the
  // welcome-dialog UI spec) can skip this heavier step via
  // SKIP_EXTENSION_INSTALL=true.
  if (process.env.SKIP_EXTENSION_INSTALL === "true") {
    console.log("[Setup] SKIP_EXTENSION_INSTALL=true — skipping haex-notes marketplace install");
  } else {
    console.log("[Setup] Installing haex-notes from the marketplace...");
    const vault = new VaultAutomation("A");
    await vault.createSession();
    try {
      // The vault seeds its default marketplace row to the production URL on
      // open. Repoint it at the local test marketplace so the vault can find
      // haex-notes (published by marketplace-setup.ts to MARKETPLACE_URL).
      const testMarketplaceUrl =
        process.env.MARKETPLACE_URL || "http://marketplace:3001";
      await vault.setDefaultMarketplaceUrl(testMarketplaceUrl);
      console.log(`[Setup] Pointed vault at test marketplace ${testMarketplaceUrl}`);
      await vault.installExtensionFromMarketplace("haex-notes");
      console.log("[Setup] haex-notes installed from marketplace");
    } finally {
      await vault.deleteSession();
    }
  }

  console.log("=== E2E Test Environment Ready ===");
}

/**
 * Clean up old WebDriver session if exists
 * This prevents the "Failed to create WebDriver session: 500" error
 */
async function cleanupOldSession(): Promise<void> {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      console.log("[Setup] Found old session, cleaning up:", sessionData.sessionId);
      await fetch(`${TAURI_DRIVER_URL}/session/${sessionData.sessionId}`, {
        method: "DELETE",
      });
      fs.unlinkSync(SESSION_FILE);
      console.log("[Setup] Old session cleaned up");
    } catch (e) {
      console.log("[Setup] Could not clean up old session:", e);
    }
  }
}

export default globalSetup;
