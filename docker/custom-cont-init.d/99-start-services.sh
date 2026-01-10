#!/bin/bash
# Auto-start services for E2E testing
# This script runs automatically when the container starts (webtop s6-overlay)

echo "=== Auto-starting E2E services ==="

# Wait for X11 display to be ready
echo "Waiting for X11 display..."
for i in {1..60}; do
    if xdpyinfo -display :1 >/dev/null 2>&1; then
        echo "X11 display is ready!"
        break
    fi
    sleep 1
done

# Additional wait for GTK initialization
sleep 5

# Clear vault data for fresh start
VAULT_DATA_DIR="${HOME}/.local/share/haex-space"
if [ -d "$VAULT_DATA_DIR" ]; then
    echo "Removing existing vault data at $VAULT_DATA_DIR"
    rm -rf "$VAULT_DATA_DIR"
fi

# Start Nuxt dev server in background
echo "Starting Nuxt dev server..."
cd /repos/haex-vault
NUXT_HOST=0.0.0.0 nohup pnpm dev > /var/log/nuxt-dev.log 2>&1 &
echo "Nuxt dev server starting (log: /var/log/nuxt-dev.log)"

# Wait for Nuxt dev server
echo "Waiting for Nuxt dev server on port 3003..."
for i in {1..120}; do
    if curl -s http://localhost:3003 >/dev/null 2>&1; then
        echo "Nuxt dev server is ready!"
        break
    fi
    sleep 1
done

# Start tauri-driver
echo "Starting tauri-driver..."
cd /app
DISPLAY=:1 nohup tauri-driver > /var/log/tauri-driver.log 2>&1 &
echo "tauri-driver starting (log: /var/log/tauri-driver.log)"

# Wait for tauri-driver
echo "Waiting for tauri-driver..."
for i in {1..30}; do
    if curl -s http://localhost:4444/status >/dev/null 2>&1; then
        echo "tauri-driver is ready!"
        break
    fi
    sleep 1
done

# Start socat proxies for external access
# tauri-driver binds to 127.0.0.1:4444, WebKitWebDriver uses 4445
# We use socat on port 4446 for tauri-driver and 19456 for WebSocket bridge
echo "Starting socat proxies for external access..."
if command -v socat &> /dev/null; then
    # Docker maps host:4444 -> container:4446, socat forwards to 127.0.0.1:4444
    nohup socat TCP-LISTEN:4446,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:4444 > /var/log/socat-tauri.log 2>&1 &
    # Docker maps host:19455 -> container:19456, socat forwards to 127.0.0.1:19455
    nohup socat TCP-LISTEN:19456,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:19455 > /var/log/socat-bridge.log 2>&1 &
    echo "socat proxies started on 0.0.0.0:4446 -> 127.0.0.1:4444 and 0.0.0.0:19456 -> 127.0.0.1:19455"
else
    echo "Warning: socat not available, external access may not work"
fi

echo ""
echo "=== E2E services started ==="
echo "  - Nuxt dev server: http://localhost:3003"
echo "  - tauri-driver: http://localhost:4444 (iptables redirect from 0.0.0.0)"
echo "  - WebSocket bridge: ws://localhost:19455 (iptables redirect from 0.0.0.0)"
echo ""
