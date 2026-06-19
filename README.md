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

## Lizenz

MIT
