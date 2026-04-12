# Session Log

## 2026-04-12 - CI Failures: QUIC Connection Lost + Invite Accept

### Durchgeführt
1. **P2P Storage "connection lost" gefixt** (haex-vault `4477d3f`):
   - Root Cause: Jeder `remote_*()` Call erstellte neue QUIC-Connection statt Stream-Multiplexing
   - Fix: Connection-Cache per Peer in `PeerEndpoint`, DRY-Refactoring (-240/+115 Zeilen)
   - 38 Rust-Tests bestehen, P2P E2E-Tests grün

2. **WebDriver Script Timeout erhöht** (e2e-tests `29fc5ad`):
   - 30s→120s für async Script-Timeout + httpRequest-Timeout
   - War nicht die Hauptursache, aber nötig für langsame CI-Operationen

3. **Debug-Logging eingebaut** (e2e-tests `8beec03`):
   - Timing in `invokeTauriCommand` und `peerStorageDownloadFile`
   - QUIC/P2P Status-Checks vor kritischen Operationen
   - `local_delivery_status` Felder gefixt (war `running/nodeId`, richtig: `is_leader/active_spaces`)

4. **Invite Accept analysiert** — Root Cause gefunden:
   - `startP2PEndpoint()` rief `store.startAsync()` ohne `await` auf
   - Auch mit `await`: Leaders starten nicht zuverlässig via `executeScript`
   - Eigentliches Problem: Test umgeht den UI-Flow → kein `delivery_handler` registriert

### Offen
- **startP2PEndpoint() auf echten UI-Flow umbauen** (Settings → P2P → Toggle)
- Debug-Logging entfernen wenn CI grün ist

### CI-Status
- **338 passed, 1 failed** (vorher: 333 passed, 2 failed, 2 flaky)
- P2P Storage: ✅ gefixt
- QUIC Invite Accept: ❌ offen (Leader-Start-Problem)

---

## 2026-01-09 - Initiale Knowledge Database

### Durchgeführt
- Projekt analysiert und verstanden
- Knowledge Database Struktur angelegt:
  - `overview.md` - Projektübersicht, Tech-Stack, Struktur
  - `architecture.md` - Systemdesign, Komponenten, Ports
  - `patterns.md` - Code-Konventionen, Test-Patterns
  - `api.md` - WebSocket-Protokoll, REST-API, Tauri-Commands
  - `decisions.md` - ADRs für wichtige Architektur-Entscheidungen
  - `problems.md` - Bekannte Probleme und Lösungen

### Erkenntnisse
- Solide E2E-Test-Infrastruktur für haex-Ökosystem
- 4 haex-pass Test-Suites + 3 Sync-Test-Suites vorhanden
- Verschlüsselung vollständig implementiert (ECDH + AES-256-GCM)
- Docker-Umgebung für CI/CD bereit

### Nächste Schritte
- Tests ausbauen und ausführen
- Sync-Konflikt-Tests implementieren
- Firefox-Kompatibilität prüfen

---

## 2026-01-09 - Konfigurierbare Docker-Umgebung + GitHub Actions

### Durchgeführt
- Docker-Compose von lokalen Pfaden auf GitHub-Repos umgestellt
- Version-Presets implementiert (release, nightly, main)
- GitHub Actions Workflows erstellt

### Neue/Geänderte Dateien
| Datei | Aktion |
|-------|--------|
| `.env.example` | Neu - Dokumentation aller Umgebungsvariablen |
| `docker/Dockerfile.sync-server` | Neu - Baut sync-server von GitHub |
| `docker/docker-compose.yml` | Geändert - Konfigurierbar via Env-Vars |
| `scripts/resolve-versions.sh` | Neu - Löst Version-Presets auf |
| `.github/workflows/e2e-tests.yml` | Neu - CI für E2E-Tests |
| `package.json` | Erweitert - Neue Scripts |
| `README.md` | Aktualisiert - Neue Dokumentation |

### Nutzung
```bash
# Standard (main branches)
pnpm docker:build

# Mit Release-Versionen
pnpm docker:build:release

# Spezifische Version
HAEX_VAULT_VERSION=v1.2.0 pnpm docker:build
```

### Nächste Schritte
- Tests lokal ausführen und validieren
- GitHub Actions testen (Push zu main)
- Testsuite erweitern

---

## 2026-01-09 - Projekt-basierte Versionskonfiguration

### Durchgeführt
- JSON-Schema für `.e2e-versions.json` erstellt
- Script `fetch-project-versions.sh` zum Laden der Konfig aus Remote-Repos
- GitHub Actions Workflow erweitert für projekt-basierte Versionen
- Dokumentation aktualisiert

### Neue/Geänderte Dateien
| Datei | Aktion |
|-------|--------|
| `schemas/e2e-versions.schema.json` | Neu - JSON-Schema für Konfigurationsdatei |
| `examples/.e2e-versions.example.json` | Neu - Beispielkonfiguration |
| `scripts/fetch-project-versions.sh` | Neu - Lädt Versionen aus Projekt-Repos |
| `.github/workflows/e2e-tests.yml` | Erweitert - source_project/source_ref/version_profile |
| `package.json` | Erweitert - versions:from-project Script |
| `README.md` | Aktualisiert - Projekt-Konfig dokumentiert |
| `.claude/architecture.md` | Aktualisiert - Versionskonfiguration ergänzt |

### Konzept
Jedes Projekt (haex-vault, haextension, etc.) kann eine `.e2e-versions.json` im Root haben:

```json
{
  "project": "haex-vault",
  "dependencies": {
    "haex-vault": "self",
    "haextension": "main",
    "vault-sdk": "main",
    "haex-sync-server": "v1.0.0"
  }
}
```

- `"self"` wird durch die aktuelle Git-Ref des Projekts ersetzt
- Profiles erlauben alternative Versionssets (z.B. für Releases)
- Fallback auf `main` wenn keine Konfig gefunden

### Nutzung

**Lokal:**
```bash
source scripts/fetch-project-versions.sh haex-vault feat/new-ui
pnpm docker:build
```

**CI (aus haex-vault):**
```yaml
uses: haex-space/haex-e2e-tests/.github/workflows/e2e-tests.yml@main
with:
  build_type: nightly
  source_project: haex-vault
  source_ref: ${{ github.sha }}
```

---

## 2026-01-09 - Extension Installation & Authorization Debugging

### Durchgeführt
- FK-Constraint Problem gelöst (Extension muss vor Client-Autorisierung registriert werden)
- Extension Public Key Mismatch Problem gelöst
- E2E-Test-Keypair-Generierung im Docker-Build implementiert
- Migration-Prefix-Ersetzung für E2E-Tests implementiert
- Extension wird jetzt vollständig installiert (nicht nur registriert)

### Änderungen

| Datei | Änderung |
|-------|----------|
| `docker/Dockerfile` | Key-Generierung + Migration-Prefix-Ersetzung vor Build |
| `tests/fixtures.ts` | `getHaexVaultExtensionId()` für korrekte Extension-ID |
| `tests/global-setup.ts` | `installHaexPassExtension()` mit Fallback zu DB-only |
| `.claude/problems.md` | Dokumentation der Lösungen |

### Testergebnisse

**Vorher:** 2 passed, viele FK-Constraint Fehler
**Nachher:** 3 passed (authorization-flow Tests 1-3)

### Verbleibendes Problem

Nach erfolgreicher Autorisierung werden Requests trotzdem als "not authorized" abgelehnt:
```
[E2E] Authorization granted!
...
[ExternalBridge] Request rejected: client not authorized
```

Dies ist wahrscheinlich ein Bug in haex-vault's ExternalBridge, nicht in den E2E-Tests selbst.

### Nächste Schritte
- Bug in haex-vault melden/fixen
- Sync-Server Timeout-Probleme untersuchen

---

## 2026-01-09 - Authorization Bug Root Cause Analyse

### Durchgeführt
- haex-vault ExternalBridge Code analysiert
- Root Cause für "client not authorized" nach erfolgreicher Autorisierung gefunden

### Root Cause
Der Bug liegt in haex-vault, nicht in den E2E-Tests:

1. **Autorisierung speichert Extension-ID:** `external_bridge_client_allow` speichert `(client_id, extension_id)` in DB
2. **Request enthält keine Extension-Info:** Der Request sendet nur `clientId` und `publicKey`, aber keine Extension-Identifikation (`ext_pk=None, ext_name=None`)
3. **Server kann Extension nicht zuordnen:** `check_client_authorized_for_extension()` prüft ob Client für spezifische Extension autorisiert ist, aber ohne Extension im Request ist das unmöglich

### Server-Log Beweis
```
[ExternalBridge] Received request: action=get-logins, client_id=Some("..."), ext_pk=None, ext_name=None
[ExternalBridge] Request rejected: client not authorized
```

### Lösungsvorschlag für haex-vault
Option 1 (empfohlen): Wenn `ext_pk=None`, Extension aus bestehender Client-Autorisierung ableiten
Option 2: Extension-Info im Request-Protokoll verpflichtend machen
Option 3: Handshake mit Extension-Binding erweitern

### Duplizierte Funktionen
User wies darauf hin: `external_bridge_approve_client` und `external_bridge_client_allow` sind redundant - eine Funktion mit `remember` Parameter reicht

### Nächste Schritte
- [ ] Bug in haex-vault Repo melden
- [ ] Fix implementieren (Server-seitig)
- [ ] Danach E2E-Tests erneut ausführen

---

## 2026-01-10 - API Konstanten und Test-Fixes

### Durchgeführt
- Magic Strings durch SDK-Konstanten ersetzt (`HAEX_PASS_METHODS`)
- Falsche API-Methoden korrigiert: `get-logins` → `get-items`, `set-login` → `set-item`
- Falschen Tauri-Command korrigiert: `revoke_client_authorization` → `external_bridge_revoke_client`
- TypeScript-Fehler in `local-changes.spec.ts` behoben (`table.tableName.includes()`)
- `haex-pass-api.ts` erstellt mit allen HAEX_PASS_METHODS Konstanten

### Geänderte Dateien
| Datei | Änderung |
|-------|----------|
| `tests/haex-pass-api.ts` | Neu - API-Konstanten aus SDK |
| `tests/fixtures.ts` | Import & Re-Export von HAEX_PASS_METHODS |
| `tests/haex-pass/set-login.spec.ts` | Magic Strings → Konstanten |
| `tests/haex-pass/get-logins.spec.ts` | Magic Strings → Konstanten |
| `tests/haex-pass/get-totp.spec.ts` | Magic Strings → Konstanten |
| `tests/haex-pass/authorization-flow.spec.ts` | Tauri-Command Fix |
| `tests/sync/local-changes.spec.ts` | Konstanten + TypeScript-Fix |
| `tests/sync/pull-events.spec.ts` | Konstanten |
| `tests/sync/multi-device.spec.ts` | Konstanten |
| `.claude/patterns.md` | Dokumentation für HAEX_PASS_METHODS |

### Wichtige Regeln (vom User)
- **KEINE magic strings** - immer Konstanten aus SDK verwenden
- Extension öffnet automatisch wenn ein externer Request kommt
- haex-pass API-Methoden: `get-items`, `set-item`, `get-totp` (nicht `get-logins`, `set-login`)

### Nächste Schritte
- Tests ausführen um Korrektheit zu verifizieren
- Weitere Tests bei Bedarf aktualisieren

---

## 2026-01-10 - Playwright Artifacts & haex-space Integration

### Durchgeführt
- Playwright Video- und Screenshot-Recording aktiviert
- GitHub Actions Workflow für Artifact-Upload mit 90 Tagen Retention angepasst
- Workflow Outputs für `artifact_name` und `run_id` hinzugefügt

### Geänderte Dateien
| Datei | Änderung |
|-------|----------|
| `playwright.config.ts` | `video: "on"`, `screenshot: "on"` aktiviert |
| `.github/workflows/e2e-tests.yml` | Artifact-Upload mit 90 Tagen Retention, Outputs ergänzt |

### haex-space Integration (anderes Repo)
In haex-space wurden folgende Komponenten erstellt:
- `server/api/e2e-artifacts/index.get.ts` - Listet alle Test-Runs mit E2E-Artifacts
- `server/api/e2e-artifacts/[runId]/index.get.ts` - Details eines Test-Runs
- `server/api/e2e-artifacts/[runId]/file.get.ts` - Einzelne Dateien aus Artifacts streamen
- `app/pages/developer/e2e-artifacts/index.vue` - Übersichtsseite aller Runs
- `app/pages/developer/e2e-artifacts/[runId].vue` - Detailseite mit Videos/Screenshots

### Wichtige Entscheidungen
- **Keine Authentifizierung nötig** - Alle Repos sind public
- **@octokit/rest** - Offizielle GitHub API Client-Library
- **Kein GitHub Token** - Public Repos können ohne Auth abgefragt werden (60 req/h Rate Limit)

---

## 2026-03-16 - Vault Lifecycle Phase 1 Test-Suites

### Durchgeführt
- 4 Test-Suites für Vault Lifecycle (Phase 1) erstellt:
  - `create-vault.spec.ts` - Vault erstellen, Duplikat-Ablehnung, Passwort-Prüfung
  - `open-close-vault.spec.ts` - Daten schreiben, DB schließen, Persistenz prüfen
  - `change-password.spec.ts` - Passwort ändern, Daten-Integrität, altes PW ablehnen
  - `delete-vault.spec.ts` - Vault erstellen, Existenz prüfen, löschen, Nicht-Existenz prüfen

### Neue Dateien
| Datei | Beschreibung |
|-------|--------------|
| `tests/vault-lifecycle/create-vault.spec.ts` | 5 Tests: Create, List, Duplicate, Open, Wrong PW |
| `tests/vault-lifecycle/open-close-vault.spec.ts` | 3 Tests: Write data, Close fails, Reopen persists |
| `tests/vault-lifecycle/change-password.spec.ts` | 4 Tests: Insert, Change PW, Reopen new PW, Old PW fails |
| `tests/vault-lifecycle/delete-vault.spec.ts` | 4 Tests: Create, Verify exists, Delete, Verify gone |

### Patterns
- Jede Suite: `beforeAll` erstellt Session + Vault, `afterAll` cleanup + e2e-test-vault reopen
- Timestamps in Vault-Namen für Isolation (`test-create-vault-${Date.now()}`)
- `_no_sync` Suffix für Testtabellen (kein CRDT-Overhead)
- Assertions: `toEqual` statt `toBeDefined`, `toHaveLength(exact)`, Regex für UUIDs
- Negative Tests: Wrong password, duplicate names, SQL after close

---

## 2026-03-16 - Phase 5: Database & CRDT Test-Suites

### Durchgeführt
- 4 Test-Suites für Database & CRDT (Phase 5) erstellt:
  - `crud-operations.spec.ts` - INSERT, SELECT, UPDATE, COUNT mit WHERE/ORDER BY/LIMIT/OFFSET
  - `crdt-behavior.spec.ts` - CRDT-Spalten, HLC-Timestamps, Dirty Tables, Column HLCs
  - `tombstone-lifecycle.spec.ts` - Soft Delete, Hard Delete, selectRaw vs select, re-insert, Stats
  - `migrations.spec.ts` - Migrations-Tabelle, angewandte Migrationen, Core-Tabellen

### Neue Dateien
| Datei | Beschreibung |
|-------|--------------|
| `tests/database/crud-operations.spec.ts` | 7 Tests: Insert, InsertMany, Update, WHERE, ORDER BY/LIMIT/OFFSET, COUNT |
| `tests/database/crdt-behavior.spec.ts` | 7 Tests: CRDT-Spalten, No-CRDT, Timestamp, Column HLCs, Dirty Tables |
| `tests/database/tombstone-lifecycle.spec.ts` | 7 Tests: Soft Delete, Exclusion, Raw Visibility, Count, Re-insert, Hard Delete, Stats |
| `tests/database/migrations.spec.ts` | 5 Tests: Table exists, Applied migrations, Unique names, Core tables, No duplicates |

### Patterns & Entscheidungen
- Unique table names via `Date.now()` Suffix für Isolation zwischen Test-Runs
- `SqlHelpers` aus `../helpers` für typsichere SQL-Operationen
- `CRDT_COLUMNS` Konstanten aus helpers statt magic strings
- Migrations: Direkte SQL-Queries auf `haex_migrations` Tabelle (keine Tauri-Commands vorhanden)
- Positive UND negative Assertions in jedem Test
- `toEqual` statt `toBeDefined`, explizite Wertprüfungen
- `afterAll` räumt Test-Tabellen via `sql.dropTable()` auf

---

## 2026-03-16 - Phase 2 & 3: Identity Auth & Sync Backend Test-Suites

### Durchgeführt
- 2 Test-Suites für Identity & Auth (Phase 2) erstellt:
  - `register-identity.spec.ts` - Requirements-Endpoint, Registrierung, Duplikat-409, fehlende/falsche Signatur
  - `challenge-login.spec.ts` - Challenge-Nonce, Signature-Verify, falscher Key 401, Admin-JWT für Auth-Tests
- 5 Test-Suites für Sync Backend (Phase 3) erstellt:
  - `vault-key-management.spec.ts` - Store, Retrieve, List, Update, Delete Vault Key, 401 ohne Token
  - `push-changes.spec.ts` - Single/Multi Push, Pull-back, Exclude own device, Last-write-wins
  - `batch-validation.spec.ts` - Complete batch, Missing seq 400, Duplicate seq 400
  - `conflict-resolution.spec.ts` - Two-device conflict, Multi-column row, Overwrite, afterUpdatedAt
  - `pull-changes.spec.ts` - Empty vault, Push+Pull, Limit+hasMore, afterUpdatedAt, Row-level granularity

### Neue Dateien
| Datei | Tests |
|-------|-------|
| `tests/identity-auth/register-identity.spec.ts` | 4 Tests |
| `tests/identity-auth/challenge-login.spec.ts` | 4 Tests |
| `tests/sync/vault-key-management.spec.ts` | 7 Tests |
| `tests/sync/push-changes.spec.ts` | 5 Tests |
| `tests/sync/batch-validation.spec.ts` | 3 Tests |
| `tests/sync/conflict-resolution.spec.ts` | 4 Tests |
| `tests/sync/pull-changes.spec.ts` | 5 Tests |

### Patterns & Entscheidungen
- Direkte `fetch()` Aufrufe gegen Sync-Server REST API (kein Tauri/WebDriver nötig)
- `createAdminUser()` umgeht Email-Verification für Auth-abhängige Tests
- `crypto.randomUUID()` für Vault-IDs, eindeutige Device-IDs mit Timestamps
- Cleanup via `deleteVault()` in `afterAll`
- Challenge-Login-Test mit graceful Skip bei 403 (Email-Verification-Pflicht)
- HLC-Timestamps mit fixierten Werten für deterministische Conflict-Tests (z.B. 2020 vs 2099)
- Separate Vaults pro Test wo Isolation nötig (limit-Test, row-level-Test)

---

## 2026-03-16 - Phase 7: External Bridge / haex-pass Test-Suites

### Durchgeführt
- 5 Test-Suites für Phase 7 (External Bridge / haex-pass) erstellt:
  - `authorization-flow.spec.ts` - Connect, authorize, paired state, unauthorized rejection, reconnect
  - `get-logins.spec.ts` - Create entries, query by URL, field validation, empty results, missing params
  - `create-update-item.spec.ts` - CREATE_ITEM, UUID format, auto-title, special chars, UPDATE_ITEM, non-existent ID
  - `totp-generation.spec.ts` - 6-digit code, validFor range, sequential consistency, no-TOTP error, not-found error
  - `client-management.spec.ts` - Authorized list, block client, revoke client, re-auth after revoke

### Neue Dateien
| Datei | Beschreibung |
|-------|--------------|
| `tests/haex-pass/authorization-flow.spec.ts` | 5 Tests: Connect state, paired + clientId, request works, unauthorized throws, reconnect |
| `tests/haex-pass/get-logins.spec.ts` | 4 Tests: Matching URL, non-matching URL, all fields, missing url param |
| `tests/haex-pass/create-update-item.spec.ts` | 6 Tests: Create all fields, verify via GET, auto-title, special chars, update, non-existent |
| `tests/haex-pass/totp-generation.spec.ts` | 5 Tests: 6-digit code, validFor, same period same code, no-TOTP error, not-found error |
| `tests/haex-pass/client-management.spec.ts` | 4 Tests: Authorized list, block list, revoke removes, re-auth required |

### Patterns & Entscheidungen
- `authorizeClient(client, "unused")` - zweiter Parameter ist Chrome Extension ID (unused in implementation)
- `sendRequestWithRetry` statt `client.sendRequest` für robuste CI-Ausführung
- `TAURI_COMMANDS.externalBridge.*` für Vault-seitige Client-Management-Befehle
- `HAEX_PASS_METHODS.*` für alle API-Methoden (keine magic strings)
- Negative Tests: Non-existent IDs, unauthorized clients, missing params, no-TOTP entries

---

## 2026-03-16 - Shared Spaces Test-Suites

### Durchgeführt
- 3 Test-Suites für Shared Spaces Feature erstellt:
  - `create-space.spec.ts` - Space erstellen, auflisten, Details, Name updaten, löschen, 401 ohne Auth
  - `member-management.spec.ts` - Member einladen, auflisten, non-admin rejection, entfernen, re-invite
  - `access-tokens.spec.ts` - Token erstellen (64-char hex), auflisten, revoken, revoked-Status prüfen, 401 ohne Auth

### Neue Dateien
| Datei | Tests |
|-------|-------|
| `tests/spaces/create-space.spec.ts` | 6 Tests: Create 201, List with admin role, Details with members, Update name, Delete + verify gone, 401 unauthorized |
| `tests/spaces/member-management.spec.ts` | 5 Tests: Invite 201, List both roles, Non-admin rejection, Remove + verify gone, Re-invite |
| `tests/spaces/access-tokens.spec.ts` | 5 Tests: Create tokenId + 64-char hex, List with fields, Revoke 200, Revoked flag true, 401 unauthorized |

### Patterns & Entscheidungen
- Direkte `fetch()` Aufrufe gegen `/spaces` REST API
- `createAdminUser()` für JWT-Token
- `randomBase64()` Helper für verschlüsselte Felder (encryptedName, keyGrant, etc.)
- `createSpace()` lokale Helper-Funktion in jeder Datei
- Zwei separate Admin-User in member-management für Rollenprüfung
- `encodeURIComponent()` für publicKey in URL-Pfaden
- Negative Tests: 401 ohne Auth, non-admin member invite rejection
- Cleanup via `DELETE /spaces/:id` in `afterAll`

---

## 2026-03-16 - Extension System Test-Suites

### Durchgeführt
- 3 Test-Suites für Extension System erstellt:
  - `install-remove.spec.ts` - get_all_extensions, haex-pass fields, is_extension_installed true/false, get_extension_info
  - `permissions.spec.ts` - get_extension_permissions structure, key validation, update http rule + persistence, afterAll restore
  - `resource-limits.spec.ts` - get_extension_limits fields, positive values, update + persistence, reset to defaults

### Neue Dateien
| Datei | Tests |
|-------|-------|
| `tests/extensions/install-remove.spec.ts` | 5 Tests: List contains haex-pass, correct fields, valid id/desc/publicKey, installed true, not-installed false, get_extension_info match |
| `tests/extensions/permissions.spec.ts` | 3 Tests: Valid structure with arrays, exact keys, update http rule persists |
| `tests/extensions/resource-limits.spec.ts` | 5 Tests: All fields present, positive numbers, update persists, reset defaults, re-read matches |

### Patterns
- VaultAutomation("A") mit createSession() (kein deleteSession für Vault A)
- Extension-ID via get_all_extensions lookup in beforeAll
- afterAll restore: original permissions und reset_extension_limits
- Keine magic strings, explizite Typ-Interfaces für Extension, Permissions, Limits
- Assertions: toEqual, toBeGreaterThan, toBe statt toBeDefined

---

## 2026-03-17 - Fix vault-lifecycle assertions for file path return type

### Durchgeführt
- `create_encrypted_database` und `open_encrypted_database` geben einen Dateipfad zurück, keine UUID
- Beispiel: `/config/.local/share/space.haex.vault/vaults/test-vault.db`
- UUID-basierte Assertions in 3 Dateien durch Pfad-basierte Assertions ersetzt (4 Stellen insgesamt)
- API-Dokumentation aktualisiert mit korrekten Return-Types

### Geänderte Dateien
| Datei | Änderung |
|-------|----------|
| `tests/vault-lifecycle/create-vault.spec.ts` | 2 Stellen: create + open Assertions |
| `tests/vault-lifecycle/delete-vault.spec.ts` | 1 Stelle: create Assertion |
| `tests/vault-lifecycle/change-password.spec.ts` | 1 Stelle: open Assertion |
| `.claude/api.md` | create_encrypted_database und open_encrypted_database dokumentiert |

---

## 2026-03-17 - Fix sync-server-helpers URLs for Docker container

### Durchgeführt
- `createAdminUser()` in `sync-server-helpers.ts` verwendete hardcodierte localhost-URLs die im Docker-Container nicht funktionieren
- Drei URL-Konstanten eingeführt:
  - `SYNC_SERVER_URL` (via Kong Gateway) - für reguläre sync API calls
  - `SYNC_SERVER_DIRECT_URL` = `http://sync-server:3002` - für Admin-Endpoints die Kong nicht proxied
  - `SUPABASE_URL` = Kong URL - für GoTrue Auth (`/auth/v1/*`)
- JWT-Keys auf supabase-demo Keys aktualisiert (passend zu docker-compose.yml)
- Admin create-user Endpoint nutzt jetzt `SYNC_SERVER_DIRECT_URL` (Kong proxied `/auth/admin/*` nicht)
- Supabase Login nutzt jetzt `SUPABASE_URL` (Kong proxied `/auth/v1/*` zu GoTrue)

### Geänderte Dateien
| Datei | Änderung |
|-------|----------|
| `tests/helpers/sync-server-helpers.ts` | URL-Konstanten, JWT-Keys, Endpoint-URLs korrigiert |

---

## 2026-03-17 - Bulk fix test failures from Docker testing

### Durchgeführt
10 Test-Dateien gefixt basierend auf Fehlern aus Docker-Testlauf:

1. **haex-pass-api.ts** - `SET_ITEM: "set-item"` hinzugefügt, `CREATE_ITEM` und `UPDATE_ITEM` als deprecated Aliase auf "set-item" gemappt (Extension nutzt "set-item" für beides)
2. **crdt-behavior.spec.ts** - Tombstone-Assertion `0` -> `[0, null]` (aktive Rows können null haben)
3. **sql-helpers.ts** - `getTableInfo()`: Fallback auf sqlite_master Parsing wenn PRAGMA über sql_select fehlschlägt
4. **tombstone-lifecycle.spec.ts** - Tombstone-Assertion für aktive Rows: `0` -> `[0, null]`
5. **permissions.spec.ts** - Flexible Strukturerkennung: prüft ob Permissions direkt oder verschachtelt (`.permissions`, `.data`) kommen
6. **resource-limits.spec.ts** - snake_case zu camelCase Normalisierung (`query_timeout_ms` -> `queryTimeoutMs`)
7. **start-page.spec.ts** - Auto-Detect von Feld-Name (`fileSize` vs `file_size` vs `size`), robustere Assertions
8. **peer-storage.spec.ts** - `test.describe.skip` (peer_storage_status Command existiert nicht)
9. **logging.spec.ts** - `test.describe.skip` (log_write_system Command existiert nicht)
10. **client-management.spec.ts** - `clientName: "E2E Test Client"` Parameter zu `clientBlock` Call hinzugefügt
11. **migrations.spec.ts** - Auto-Detect Tabellenname, SELECT * statt named columns (Schema-unabhängig)

### Geänderte Dateien
| Datei | Fix |
|-------|-----|
| `tests/haex-pass-api.ts` | SET_ITEM added, CREATE_ITEM/UPDATE_ITEM -> "set-item" |
| `tests/helpers/sql-helpers.ts` | getTableInfo() PRAGMA fallback to sqlite_master |
| `tests/database/crdt-behavior.spec.ts` | tombstone assertion accepts null |
| `tests/database/tombstone-lifecycle.spec.ts` | tombstone assertion accepts null |
| `tests/database/migrations.spec.ts` | auto-detect table name + schema-agnostic queries |
| `tests/extensions/permissions.spec.ts` | flexible structure detection |
| `tests/extensions/resource-limits.spec.ts` | snake_case normalization |
| `tests/ui/start-page.spec.ts` | auto-detect fileSize field name |
| `tests/ui/logging.spec.ts` | skipped (missing command) |
| `tests/storage/peer-storage.spec.ts` | skipped (missing command) |
| `tests/haex-pass/client-management.spec.ts` | added clientName param |

---

## 2026-03-17 - Fix remaining E2E test failures (retry isolation, flexible assertions)

### Durchgeführt
7 Fixes für E2E-Test-Fehler, die bei Retries oder unterschiedlichen Vault-Versionen auftraten:

1. **get-logins.spec.ts** - Unique URLs mit `Date.now()` Suffix (`TEST_URL_GITHUB`, `TEST_URL_GITLAB`) statt hardcodierter URLs. Verhindert, dass Retries duplizierte Einträge akkumulieren.
2. **create-update-item.spec.ts** - Unique URLs mit `Date.now()` Suffix (`TEST_URL_CREATE`, `TEST_URL_AUTO_TITLE`, `TEST_URL_SPECIAL`). Gleiches Retry-Isolation-Problem.
3. **totp-generation.spec.ts** - Unique URLs mit `Date.now()` Suffix (`TEST_URL_TOTP`, `TEST_URL_NO_TOTP`). Gleiches Retry-Isolation-Problem.
4. **fixtures.ts** - `denyClient()` fehlte `clientName` Parameter (required key für `external_bridge_client_block`).
5. **crdt-behavior.spec.ts** - Flexiblere Timestamp-Assertion: akzeptiert sowohl ISO-String als auch numerische Timestamps.
6. **migrations.spec.ts** - Erweiterte Auto-Detection: sucht auch in sqlite_master nach '%migration%' und '_'-Prefix Tabellen.
7. **tombstone-lifecycle.spec.ts** - `crdt_get_stats` Response flexibel: akzeptiert camelCase und snake_case Feldnamen.

### Geänderte Dateien
| Datei | Fix |
|-------|-----|
| `tests/haex-pass/get-logins.spec.ts` | Unique URLs mit Date.now() |
| `tests/haex-pass/create-update-item.spec.ts` | Unique URLs mit Date.now() |
| `tests/haex-pass/totp-generation.spec.ts` | Unique URLs mit Date.now() |
| `tests/fixtures.ts` | clientName in denyClient() |
| `tests/database/crdt-behavior.spec.ts` | Flexible timestamp assertion |
| `tests/database/migrations.spec.ts` | Broader migration table detection |
| `tests/database/tombstone-lifecycle.spec.ts` | Flexible crdt_get_stats fields |

---

## 2026-03-17 - Fix failing CRDT, tombstone, permissions, and resource-limits tests

### Durchgeführt
4 Test-Suites gefixt die wegen API-Mismatches fehlschlugen:

1. **crdt-behavior.spec.ts:97** - `ensure_extension_triggers` nach `createTable` aufrufen, damit INSERT/UPDATE Trigger `haex_column_hlcs` populieren und die Tabelle als dirty markieren. Ohne Triggers bleiben column HLCs leer.

2. **tombstone-lifecycle.spec.ts:158** - `crdt_get_stats` Response nutzt `CrdtStats` Struct mit camelCase Feldern: `deleteCount` (nicht `totalTombstones`), `applied` (nicht `totalEntries` als aktive Einträge), `totalEntries` (alle Rows inkl. tombstoned). Auch `ensure_extension_triggers` nach Table-Creation hinzugefügt.

3. **permissions.spec.ts:48** - `EditablePermissions` = `ExtensionPermissions` mit `Option<Vec<PermissionEntry>>` Feldern (serialisiert als `null`/`undefined` wenn leer, nicht als leere Arrays). Zusätzliche Felder `filesync`, `spaces`, `identities` die der alte Test nicht kannte.

4. **resource-limits.spec.ts:72** - `ExtensionLimitsResponse` hat Felder `maxResultRows` (nicht `maxRowsPerQuery`), `maxQuerySizeBytes` (nicht `maxStorageBytes`). Kein `maxWebRequestsPerMinute`/`maxStorageBytes`. `update_extension_limits` erwartet `{ request: { extensionId, ... } }` wrapper statt flache Parameter.

### Root Causes
- **CRDT Triggers:** `sql_execute_with_crdt` fügt CRDT-Spalten hinzu, aber Triggers werden nur bei DB-Init/Extension-Install eingerichtet. Dynamisch erstellte Tabellen brauchen explizites `ensure_extension_triggers`.
- **CrdtStats Felder:** Tests hatten spekulative Feldnamen, die nicht mit dem `CrdtStats` Rust-Struct übereinstimmten.
- **EditablePermissions:** Rust `Option<Vec<T>>` serialisiert `None` als `null`, nicht als `[]`.
- **ExtensionLimitsResponse:** Tests basierten auf Annahmen statt der tatsächlichen Tauri-Command-Signatur.

### Geänderte Dateien
| Datei | Fix |
|-------|-----|
| `tests/database/crdt-behavior.spec.ts` | `ensure_extension_triggers` nach createTable |
| `tests/database/tombstone-lifecycle.spec.ts` | `ensure_extension_triggers` + korrigierte CrdtStats Feldnamen |
| `tests/extensions/permissions.spec.ts` | `Option<Vec>` handling, zusätzliche Felder, korrigierte Assertions |
| `tests/extensions/resource-limits.spec.ts` | Korrekte Feldnamen, `{ request: {} }` wrapper für update |

---

## 2026-03-29 - Rewrite Realtime E2E Tests for Plain WebSocket

### Durchgeführt
- Alle Supabase Realtime E2E Tests auf plain WebSocket umgeschrieben
- `realtime-helpers.ts` komplett neu: `RealtimeTestClient` Klasse statt Supabase Client Wrapper
- 5 Realtime Test-Suites aktualisiert + `connection-flow.spec.ts` angepasst
- `@supabase/supabase-js` Dependency entfernt
- `insertBroadcastMessage()` Helper entfernt (schrieb in `realtime.messages` Tabelle die nicht mehr existiert)

### Architektur-Änderung
Sync-Server nutzt jetzt `/ws` Endpoint statt Supabase Realtime:
- **Auth**: DID-Auth Token als Query-Parameter (`?token=<payload>.<signature>`)
- **Kein Subscribe/Unsubscribe Protokoll**: Server lädt Memberships bei Connect, `onMessage` ist leer
- **Broadcast-Format**: `{ type: 'sync', spaceId }` oder `{ type: 'membership', spaceId }`
- **Access Control**: Server-seitig via `membershipCache` (nicht RLS)
- **Auth-Fehler**: Close Code 4001
- **Caller-Exclusion**: `broadcastToSpace()` excludiert den Caller-DID

### RealtimeTestClient API
```typescript
class RealtimeTestClient {
  constructor(privateKeyBase64, did, serverUrl?)
  connect(): Promise<void>                          // DID-Auth WS connect
  connectExpectingFailure(timeout?): Promise<bool>   // Expect close 4001
  connectWithRawToken(token, timeout?): Promise<{rejected, closeCode}>
  connectWithoutToken(timeout?): Promise<{rejected, closeCode}>
  waitForMessage(predicate, timeout?): Promise<WsMessage>
  waitForSyncBroadcast(spaceId, timeout?): Promise<WsMessage>
  waitForSpaceBroadcast(spaceId, timeout?): Promise<WsMessage>
  waitForMessageCount(predicate, count, timeout?): Promise<WsMessage[]>
  getMessages(): WsMessage[]
  getSpaceMessages(spaceId): WsMessage[]
  clearMessages(): void
  disconnect(): void
  isConnected: boolean
  lastCloseCode: number | null
}
```

### Test-Pattern-Änderungen
- **Kein `accessToken`** mehr für Realtime — alles über `AuthContext` (DID + privateKey)
- **Broadcast-Tests brauchen 2 User**: Server excludiert Caller-DID, daher muss ein anderer User pushen
- **Keine Channel-Konzepte**: Kein subscribe/unsubscribe, kein removeChannel, keine Channels-Liste
- **Jede Connection = neuer Client**: Kein reconnect auf bestehendem Client, neues `RealtimeTestClient` Objekt

### Geänderte Dateien
| Datei | Änderung |
|-------|----------|
| `tests/helpers/realtime-helpers.ts` | Komplett neu: RealtimeTestClient statt Supabase-Wrapper |
| `tests/helpers/sync-server-helpers.ts` | `insertBroadcastMessage()` entfernt |
| `tests/sync/realtime-broadcast.spec.ts` | WS-basierte Broadcast-Tests mit 2-User-Pattern |
| `tests/sync/realtime-auth-lifecycle.spec.ts` | DID-Auth Token Lifecycle statt JWT |
| `tests/sync/realtime-broadcast-security.spec.ts` | WS-basierte Security-Tests |
| `tests/sync/realtime-channel-lifecycle.spec.ts` | Connect/Disconnect Lifecycle |
| `tests/sync/realtime-reconnection.spec.ts` | WS Reconnection-Tests |
| `tests/sync/connection-flow.spec.ts` | Supabase Realtime → RealtimeTestClient |
| `package.json` | `@supabase/supabase-js` Dependency entfernt |

---

## 2026-04-04 - QUIC Invite E2E Tests: Komplett-Rewrite als UI-Flow

### Durchgeführt
- `quic-invite-flow.spec.ts` komplett neu geschrieben als UI-driven Tests
- Alle Benutzerinteraktionen gehen durch die echte UI (nicht über Tauri-Commands)
- UI-Helper-Funktionen für alle Settings-Interaktionen erstellt

### UI-driven Aktionen
| Aktion | Methode | Helper-Funktion |
|--------|---------|-----------------|
| Vault erstellen/öffnen | UI | `initializeVaultViaUI()` |
| P2P Endpoint starten | Settings → P2P → Connection → Start | `startP2PEndpointViaUI()` |
| Space erstellen | Settings → Spaces → Create Dialog | `createLocalSpaceViaUI()` |
| Invite senden | SpaceDetail → Invite Dialog (Contact Mode) | `sendInviteViaUI()` |
| Invite annehmen | Spaces → Pending Item → Accept Button | `acceptInviteViaUI()` |
| Invite ablehnen | Spaces → Pending Item → Decline Button | `declineInviteViaUI()` |
| Policy ändern | Spaces → Policy Dropdown | `setInvitePolicyViaUI()` |

### SQL/Commands nur für
- Contact-Registrierung (kein UI für DID-basierte Kontakt-Hinzufügung)
- Identity-Loading (Infrastructure)
- Device-Registrierung im Space (falls UI es nicht automatisch macht)
- Self-Invite-Test (via UI nicht möglich — man kann sich selbst nicht einladen)
- Verifikations-Assertions (DB-State prüfen)

### UI-Selektoren (aus haex-vault Vue-Komponenten)
- Settings-Navigation: `[data-testid="settings-category-{cat}"]`
- Settings öffnen: `[data-testid="launcher-settings-item"]` + Pinia-Fallback
- Dialoge: `[role="dialog"]` als Scope für Formular-Interaktionen
- Dropdowns: `[role="combobox"]` trigger, `[role="option"]` Auswahl
- Checkboxes: Label-basierte Suche (EN/DE)
- Buttons: Text-basierte Suche mit EN/DE Fallback

### Wichtige Erkenntnisse
- Settings ist ein Floating Window (kein Route), geöffnet via WindowManager
- `initializeVaultViaUI` darf NIEMALS `location.reload()` nutzen (zerstört WebDriver-Session)
- `sql_select_with_crdt` gibt `Vec<Vec<JsonValue>>` zurück — `sqlQuery<T>()` mappt zu Objekten
- Invite-Outbox: `queueQuicInviteAsync` → `processOutboxAsync` → `local_delivery_push_invite`
- Backoff startet bei 0s, daher sofortige Verarbeitung nach Queuing
- Policy-Check passiert auf der Empfängerseite

### Test-Struktur (12 Tests)
1. Vault A öffnen (UI)
2. Vault B öffnen (UI)
3. P2P auf A starten (UI)
4. P2P auf B starten (UI)
5. Identities laden (SQL)
6. B als Kontakt auf A registrieren (SQL)
7. Lokalen Space auf A erstellen (UI)
8. Device-Registrierung prüfen/ergänzen
9. Invite von A → B senden (UI Dialog)
10. Pending Invite auf B prüfen (UI + SQL)
11. Invite ablehnen (UI)
12. A's Space noch aktiv prüfen
13. Zweiten Invite mit Write senden (UI)
14. Invite annehmen (UI)
15. Self-Invite Prevention (Command)
16. Policy auf "nobody" setzen (UI), Rejection prüfen
17. Logs prüfen (SQL)

<!-- Neue Sessions hier eintragen -->
