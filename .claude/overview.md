# Projektübersicht: haex-e2e-tests

## Zweck
E2E-Test-Suite für das haex-Ökosystem - testet die Integration aller Komponenten von der Browser-Extension über die Vault-API bis zur Multi-Device-Synchronisation.

## Getestete Komponenten
- **haex-vault**: Tauri-basierter Desktop-Passwortmanager (100+ Tauri Commands)
- **haex-pass**: Passwort-Management Extension (via Browser Bridge)
- **haex-sync-server**: Backend für Multi-Device-Sync (25+ API Endpoints)
- **haextension**: Browser-Extension für Autofill

## Tech-Stack

| Technologie | Version | Zweck |
|-------------|---------|-------|
| Playwright | 1.49.0 | E2E-Test-Framework |
| TypeScript | 5.7.2 | Typsichere Tests |
| Docker | - | Containerisierte Testumgebung |
| PostgreSQL | 15.8 | Datenbank für Sync-Server |
| Node.js | 22 | Runtime |
| ws | 8.18.0 | WebSocket-Client für Bridge |

## Projektstruktur (nach Rebuild 2026-03-16)

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
│   ├── fixtures.ts             # Zentrale Infrastruktur (VaultBridgeClient, VaultAutomation, SyncServerClient)
│   ├── haex-pass-api.ts        # HAEX_PASS_METHODS Konstanten
│   ├── marketplace-setup.ts    # Marketplace Extension Publishing
│   ├── global-setup.ts         # Testumgebung initialisieren
│   ├── global-teardown.ts      # Cleanup nach Tests
│   ├── helpers/
│   │   ├── index.ts            # Re-exports
│   │   ├── sql-helpers.ts      # Type-safe SQL Wrappers (SqlHelpers)
│   │   ├── tauri-sql-types.ts  # SQL Command Types & Constants
│   │   └── sync-server-helpers.ts  # Identity, Auth, Sync API Helpers
│   ├── vault-lifecycle/        # 4 Suites: create, open/close, password, delete
│   ├── database/               # 4 Suites: CRUD, CRDT, tombstones, migrations
│   ├── identity-auth/          # 2 Suites: register, challenge-login
│   ├── sync/                   # 5 Suites: vault-keys, push, pull, batch, conflicts
│   ├── spaces/                 # 3 Suites: create, members, tokens
│   ├── extensions/             # 3 Suites: install, permissions, limits
│   ├── haex-pass/              # 5 Suites: auth, logins, create/update, TOTP, clients
│   ├── storage/                # 2 Suites: S3 backend, P2P storage
│   └── ui/                     # 2 Suites: start page, logging
├── docs/plans/                 # Implementierungspläne
├── playwright.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Test-Abdeckung (30 Spec-Dateien, ~120 Tests)

| Bereich | Dateien | Tests | Was wird geprüft |
|---------|---------|-------|-----------------|
| Vault Lifecycle | 4 | ~16 | Create, open/close/persist, password change, delete |
| Database & CRDT | 4 | ~26 | CRUD, CRDT columns, tombstones, migrations |
| Identity & Auth | 2 | ~8 | DID registration, challenge-response login |
| Sync Backend | 5 | ~24 | Push, pull, LWW conflicts, batches, vault keys |
| Shared Spaces | 3 | ~16 | Create/delete, members, access tokens |
| Extensions | 3 | ~14 | Install/info, permissions, resource limits |
| haex-pass Bridge | 5 | ~24 | Auth flow, logins, TOTP, create/update, client mgmt |
| Storage | 2 | ~8 | S3 backend, P2P peer storage |
| UI & Logging | 2 | ~6 | Page structure, DB info, system logging |

## Wichtige Dateien

| Datei | Beschreibung |
|-------|--------------|
| `tests/fixtures.ts` | VaultBridgeClient (ECDH+AES), VaultAutomation (WebDriver), SyncServerClient |
| `tests/helpers/sql-helpers.ts` | SqlHelpers mit CRDT-aware CRUD |
| `tests/helpers/sync-server-helpers.ts` | Identity/Auth/Sync API Helpers |
| `playwright.config.ts` | Sequential execution, 60s timeout, HTML+JSON reporter |
| `docker/docker-compose.yml` | Komplette Testumgebung (Vault A/B, Sync, Supabase) |

## NPM Scripts

```bash
pnpm test              # Alle Tests ausführen
pnpm test:headed       # Mit sichtbarem Browser
pnpm test:debug        # Debug-Modus mit Playwright Inspector
```
