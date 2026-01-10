#!/bin/bash
# Start haex-vault in dev mode for E2E testing
# This provides a valid HTTP origin (localhost:3003) instead of about:blank

set -e

echo "[tauri-dev] Starting haex-vault in dev mode..."

cd /repos/haex-vault

# Start tauri dev in background
# --no-watch: Don't watch for file changes (not needed for E2E tests)
# The beforeDevCommand (pnpm dev) will start Nuxt on port 3003
DISPLAY=:1 /root/.cargo/bin/cargo tauri dev --no-watch &
TAURI_PID=$!

echo "[tauri-dev] Started with PID $TAURI_PID"

# Wait for Nuxt dev server to be ready
echo "[tauri-dev] Waiting for Nuxt dev server on port 3003..."
for i in {1..120}; do
    if curl -s http://localhost:3003 >/dev/null 2>&1; then
        echo "[tauri-dev] Nuxt dev server is ready!"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "[tauri-dev] Warning: Nuxt dev server check timed out"
    fi
    sleep 1
done

# Wait for WebSocket bridge to be ready (indicates Tauri app is running)
echo "[tauri-dev] Waiting for WebSocket bridge on port 19455..."
for i in {1..60}; do
    if nc -z localhost 19455 2>/dev/null; then
        echo "[tauri-dev] WebSocket bridge is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "[tauri-dev] Warning: WebSocket bridge check timed out"
    fi
    sleep 1
done

echo "[tauri-dev] haex-vault dev mode ready"
echo "[tauri-dev] PID: $TAURI_PID"

# Keep running to maintain the background process
wait $TAURI_PID
