#!/bin/bash
# Stop all E2E test services
# Note: tauri-driver is NOT stopped here because it's managed by the container init script
# (99-start-services.sh) and should remain running between test runs.

echo "Stopping E2E Test Environment..."

# Stop haex-vault instances started by tests (not the main tauri-driver)
if [ -f /tmp/haex-vault.pid ]; then
    VAULT_PID=$(cat /tmp/haex-vault.pid)
    if kill -0 $VAULT_PID 2>/dev/null; then
        echo "Stopping haex-vault (PID $VAULT_PID)..."
        kill $VAULT_PID
    fi
    rm /tmp/haex-vault.pid
fi

# Don't stop tauri-driver - it's managed by the container init script
# and should remain running for subsequent test runs.
# pkill -f tauri-driver 2>/dev/null || true  # REMOVED

echo "All services stopped."
