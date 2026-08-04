# haex-e2e-tests

End-to-End Tests für das haex-Ökosystem: haex-vault (Core, External Bridge, Extension-Framework) und die haex-pass-browser Extension.

## Voraussetzungen

- Docker & Docker Compose
- Node.js 22+ (für lokale Entwicklung)

## Quick Start

```bash
# Docker Image bauen (main branches)
pnpm docker:build

# Container starten (öffnet Desktop auf http://localhost:3000)
pnpm docker:up

# Tests ausführen
pnpm docker:test

# Shell im Container öffnen
pnpm docker:shell

# Container stoppen
pnpm docker:down

# Container stoppen und Volumes löschen
pnpm docker:down:clean
```

## Versionen konfigurieren

Jede Komponente kann über Umgebungsvariablen auf eine beliebige Git-Ref (Branch,
Tag oder Commit-SHA) gepinnt werden:

```bash
HAEX_VAULT_VERSION=v1.0.0 \
HAEXTENSION_VERSION=feat/new-ui \
VAULT_SDK_VERSION=main \
HAEX_SYNC_SERVER_VERSION=main \
pnpm docker:build
```

### Umgebungsvariablen

| Variable | Beschreibung | Default |
|----------|--------------|---------|
| `HAEX_VAULT_VERSION` | haex-vault Git-Ref | `main` |
| `HAEXTENSION_VERSION` | haextension Git-Ref | `main` |
| `VAULT_SDK_VERSION` | vault-sdk Git-Ref | `main` |
| `HAEX_SYNC_SERVER_VERSION` | haex-sync-server Git-Ref | `main` |

## Projektstruktur

```
haex-e2e-tests/
├── .github/
│   └── workflows/
│       └── e2e-tests.yml       # CI: Tests bei Push/PR
├── docker/
│   ├── Dockerfile              # E2E Test-Umgebung (webtop + Tauri + Playwright)
│   ├── Dockerfile.sync-server  # haex-sync-server Image
│   └── docker-compose.yml      # Container-Orchestrierung
├── tests/
│   ├── fixtures.ts             # Playwright Fixtures + Helper
│   ├── global-setup.ts         # Start haex-vault vor Tests
│   ├── global-teardown.ts      # Cleanup nach Tests
│   ├── external-bridge/        # Core-Bridge API-Tests
│   │   ├── authorization-flow.spec.ts
│   │   ├── get-logins.spec.ts
│   │   ├── get-totp.spec.ts
│   │   └── set-login.spec.ts
│   └── sync/                   # Sync-Tests
│       ├── local-changes.spec.ts
│       ├── multi-device.spec.ts
│       └── pull-events.spec.ts
├── fixtures/
│   ├── test-data.ts            # Test-Einträge
│   └── sync-test-data.ts       # Sync-Szenarien
├── scripts/
│   ├── start-all.sh               # Startet alle Services
│   ├── start-tauri-dev.sh         # Startet haex-vault im Dev-Modus
│   ├── start-vault.sh             # Startet haex-vault
│   └── stop-all.sh                # Stoppt alle Services
├── .env.example                   # Umgebungsvariablen-Vorlage
├── playwright.config.ts
├── package.json
└── tsconfig.json
```

## Tests

### Test-Suites

| Suite | Beschreibung |
|-------|--------------|
| `authorization-flow` | Browser-Extension Pairing |
| `get-logins` | Login-Einträge für URL abrufen |
| `get-totp` | TOTP-Codes generieren |
| `set-login` | Neue Einträge erstellen |
| `local-changes` | Lokale Änderungen tracken |
| `multi-device` | Multi-Device Sync |
| `pull-events` | Server-Events verarbeiten |

### Tests ausführen

```bash
# Alle Tests
pnpm docker:test

# Einzelne Test-Suite
docker compose -f docker/docker-compose.yml run --rm e2e-test-env \
  pnpm test tests/external-bridge/get-logins.spec.ts
```

### Im Container (interaktiv)

```bash
pnpm docker:shell
cd /app
pnpm test           # Alle Tests
pnpm test:ui        # Mit Playwright UI
pnpm test:debug     # Debug-Modus
```

## Debugging

Der Container basiert auf `webtop` und bietet einen Desktop unter `http://localhost:3000`.
Dort können Sie:

- haex-vault GUI sehen und bedienen
- Browser mit geladener Extension öffnen
- Tests visuell verfolgen

```bash
# Logs aller Services
pnpm docker:logs

# Nur Sync-Server Logs
docker compose -f docker/docker-compose.yml logs -f sync-server
```

## CI/CD Integration

Die E2E-Tests sind als **reusable workflow** konzipiert und werden von den Build-Pipelines der anderen Projekte (haex-vault, haextension, etc.) aufgerufen.

### Verhalten nach Build-Typ

| Build-Typ | Test-Fehler | Pipeline |
|-----------|-------------|----------|
| `nightly` | Ignoriert | Läuft weiter |
| `release` | Blockiert | Bricht ab |

### Integration in andere Projekte

In der Build-Pipeline des aufrufenden Projekts (z.B. haex-vault):

```yaml
# .github/workflows/build.yml
jobs:
  e2e-tests:
    needs: build
    uses: haex-space/haex-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      build_type: nightly
      haex_vault_version: ${{ github.sha }}  # Aktueller Commit
      haextension_version: main
      vault_sdk_version: main
      sync_server_version: main

  # Bei Release: E2E muss bestehen
  release:
    needs: [build, e2e-tests]
    if: needs.e2e-tests.outputs.success == 'true'
    # ... release steps ...
```

### Manueller Test

```bash
# Workflow manuell starten (GitHub CLI)
gh workflow run e2e-tests.yml \
  -f build_type=nightly \
  -f haex_vault_version=main
```

### Lokale CI-Simulation

```bash
# Wie in CI testen
CI=true docker compose -f docker/docker-compose.yml run --rm e2e-test-env pnpm test
```

### Windows / macOS E2E (haex_vault_platform)

Standardmäßig läuft die Suite nur gegen die Linux-Binary (Docker, wie oben).
`haex_vault_platform: windows` bzw. `macos` schaltet zusätzliche Jobs frei,
die die jeweilige native Binary auf einem GitHub-gehosteten `windows-latest`/
`macos-latest`-Runner testen — ohne eigene (self-hosted) Runner-Infrastruktur.

Da diese Runner den Docker-Backend-Stack nicht selbst hosten können (kein
Linux-Container-Support auf `windows-latest`, kein Docker überhaupt auf
`macos-latest`), läuft der Backend-Stack weiterhin auf einem Linux-Runner und
wird per **ephemerem Tailscale-Mesh** für die Dauer des jeweiligen Runs
erreichbar gemacht (`e2e-backend-windows`/`e2e-backend-macos` Jobs).
`docker/docker-compose.tailscale.yml` published dafür die Ports, die der
native Prozess braucht (die Linux-Jobs bleiben unverändert rein intern).

**Damit das läuft, muss einmalig eingerichtet werden:**

1. Ein Tailscale-Tailnet (kostenloser Tier reicht) + ein Auth Key (Settings →
   Keys → Auth keys) mit Tag `tag:ci-e2e`, **Reusable** und **Ephemeral**
   beide aktiviert (sonst funktioniert nur der allererste CI-Lauf, und alte
   Geräte räumen sich nie automatisch auf). Läuft nach spätestens 90 Tagen ab
   und muss dann manuell erneuert werden.
2. Repo-Secret `TS_AUTHKEY` — sowohl in diesem Repo (für direkte push/PR-
   Trigger) als auch in haex-vault (der `e2e-tests`-Job dort forwarded es per
   `secrets: inherit`).
3. In haex-vault: die Actions-Variable `TAILSCALE_TAILNET_DOMAIN` (die
   MagicDNS-Domain des Tailnets, z.B. `tailXXXX.ts.net`) — wird beim
   E2E-Binary-Build in die CSP eingetragen (`connect-src`), da die
   Tailscale-Hostnamen sonst von der WebView blockiert würden.

**macOS-Sonderfall:** tauri-driver hat kein WKWebView-Support. Der macOS-Pfad
nutzt stattdessen das community-Projekt
[Choochmeque/tauri-webdriver](https://github.com/Choochmeque/tauri-webdriver)
(ein Tauri-Plugin, feature-gated in haex-vaults `Cargo.toml` hinter
`e2e-webdriver-macos`, nie in Produktions-Builds aktiv). Das Projekt ist noch
jung (Stand: früh 2026) und nicht offiziell von tauri-apps unterstützt — die
exakten Install-/CLI-Details in `.github/workflows/e2e-tests.yml` und
`scripts/start-vault-macos.sh` sind gegen dessen README zu verifizieren,
bevor der Windows/macOS-Pfad das erste Mal produktiv läuft.

## Lizenz

MIT
