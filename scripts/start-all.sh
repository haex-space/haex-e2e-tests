#!/bin/bash
# Start all services for E2E testing
# Uses Dev-Server mode to avoid WebKit about:blank origin issue

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Starting E2E Test Environment (Dev-Server Mode) ==="

# Clear vault data for fresh start
echo "Clearing vault data for fresh test environment..."
VAULT_DATA_DIR="${HOME}/.local/share/haex-space"
if [ -d "$VAULT_DATA_DIR" ]; then
    echo "Removing existing vault data at $VAULT_DATA_DIR"
    rm -rf "$VAULT_DATA_DIR"
fi

# Wait for X11/Desktop to be ready (webtop needs time to initialize)
echo "Waiting for X11 display to be ready..."
for i in {1..60}; do
    if xdpyinfo -display :1 >/dev/null 2>&1; then
        echo "X11 display is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Warning: X11 display check timed out, continuing anyway..."
    fi
    sleep 1
done

# Additional wait for GTK to be fully initialized
echo "Waiting for GTK initialization..."
sleep 5

# Start Nuxt dev server in background (for Dev-Server mode)
# The Tauri binary was built with frontendDist: "http://localhost:3003"
# so it will connect to this dev server instead of using embedded assets
echo "Starting Nuxt dev server..."
cd /repos/haex-vault
NUXT_HOST=0.0.0.0 pnpm dev &
NUXT_PID=$!
echo "Nuxt dev server started with PID $NUXT_PID"

# Wait for Nuxt dev server to be ready
echo "Waiting for Nuxt dev server on port 3003..."
for i in {1..120}; do
    if curl -s http://localhost:3003 >/dev/null 2>&1; then
        echo "Nuxt dev server is ready!"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "Warning: Nuxt dev server check timed out, continuing anyway..."
    fi
    sleep 1
done

# Start tauri-driver (WebDriver for Tauri apps)
# tauri-driver will start the haex-vault binary when tests create a WebDriver session
# The binary was built with frontendDist pointing to the already-running dev server
echo "Starting tauri-driver..."
cd /app
DISPLAY=:1 tauri-driver &
TAURI_DRIVER_PID=$!
echo "tauri-driver started with PID $TAURI_DRIVER_PID"

# Wait for tauri-driver to be ready
echo "Waiting for tauri-driver..."
for i in {1..30}; do
    if curl -s http://localhost:4444/status >/dev/null 2>&1; then
        echo "tauri-driver is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Warning: tauri-driver check timed out, continuing anyway..."
    fi
    sleep 1
done

# Note: haex-vault will be started by tauri-driver when tests create a WebDriver session
# The app will connect to the already-running Nuxt dev server at http://localhost:3003
# This gives a valid HTTP origin instead of about:blank

# Start socat proxy for cross-container communication (dual-vault tests)
# tauri-driver only binds to 127.0.0.1, so we need socat to expose it on 0.0.0.0
echo "Starting socat proxy for cross-container access..."
if command -v socat &> /dev/null; then
    nohup socat TCP-LISTEN:4446,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:4444 > /dev/null 2>&1 &
    echo "socat proxy started on port 4446"
else
    echo "Warning: socat not installed, cross-container tests may fail"
fi

echo ""
echo "=== E2E Test Environment Ready ==="
echo ""
echo "Services running:"
echo "  - Nuxt dev server: http://localhost:3003"
echo "  - tauri-driver (WebDriver): http://localhost:4444"
echo "  - socat proxy: http://0.0.0.0:4446 -> localhost:4444"
echo "  - haex-vault: Will be started by tests via tauri-driver"
echo ""
echo "Run tests with: pnpm test"
