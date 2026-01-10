#!/bin/bash
# Stop all E2E test services

echo "Stopping E2E Test Environment..."

# Stop haex-vault
if [ -f /tmp/haex-vault.pid ]; then
    VAULT_PID=$(cat /tmp/haex-vault.pid)
    if kill -0 $VAULT_PID 2>/dev/null; then
        echo "Stopping haex-vault (PID $VAULT_PID)..."
        kill $VAULT_PID
    fi
    rm /tmp/haex-vault.pid
fi

# Stop tauri-driver
pkill -f tauri-driver 2>/dev/null || true

echo "All services stopped."
