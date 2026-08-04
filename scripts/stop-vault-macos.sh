#!/bin/bash
# Stops the tauri-webdriver CLI started by start-vault-macos.sh (see
# .github/workflows/e2e-tests.yml's e2e-macos job).

set -uo pipefail

pid_file="$RUNNER_TEMP/tauri-webdriver.pid"
if [ -f "$pid_file" ]; then
  driver_pid=$(cat "$pid_file")
  echo "Stopping tauri-webdriver CLI (PID $driver_pid)..."
  kill "$driver_pid" 2>/dev/null || true
  rm -f "$pid_file"
fi

pkill -f "Haex Vault.app" 2>/dev/null || true
