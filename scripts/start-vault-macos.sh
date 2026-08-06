#!/bin/bash
# Starts the tauri-webdriver CLI for the native macOS E2E leg (see
# .github/workflows/e2e-tests.yml's e2e-macos job).
#
# tauri-driver has no WKWebView support, so macOS uses the community
# tauri-webdriver project (github.com/Choochmeque/tauri-webdriver) instead —
# same W3C WebDriver HTTP surface on port 4444, so tests/global-setup.ts and
# tests/fixtures.ts don't need to know which one is behind it. That CLI
# spawns the app itself once a WebDriver session is created (see
# HAEX_VAULT_BINARY_PATH usage there) — this script only starts the driver
# and the environment the app needs once spawned (env vars are inherited).
#
# Usage: start-vault-macos.sh <vault-bin-dir> <backend-host>
# backend-host is the Tailscale MagicDNS name of the e2e-backend-macos job
# (docker/docker-compose.tailscale.yml publishes the ports referenced below).

set -euo pipefail

VAULT_BIN_DIR="$1"
BACKEND_HOST="$2"

# build.yml uploads both "bundle/macos/Haex Vault.app" and "database" in one
# artifact, so actions/upload-artifact roots the zip at their common parent
# ("release/") — the app ends up nested under "bundle/macos/", not directly
# in VAULT_BIN_DIR. Search for it instead of assuming a fixed depth so this
# doesn't silently break again if the upload paths change.
app_dir=$(find "$VAULT_BIN_DIR" -maxdepth 4 -type d -name "Haex Vault.app" | head -1)
if [ -z "$app_dir" ]; then
  echo "::error::Haex Vault.app not found anywhere under $VAULT_BIN_DIR"
  exit 1
fi
app_exe=""
for candidate in "$app_dir/Contents/MacOS"/*; do
  # actions/download-artifact re-extracts its zip with default (non-executable)
  # file modes, so the binary needs +x restored before it can be launched —
  # same reasoning as the Linux job's `chmod +x` after its artifact download.
  if [ -f "$candidate" ]; then
    chmod +x "$candidate"
    app_exe="$candidate"
    break
  fi
done
if [ -z "$app_exe" ]; then
  echo "::error::macOS app executable not found under $app_dir/Contents/MacOS"
  exit 1
fi

# Same demo JWTs/config as docker/docker-compose.yml's vault-a/vault-b
# services — only the hostnames change (Tailscale host instead of Docker
# service names) since ports are now published via docker-compose.tailscale.yml.
{
  echo "HAEX_VAULT_BINARY_PATH=$app_exe"
  echo "SYNC_SERVER_URL=http://$BACKEND_HOST:8000"
  echo "SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  echo "SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
  echo "MARKETPLACE_URL=http://$BACKEND_HOST:3001"
  echo "MARKETPLACE_SUPABASE_URL=http://$BACKEND_HOST:8001"
  echo "DATABASE_URL=postgresql://postgres:postgres@$BACKEND_HOST:5432/postgres"
  echo "HAEX_RELAY_URL=http://$BACKEND_HOST:3340"
  echo "HAEX_E2E_TEST_MODE=1"
  echo "VAULT_INSTANCE=A"
  echo "CI=true"
} >> "$GITHUB_ENV"

# GITHUB_ENV only takes effect for *subsequent* steps — this step's own
# driver launch below needs it exported directly too.
export HAEX_VAULT_BINARY_PATH="$app_exe"

# Binary name confirmed against crates.io metadata — see the matching note
# on the "Install tauri-webdriver" step in .github/workflows/e2e-tests.yml.
# Still not yet run against a real macOS runner.
echo "Starting tauri-webdriver..."
nohup tauri-webdriver > "$RUNNER_TEMP/tauri-webdriver.log" 2>&1 &
echo $! > "$RUNNER_TEMP/tauri-webdriver.pid"

echo "Waiting for WebDriver server to be ready..."
for _ in $(seq 1 30); do
  if curl -s http://localhost:4444/status > /dev/null 2>&1; then
    echo "WebDriver server is ready."
    exit 0
  fi
  sleep 2
done

echo "::error::WebDriver server did not become ready within 60 seconds"
cat "$RUNNER_TEMP/tauri-webdriver.log" || true
exit 1
