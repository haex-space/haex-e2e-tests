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

# Wait for GTK to be fully ready by testing with a GTK app
# This ensures GTK libraries are loaded and the display is truly ready
echo "Waiting for GTK to be ready..."
for i in {1..30}; do
    if DISPLAY=:1 gtk-query-settings 2>/dev/null | head -1 >/dev/null; then
        echo "GTK is ready!"
        break
    fi
    sleep 1
done

# Additional safety buffer for all desktop components
sleep 3

# Clear vault data for fresh start
VAULT_DATA_DIR="${HOME}/.local/share/haex-space"
if [ -d "$VAULT_DATA_DIR" ]; then
    echo "Removing existing vault data at $VAULT_DATA_DIR"
    rm -rf "$VAULT_DATA_DIR"
fi

# Start tauri-driver with retry logic
start_tauri_driver() {
    echo "Starting tauri-driver..."
    cd /app
    DISPLAY=:1 nohup tauri-driver > /var/log/tauri-driver.log 2>&1 &
    TAURI_PID=$!
    echo "tauri-driver starting with PID $TAURI_PID (log: /var/log/tauri-driver.log)"

    # Wait for tauri-driver to be ready or crash
    for i in {1..15}; do
        if curl -s http://localhost:4444/status >/dev/null 2>&1; then
            echo "tauri-driver is ready!"
            return 0
        fi
        # Check if process is still running
        if ! kill -0 $TAURI_PID 2>/dev/null; then
            echo "tauri-driver crashed, checking log..."
            tail -5 /var/log/tauri-driver.log
            return 1
        fi
        sleep 1
    done
    return 1
}

# Try to start tauri-driver up to 3 times
for attempt in 1 2 3; do
    echo "tauri-driver start attempt $attempt/3"
    if start_tauri_driver; then
        break
    fi
    if [ $attempt -lt 3 ]; then
        echo "Waiting 5 seconds before retry..."
        sleep 5
    fi
done

# Final check
if ! curl -s http://localhost:4444/status >/dev/null 2>&1; then
    echo "WARNING: tauri-driver failed to start after 3 attempts"
fi

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
echo "  - tauri-driver: http://localhost:4444 (iptables redirect from 0.0.0.0)"
echo "  - WebSocket bridge: ws://localhost:19455 (iptables redirect from 0.0.0.0)"
echo ""
