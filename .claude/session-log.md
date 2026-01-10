# Session Log

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

<!-- Neue Sessions hier eintragen -->
