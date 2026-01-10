# haex-e2e-tests

End-to-End Tests für das haex-Ökosystem: haex-vault, haex-pass und Browser-Extension.

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

Es gibt drei Möglichkeiten, die Versionen für E2E-Tests zu konfigurieren:

### 1. Projekt-Konfigurationsdatei (empfohlen)

Jedes Projekt kann eine `.e2e-versions.json` im Root enthalten, die festlegt, gegen welche Versionen der anderen Services getestet werden soll:

```json
{
  "$schema": "https://raw.githubusercontent.com/haex-space/haex-e2e-tests/main/schemas/e2e-versions.schema.json",
  "project": "haex-vault",
  "dependencies": {
    "haex-vault": "self",
    "haextension": "main",
    "vault-sdk": "main",
    "haex-sync-server": "v1.0.0"
  },
  "profiles": {
    "release": {
      "haex-vault": "self",
      "haextension": "v2.1.0",
      "vault-sdk": "v1.5.0",
      "haex-sync-server": "v1.0.0"
    }
  }
}
```

Der Wert `"self"` wird durch die aktuelle Git-Referenz des Projekts ersetzt (Branch, Tag oder Commit).

```bash
# Versionen aus haex-vault/main laden
source scripts/fetch-project-versions.sh haex-vault

# Versionen aus einem Feature-Branch laden
source scripts/fetch-project-versions.sh haex-vault feat/new-ui

# Mit Version-Profil
source scripts/fetch-project-versions.sh haex-vault main release
```

### 2. Version-Presets

Drei Presets für häufige Szenarien:

```bash
# Main branches (Standard)
pnpm docker:build

# Letzte Release-Versionen
pnpm docker:build:release

# Nightly builds (falls vorhanden)
pnpm docker:build:nightly
```

### 3. Individuelle Versionen

Jede Komponente kann einzeln konfiguriert werden:

```bash
# Spezifische Versionen über Umgebungsvariablen
HAEX_VAULT_VERSION=v1.0.0 \
HAEXTENSION_VERSION=feat/new-ui \
VAULT_SDK_VERSION=main \
HAEX_SYNC_SERVER_VERSION=main \
pnpm docker:build

# Version-Resolver manuell aufrufen
source scripts/resolve-versions.sh release
echo $HAEX_VAULT_VERSION  # Zeigt aufgelöste Version
```

### Umgebungsvariablen

| Variable | Beschreibung | Default |
|----------|--------------|---------|
| `HAEX_VAULT_VERSION` | haex-vault Git-Ref | `main` |
| `HAEXTENSION_VERSION` | haextension Git-Ref | `main` |
| `VAULT_SDK_VERSION` | vault-sdk Git-Ref | `main` |
| `HAEX_SYNC_SERVER_VERSION` | haex-sync-server Git-Ref | `main` |
| `VERSION_PRESET` | Preset: `release`, `nightly`, `main` | - |

Gültige Werte für Versionen:
- `self` (nur in `.e2e-versions.json`): Ersetzt durch aktuelle Git-Ref
- Branch-Namen: `main`, `develop`, `feat/new-ui`
- Tags: `v1.0.0`, `v2.1.3`
- Commit-SHAs: `abc1234`

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
│   ├── haex-pass/              # API-Tests
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
│   ├── fetch-project-versions.sh  # Lädt Versionen aus Projekt-Konfiguration
│   ├── resolve-versions.sh        # Version-Preset Resolver
│   ├── start-all.sh               # Startet alle Services
│   ├── start-vault.sh             # Startet haex-vault
│   └── stop-all.sh                # Stoppt alle Services
├── schemas/
│   └── e2e-versions.schema.json   # JSON-Schema für .e2e-versions.json
├── examples/
│   └── .e2e-versions.example.json # Beispiel-Konfiguration
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
  pnpm test tests/haex-pass/get-logins.spec.ts

# Mit Release-Versionen testen
pnpm docker:test:release
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

**Option 1: Versionen aus Projekt-Konfiguration laden (empfohlen)**

```yaml
# .github/workflows/build.yml
jobs:
  e2e-tests:
    needs: build
    uses: haex-space/haex-e2e-tests/.github/workflows/e2e-tests.yml@main
    with:
      build_type: nightly
      source_project: haex-vault           # Lade .e2e-versions.json aus diesem Repo
      source_ref: ${{ github.sha }}        # Von aktuellem Commit
      # version_profile: release           # Optional: bestimmtes Profil verwenden
```

**Option 2: Versionen direkt angeben**

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
