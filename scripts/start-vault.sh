#!/bin/bash
# Start haex-vault in the background

set -e

# Binary name is "haex-vault" (from Cargo.toml [package].name)
VAULT_BIN="/repos/haex-vault/src-tauri/target/release/haex-vault"

if [ ! -f "$VAULT_BIN" ]; then
    echo "Error: haex-vault binary not found at $VAULT_BIN"
    echo "Please build haex-vault first"
    exit 1
fi

echo "Starting haex-vault..."
# Ensure DISPLAY is set for GTK
export DISPLAY=${DISPLAY:-:1}
$VAULT_BIN &
VAULT_PID=$!

echo "haex-vault started with PID $VAULT_PID"
echo $VAULT_PID > /tmp/haex-vault.pid

# Wait for WebSocket to be ready
echo "Waiting for WebSocket bridge..."
for i in {1..30}; do
    if nc -z localhost 19455 2>/dev/null; then
        echo "WebSocket bridge is ready!"
        exit 0
    fi
    sleep 1
done

echo "Error: WebSocket bridge did not start within 30 seconds"
exit 1
