# Architektur

## Systemübersicht

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            E2E Test Runner                               │
│                         (Playwright + TypeScript)                        │
└─────────────────────────────────────────────────────────────────────────┘
                │                    │                    │
                ▼                    ▼                    ▼
┌───────────────────────┐ ┌─────────────────────┐ ┌─────────────────────────┐
│   VaultBridgeClient   │ │   VaultAutomation   │ │    SyncServerClient     │
│  (WebSocket + ECDH)   │ │  (Tauri-Driver)     │ │     (REST API)          │
└───────────────────────┘ └─────────────────────┘ └─────────────────────────┘
         │                         │                        │
         │ Port 19455              │ Port 4444              │ Port 3002
         ▼                         ▼                        ▼
┌─────────────────────────────────────────────┐  ┌─────────────────────────┐
│              haex-vault (Tauri App)         │  │   haex-sync-server      │
│  ┌────────────────────────────────────────┐ │  │                         │
│  │         Browser Bridge (WS)            │ │  │  POST /sync/push        │
│  │         haex-pass Library              │ │  │  GET  /sync/pull        │
│  │         SQLite + CRDT                  │ │  │  GET  /sync/vaults      │
│  └────────────────────────────────────────┘ │  └─────────────────────────┘
└─────────────────────────────────────────────┘           │
                                                          ▼
                                               ┌─────────────────────────┐
                                               │     PostgreSQL 15.8     │
                                               └─────────────────────────┘
```

## Komponenten

### VaultBridgeClient (tests/fixtures.ts:77-513)
WebSocket-Client für die Kommunikation mit haex-vault.

**Verantwortlichkeiten:**
- ECDH-Schlüsselpaar generieren (P-256/prime256v1)
- Client-ID aus Public-Key-Hash ableiten
- WebSocket-Verbindung zu Port 19455 aufbauen
- Handshake mit Server-Public-Key-Austausch
- AES-256-GCM verschlüsselte Requests/Responses
- Forward Secrecy durch ephemere Schlüsselpaare pro Request

**States:**
- `disconnected` → `connecting` → `connected` → `pending_approval` → `paired`

**API:**
- `connect()` - WebSocket verbinden
- `sendRequest(action, payload)` - Verschlüsselten Request senden
- `getLogins(url, fields)` - Passwörter abrufen
- `setLogin(entry)` - Neuen Eintrag speichern
- `getTotp(entryId)` - TOTP-Code generieren

### VaultAutomation (tests/fixtures.ts:700-891)
WebDriver-Client für Tauri-App-Automation via tauri-driver.

**Verantwortlichkeiten:**
- WebDriver-Session erstellen/löschen
- Tauri-Commands direkt aufrufen
- UI-Elemente finden und klicken
- Authorization-Flow automatisieren

**Tauri-Commands:**
- `get_pending_authorizations` - Ausstehende Genehmigungen
- `approve_client_authorization` - Client genehmigen
- `deny_client_authorization` - Client ablehnen
- `get_dirty_tables` - Geänderte Tabellen für Sync
- `trigger_sync_push` / `trigger_sync_pull` - Sync auslösen
- `get_sync_state` - Aktuellen Sync-Status

### SyncServerClient (tests/fixtures.ts:533-677)
REST-Client für haex-sync-server.

**Verantwortlichkeiten:**
- Health-Check durchführen
- Push/Pull-Operationen ausführen
- Vault-Verwaltung (list, delete)

**Endpoints:**
- `GET /` - Health-Check
- `POST /sync/push` - Änderungen hochladen
- `GET /sync/pull` - Änderungen abrufen
- `GET /sync/vaults` - Vaults auflisten
- `DELETE /sync/vault/:id` - Vault löschen

## Verschlüsselung

### Handshake-Flow
1. Client generiert ECDH-Keypair (P-256)
2. Client sendet: `{ type: "handshake", client: { clientId, clientName, publicKey } }`
3. Server antwortet mit Server-Public-Key + Authorization-Status
4. Bei `pendingApproval`: Warten auf Genehmigung in Vault-UI

### Request-Verschlüsselung
1. Ephemeres ECDH-Keypair für Forward Secrecy generieren
2. ECDH mit Server-Public-Key → Shared Secret
3. AES-256-GCM mit ersten 32 Bytes des Secrets
4. 12-Byte IV (GCM), Auth-Tag angehängt
5. Envelope: `{ action, message (base64), iv (base64), clientId, publicKey (ephemeral) }`

## Docker-Architektur

### Supabase-kompatibler Auth-Stack

Der E2E-Test-Stack verwendet einen vollständigen Supabase-kompatiblen Auth-Stack:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client (sync-server)                           │
│                   SUPABASE_URL=http://kong:8000                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Kong API Gateway (Port 8000)                        │
│   - /auth/v1/* → GoTrue                                                 │
│   - /health → GoTrue Health                                             │
│   - Key-Auth mit Service Role / Anon Keys                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     GoTrue Auth Service (Port 9999)                     │
│   - JWT-Authentifizierung                                               │
│   - User-Erstellung via Admin-API                                       │
│   - Token-Generierung (access_token, refresh_token)                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                PostgreSQL (supabase/postgres:15.8.1.085)                │
│   - auth.users Tabelle                                                  │
│   - supabase_auth_admin User für GoTrue                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

**JWT-Konfiguration:**
- `GOTRUE_JWT_SECRET`: super-secret-jwt-token-with-at-least-32-characters-long
- Anon Key: JWT mit role=anon
- Service Key: JWT mit role=service_role (für Admin-Operationen)

### Multi-Vault Setup (Dual-Container)

Für Realtime-Sync-Tests werden zwei separate Vault-Container benötigt:

```yaml
services:
  db:              # PostgreSQL 15.8 mit Supabase-Extensions
  gotrue:          # GoTrue Auth Service (Port 9999)
  kong:            # Kong API Gateway (Port 8000)
  sync-server:     # haex-sync-server auf Port 3002
  vault-a:         # Primärer Vault (Ports: 3000, 19455, 4444)
  vault-b:         # Sekundärer Vault (Ports: 3001, 19456, 4445)
```

**Port-Zuordnung:**

| Instance | Webtop | Bridge | tauri-driver |
|----------|--------|--------|--------------|
| vault-a  | 3000   | 19455  | 4444         |
| vault-b  | 3001   | 19456  | 4445         |

**Umgebungsvariablen:**
- `VAULT_INSTANCE=A|B` - Identifiziert die Instanz
- `SYNC_SERVER_URL=http://sync-server:3002` - Internes Docker-Netzwerk

### VaultAutomation Multi-Instance

```typescript
// Vault A (Primary)
const vaultA = new VaultAutomation("A");
await vaultA.createSession();

// Vault B (Secondary)
const vaultB = new VaultAutomation("B");
await vaultB.createSession();
```

Die `VaultAutomation`-Klasse verwendet automatisch die richtige URL basierend auf der Instance:
- `VAULT_CONFIG.A.tauriDriverUrl` → `http://localhost:4444`
- `VAULT_CONFIG.B.tauriDriverUrl` → `http://localhost:4445`

**Build-Args:**
- `HAEX_VAULT_REF` - Git-Ref für haex-vault
- `HAEXTENSION_REF` - Git-Ref für haextension
- `VAULT_SDK_REF` - Git-Ref für vault-sdk
- `HAEX_SYNC_SERVER_REF` - Git-Ref für haex-sync-server

## Versionskonfiguration

Drei Methoden zur Versionskonfiguration:

### 1. Projekt-Konfigurationsdatei (.e2e-versions.json)
Jedes Projekt kann im Root eine JSON-Datei mit den E2E-Test-Versionen pflegen:

```json
{
  "project": "haex-vault",
  "dependencies": {
    "haex-vault": "self",      // Ersetzt durch aktuelle Ref
    "haextension": "main",
    "vault-sdk": "main",
    "haex-sync-server": "v1.0.0"
  },
  "profiles": {
    "release": { ... }         // Alternative Versionssets
  }
}
```

Script: `scripts/fetch-project-versions.sh <project> [ref] [profile]`

### 2. Version-Presets
- `main` - Alle Services auf main-Branch
- `release` - Letzte GitHub-Release-Tags
- `nightly` - Nightly-Branches (falls vorhanden)

Script: `scripts/resolve-versions.sh [preset]`

### 3. Direkte Umgebungsvariablen
```bash
HAEX_VAULT_VERSION=v1.0.0
HAEXTENSION_VERSION=feat/new-ui
VAULT_SDK_VERSION=main
HAEX_SYNC_SERVER_VERSION=main
```

## Testausführung

```
Global Setup (global-setup.ts)
    │
    ├── Vault + Tauri-Driver starten (scripts/start-all.sh)
    ├── Sync-Server Health-Check
    │
    ▼
Test Suites (sequentiell, workers: 1)
    │
    ├── haex-pass/*.spec.ts
    └── sync/*.spec.ts
    │
    ▼
Global Teardown (global-teardown.ts)
    │
    └── Cleanup (scripts/stop-all.sh)
```

## Ports

| Port | Service | Protokoll | Container |
|------|---------|-----------|-----------|
| 3000 | Webtop Desktop | HTTP | vault-a |
| 3001 | Webtop Desktop | HTTP | vault-b |
| 3003 | Nuxt Dev Server | HTTP | vault-a/b (intern) |
| 19455 | haex-vault Browser Bridge | WebSocket | vault-a |
| 19456 | haex-vault Browser Bridge | WebSocket | vault-b |
| 4444 | tauri-driver | HTTP (WebDriver) | vault-a |
| 4445 | tauri-driver | HTTP (WebDriver) | vault-b |
| 3002 | haex-sync-server | HTTP REST | sync-server |
| 8000 | Kong API Gateway | HTTP | kong |
| 8443 | Kong API Gateway | HTTPS | kong |
| 9999 | GoTrue Auth | HTTP | gotrue (intern) |
| 5432 | PostgreSQL | TCP | db |
