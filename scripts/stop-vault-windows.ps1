# Stops the tauri-driver process started by start-vault-windows.ps1 (see
# .github/workflows/e2e-tests.yml's e2e-windows job).

$ErrorActionPreference = 'Continue'

$pidFile = "$env:RUNNER_TEMP\tauri-driver.pid"
if (Test-Path $pidFile) {
    $driverPid = Get-Content $pidFile
    Write-Host "Stopping tauri-driver (PID $driverPid)..."
    Stop-Process -Id $driverPid -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# haex-vault.exe is spawned by tauri-driver as its child; stopping the
# driver doesn't guarantee the child exits, so sweep it explicitly too.
Get-Process -Name 'haex-vault' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
