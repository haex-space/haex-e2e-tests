# Starts tauri-driver for the native Windows E2E leg (see
# .github/workflows/e2e-tests.yml's e2e-windows job).
#
# tauri-driver itself launches haex-vault.exe when the Playwright test suite
# creates a WebDriver session (see tests/global-setup.ts / tests/fixtures.ts,
# "tauri:options.application") — this script does not start the app
# directly, only the driver, plus the environment the app needs once
# tauri-driver spawns it as a child process (env vars are inherited).
#
# BackendHost is the Tailscale MagicDNS name of the e2e-backend-windows job
# (docker/docker-compose.tailscale.yml publishes the ports referenced below).

param(
    [Parameter(Mandatory = $true)][string]$VaultBinDir,
    [Parameter(Mandatory = $true)][string]$BackendHost
)

$ErrorActionPreference = 'Stop'

$vaultExe = Join-Path $VaultBinDir 'haex-vault.exe'
if (!(Test-Path $vaultExe)) {
    throw "haex-vault.exe not found at $vaultExe"
}

# Same demo JWTs/config as docker/docker-compose.yml's vault-a/vault-b
# services — only the hostnames change (Tailscale host instead of Docker
# service names) since ports are now published via docker-compose.tailscale.yml.
$envVars = @{
    HAEX_VAULT_BINARY_PATH   = $vaultExe
    SYNC_SERVER_URL          = "http://${BackendHost}:8000"
    SUPABASE_ANON_KEY        = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
    SUPABASE_SERVICE_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
    MARKETPLACE_URL          = "http://${BackendHost}:3001"
    MARKETPLACE_SUPABASE_URL = "http://${BackendHost}:8001"
    DATABASE_URL             = "postgresql://postgres:postgres@${BackendHost}:5432/postgres"
    HAEX_RELAY_URL           = "http://${BackendHost}:3340"
    HAEX_E2E_TEST_MODE       = '1'
    VAULT_INSTANCE           = 'A'
    CI                       = 'true'
}

foreach ($key in $envVars.Keys) {
    Set-Item -Path "env:$key" -Value $envVars[$key]
    # GITHUB_ENV only takes effect for *subsequent* steps — this step's own
    # tauri-driver launch below relies on Set-Item above instead.
    "$key=$($envVars[$key])" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}

Write-Host "Starting tauri-driver..."
$driverProcess = Start-Process -FilePath 'tauri-driver' -PassThru `
    -RedirectStandardOutput "$env:RUNNER_TEMP\tauri-driver.log" `
    -RedirectStandardError "$env:RUNNER_TEMP\tauri-driver-err.log"
$driverProcess.Id | Out-File -FilePath "$env:RUNNER_TEMP\tauri-driver.pid" -Encoding utf8

Write-Host "Waiting for tauri-driver to be ready..."
# A cold runner's first launch needs longer than the original 60s budget —
# observed run took ~2 minutes just to start answering /status at all.
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:4444/status' -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        if ($driverProcess.HasExited) {
            Get-Content "$env:RUNNER_TEMP\tauri-driver-err.log" -ErrorAction SilentlyContinue
            throw "tauri-driver exited early with code $($driverProcess.ExitCode)"
        }
    }
    Start-Sleep -Seconds 3
}
if (!$ready) {
    Write-Host '--- tauri-driver stdout ---'
    Get-Content "$env:RUNNER_TEMP\tauri-driver.log" -ErrorAction SilentlyContinue
    Write-Host '--- tauri-driver stderr ---'
    Get-Content "$env:RUNNER_TEMP\tauri-driver-err.log" -ErrorAction SilentlyContinue
    throw 'tauri-driver did not become ready within 8 minutes'
}
Write-Host 'tauri-driver is ready.'
