import { execSync } from "node:child_process";
import * as fs from "node:fs";

const SESSION_FILE = "/tmp/e2e-webdriver-session.json";
const TAURI_DRIVER_URL = "http://localhost:4444";

async function globalTeardown() {
  console.log("Stopping E2E test environment...");

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
