# Projektübersicht: haex-e2e-tests

## Zweck
E2E-Test-Suite für das haex-Ökosystem - testet die Integration aller Komponenten von der Browser-Extension über die Vault-API bis zur Multi-Device-Synchronisation.

## Getestete Komponenten
- **haex-vault**: Tauri-basierter Desktop-Passwortmanager
- **haex-pass**: Passwort-Management API/Library
- **haextension**: Browser-Extension für Autofill
- **haex-sync-server**: Backend für Multi-Device-Sync

## Tech-Stack

| Technologie | Version | Zweck |
|-------------|---------|-------|
| Playwright | 1.49.0 | E2E-Test-Framework |
| TypeScript | 5.7.2 | Typsichere Tests |
| Docker | - | Containerisierte Testumgebung |
| PostgreSQL | 15.8 | Datenbank für Sync-Server |
| Node.js | 22 | Runtime |
| ws | 8.18.0 | WebSocket-Client für Bridge |

## Projektstruktur

```
haex-e2e-tests/
├── docker/
│   ├── Dockerfile              # Multi-Stage Build (webtop + Playwright + Tauri)
│   └── docker-compose.yml      # PostgreSQL + Sync-Server + E2E-Container
├── fixtures/
│   ├── test-data.ts            # haex-pass Test-Einträge
│   └── sync-test-data.ts       # Multi-Device Sync-Szenarien
├── scripts/
│   ├── start-all.sh            # Startet Vault + Tauri-Driver
│   ├── start-vault.sh          # Einzelner Vault-Start
│   └── stop-all.sh             # Cleanup
├── tests/
│   ├── fixtures.ts             # Playwright-Fixtures + Helper (~1100 Zeilen)
│   ├── global-setup.ts         # Testumgebung initialisieren
│   ├── global-teardown.ts      # Cleanup nach Tests
│   ├── haex-pass/              # API-Tests (4 Suites)
│   │   ├── authorization-flow.spec.ts
│   │   ├── get-logins.spec.ts
│   │   ├── get-totp.spec.ts
│   │   └── set-login.spec.ts
│   └── sync/                   # Sync-Tests (3 Suites)
│       ├── local-changes.spec.ts
│       ├── multi-device.spec.ts
│       └── pull-events.spec.ts
├── playwright.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

## NPM Scripts

```bash
pnpm test              # Alle Tests ausführen
pnpm test:headed       # Mit sichtbarem Browser
pnpm test:debug        # Debug-Modus mit Playwright Inspector
```

## Wichtige Dateien

| Datei | Beschreibung |
|-------|--------------|
| `tests/fixtures.ts` | Zentrale Test-Infrastruktur, alle Helper-Klassen |
| `playwright.config.ts` | Test-Konfiguration, Reporter, Timeouts |
| `docker/docker-compose.yml` | Komplette Testumgebung |
| `fixtures/test-data.ts` | Vordefinierte Test-Einträge |

## Implementierungsstatus

| Bereich | Status | Details |
|---------|--------|---------|
| haex-pass API Tests | ✅ | Auth, Logins, TOTP, Set-Login |
| Sync-Tests | ✅ | Local-Changes, Multi-Device, Pull-Events |
| Test-Infrastruktur | ✅ | Fixtures, Bridge-Client, Automation |
| Docker-Umgebung | ✅ | Vollständig containerisiert |
| CI/CD | ✅ | Retry-Logik, Artefakte |
