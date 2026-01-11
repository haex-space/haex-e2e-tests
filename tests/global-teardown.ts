import { execSync } from "node:child_process";
import * as fs from "node:fs";

const SESSION_FILE = "/tmp/e2e-webdriver-session.json";
const TAURI_DRIVER_URL = "http://localhost:4444";
const FFMPEG_PID_FILE = "/tmp/e2e-ffmpeg-recording.pid";
const VIDEO_OUTPUT_PATH = "/app/test-results/artifacts/desktop-recording.webm";

/**
 * Stop ffmpeg screen recording gracefully
 * Sends SIGINT to allow ffmpeg to finalize the video file properly
 */
function stopScreenRecording(): void {
  if (!fs.existsSync(FFMPEG_PID_FILE)) {
    console.log("[Teardown] No ffmpeg recording found");
    return;
  }

  try {
    const pid = parseInt(fs.readFileSync(FFMPEG_PID_FILE, "utf-8").trim(), 10);
    console.log("[Teardown] Stopping screen recording, PID:", pid);

    // Send SIGINT (Ctrl+C) to allow ffmpeg to finalize the file properly
    // SIGTERM would also work but SIGINT is cleaner for ffmpeg
    process.kill(pid, "SIGINT");

    // Wait a moment for ffmpeg to finish writing
    execSync("sleep 2");

    // Clean up PID file
    fs.unlinkSync(FFMPEG_PID_FILE);

    // Verify video was created
    if (fs.existsSync(VIDEO_OUTPUT_PATH)) {
      const stats = fs.statSync(VIDEO_OUTPUT_PATH);
      console.log("[Teardown] Screen recording saved:", VIDEO_OUTPUT_PATH, `(${Math.round(stats.size / 1024)} KB)`);
    } else {
      console.log("[Teardown] Warning: Video file not found at", VIDEO_OUTPUT_PATH);
    }
  } catch (error) {
    console.error("[Teardown] Error stopping screen recording:", error);
  }
}

async function globalTeardown() {
  console.log("Stopping E2E test environment...");

  // Stop screen recording first to ensure video is finalized
  stopScreenRecording();

  // Delete WebDriver session if it exists
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const sessionId = sessionData.sessionId;

      console.log("[Teardown] Deleting WebDriver session:", sessionId);
      await fetch(`${TAURI_DRIVER_URL}/session/${sessionId}`, {
        method: "DELETE",
      });

      fs.unlinkSync(SESSION_FILE);
      console.log("[Teardown] Session deleted and file removed");
    }
  } catch (error) {
    console.error("[Teardown] Failed to delete WebDriver session:", error);
  }

  // Stop remaining services
  try {
    execSync("./scripts/stop-all.sh", {
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Failed to stop test environment:", error);
  }

  console.log("E2E test environment stopped.");
}

export default globalTeardown;
