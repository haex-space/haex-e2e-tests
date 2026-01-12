import * as fs from "node:fs";
import { spawn, execSync } from "node:child_process";

// tauri-driver WebDriver URL
const TAURI_DRIVER_URL = "http://localhost:4444";
const SESSION_FILE = "/tmp/e2e-webdriver-session.json";
const EXTENSION_ID_FILE = "/tmp/e2e-haex-pass-extension-id.txt";
const FFMPEG_PID_FILE = "/tmp/e2e-ffmpeg-recording.pid";
const VIDEO_OUTPUT_PATH = "/app/test-results/artifacts/desktop-recording.webm";

// Test vault configuration
const TEST_VAULT_NAME = "e2e-test-vault";
const TEST_VAULT_PASSWORD = "test-password-12345";

// haex-pass extension configuration (from /repos/haextension/apps/haex-pass/haextension/)
const HAEX_PASS_MANIFEST = {
  name: "haex-pass",
  version: "1.4.31",
  author: "haex",
  entry: "index.html",
  icon: "haextension/haex-pass-logo.png",
  publicKey: "b4401f13f65e576b8a30ff9fd83df82a8bb707e1994d40c99996fe88603cefca",
  signature: "", // Empty for dev/test
  permissions: {
    database: [],
    filesystem: [],
    http: [{ target: "https://icons.duckduckgo.com/*" }],
    shell: [],
  },
  homepage: null,
  description: "A password manager for HaexSpace",
  singleInstance: true,
  displayMode: "auto",
  migrationsDir: "database/migrations",
};

/**
 * Get the current X11 display resolution
 */
function getDisplayResolution(): string {
  try {
    const output = execSync("DISPLAY=:1 xdpyinfo 2>/dev/null | grep dimensions", {
      encoding: "utf-8",
    });
    // Output format: "  dimensions:    1024x768 pixels (271x203 millimeters)"
    const match = output.match(/(\d+x\d+)/);
    if (match) {
      console.log("[Setup] Detected display resolution:", match[1]);
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
  const response = await fetch(`${TAURI_DRIVER_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          "tauri:options": {
            application: "/repos/haex-vault/src-tauri/target/release/haex-space",
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
      .catch(error => callback({ success: false, error: error.message || String(error) }));
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
      const errorMsg = typeof result.error === "object" ? JSON.stringify(result.error, null, 2) : result.error;
      throw new Error(`Tauri command '${command}' failed: ${errorMsg}`);
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

// Path to packaged haex-pass extension (created by Dockerfile)
const HAEX_PASS_PACKAGE = "/app/haex-pass.haex";

/**
 * Install haex-pass extension in vault
 * This is required for browser extension clients to be authorized (FK constraint)
 * AND for the extension to actually handle requests
 */
async function installHaexPassExtension(sessionId: string): Promise<void> {
  console.log("[Setup] Installing haex-pass extension...");

  // Check if packaged extension exists
  if (!fs.existsSync(HAEX_PASS_PACKAGE)) {
    console.log("[Setup] No packaged extension found at", HAEX_PASS_PACKAGE);
    console.log("[Setup] Falling back to database-only registration...");
    await registerHaexPassInDatabase(sessionId);
    return;
  }

  try {
    // Read extension package as bytes
    const fileBytes = fs.readFileSync(HAEX_PASS_PACKAGE);
    const fileArray = Array.from(fileBytes); // Convert to array for JSON serialization

    console.log("[Setup] Extension package size:", fileBytes.length, "bytes");

    // Install extension with default permissions
    const extensionId = await invokeTauriCommand<string>(
      sessionId,
      "install_extension_with_permissions",
      {
        fileBytes: fileArray,
        customPermissions: {
          database: [],
          filesystem: [],
          http: [],
          shell: [],
        },
      }
    );

    console.log("[Setup] haex-pass extension installed with ID:", extensionId);
    fs.writeFileSync(EXTENSION_ID_FILE, extensionId);
    console.log("[Setup] Extension ID saved to", EXTENSION_ID_FILE);
  } catch (error) {
    const errorMsg = String(error);
    console.log("[Setup] Extension installation error:", errorMsg);

    if (errorMsg.includes("already exists") || errorMsg.includes("UNIQUE constraint")) {
      console.log("[Setup] haex-pass extension already installed");
      // Get existing extension ID
      try {
        const existingId = await getExistingExtensionId(sessionId);
        if (existingId) {
          fs.writeFileSync(EXTENSION_ID_FILE, existingId);
          console.log("[Setup] Existing extension ID saved:", existingId);
        }
      } catch (e) {
        console.error("[Setup] Warning: Could not get existing extension ID:", e);
      }
    } else {
      // Fall back to database-only registration
      console.log("[Setup] Full installation failed, trying database-only registration...");
      await registerHaexPassInDatabase(sessionId);
    }
  }
}

/**
 * Register haex-pass extension in database only (without files)
 * This allows authorization to work but extension won't handle requests
 */
async function registerHaexPassInDatabase(sessionId: string): Promise<void> {
  console.log("[Setup] Registering haex-pass extension in database...");

  try {
    const extensionId = await invokeTauriCommand<string>(
      sessionId,
      "register_extension_in_database",
      {
        manifest: HAEX_PASS_MANIFEST,
        customPermissions: {
          database: [],
          filesystem: [],
          http: [],
          shell: [],
        },
      }
    );

    console.log("[Setup] haex-pass extension registered with ID:", extensionId);
    fs.writeFileSync(EXTENSION_ID_FILE, extensionId);
    console.log("[Setup] Extension ID saved to", EXTENSION_ID_FILE);
  } catch (error) {
    const errorMsg = String(error);
    if (errorMsg.includes("already exists") || errorMsg.includes("UNIQUE constraint")) {
      console.log("[Setup] haex-pass extension already registered");
      const existingId = await getExistingExtensionId(sessionId);
      if (existingId) {
        fs.writeFileSync(EXTENSION_ID_FILE, existingId);
        console.log("[Setup] Existing extension ID saved:", existingId);
      }
    } else {
      throw error;
    }
  }
}

/**
 * Get the extension ID for an already registered extension
 */
async function getExistingExtensionId(sessionId: string): Promise<string | null> {
  const extensions = await invokeTauriCommand<Array<{ id: string; name: string }>>(
    sessionId,
    "get_all_extensions",
    {}
  );
  const haexPass = extensions.find((ext) => ext.name === "haex-pass");
  return haexPass?.id ?? null;
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

  // Wait for app to start loading
  await new Promise((resolve) => setTimeout(resolve, 5000));

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

  // Add a small delay to ensure Tauri IPC is fully initialized
  await new Promise((resolve) => setTimeout(resolve, 2000));

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

  if (existingVault) {
    console.log("[Setup] Test vault already exists, opening it...");
    await invokeTauriCommand(sessionId, "open_encrypted_database", {
      vaultPath: existingVault.path,
      key: TEST_VAULT_PASSWORD,
    });
  } else {
    console.log("[Setup] Creating new test vault...");
    await invokeTauriCommand(sessionId, "create_encrypted_database", {
      vaultName: TEST_VAULT_NAME,
      key: TEST_VAULT_PASSWORD,
      vaultId: null,
    });
  }

  console.log("[Setup] Test vault initialized and ready");
}

async function globalSetup() {
  console.log("=== Starting E2E Test Environment ===");

  // Services are now auto-started by /custom-cont-init.d/99-start-services.sh
  // when the container starts. We just need to wait for them to be ready.
  console.log("[Setup] Waiting for services (started by container init)...");

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
  // The app will connect to the already-running Nuxt dev server at http://localhost:3003
  console.log("[Setup] Starting haex-vault via tauri-driver...");
  const sessionId = await createWebDriverSession();

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

  // Register haex-pass extension (required for browser extension authorization)
  await installHaexPassExtension(sessionId);

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
