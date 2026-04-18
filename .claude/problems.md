# Bekannte Probleme & Lösungen

## Test-Coverage Lücken (Code Review 2026-04-18)

Nach einem Code Review blieben folgende Coverage-Lücken offen, weil sie echte
Test-Erweiterungen erfordern (nicht nur Mechanik). Details und Priorisierung:
[docs/plans/2026-04-18-code-review-followups.md](../docs/plans/2026-04-18-code-review-followups.md).

| Bereich | Problem | Priorität |
|---------|---------|-----------|
| MLS Security | Tests in `tests-db/mls.test.ts` prüfen nur DB-State, keine Access-Control an API-Endpoints | Sehr hoch |
| CRDT LWW | Kein echter Konflikt-Test für Last-Writer-Wins mit zwei konkurrenten Edits | Hoch |
| Unauth Assertions | `authorization-flow.spec.ts` und `client-management.spec.ts` skippen Security-Assertions bedingt | Mittel |
| Pagination | `hasMore` Off-by-one, LIKE-Wildcards, invalide ISO-Timestamps | Mittel |
| HLC-Format | `haex_column_hlcs`-Test prüft nur "changed", nicht Format oder Scope | Mittel |
| Pull-Boundary | `afterUpdatedAt` Inclusive/Exclusive nicht dokumentiert oder getestet | Mittel |
| Reconnect mit Keys | Test tut nicht, was sein Name sagt — VaultBridgeClient braucht Key-Injection | Niedrig |
| UCAN Enum | `@haex-space/ucan` hat keine Enum-Werte für AddMember/DeleteSpace/CreateInvite | Upstream-Issue |

**Wichtig für neue CRDT-Tests:** HLC-Timestamps NIE im Test selbst konstruieren.
Der Haupt-Entwickler hat klargestellt (2026-04-18), dass die HLC-Logik komplett
in haex-vault bleibt, weil nur dort der Counter korrekt hochgezählt werden kann.
Tests müssen HLCs über einen Tauri-Command vom Vault anfordern.

---

## Aktuelle Einschränkungen

### Multi-Container Dual-Vault Testing
**Problem:** Zwei Container (vault-a, vault-b) können nicht direkt miteinander kommunizieren, weil `tauri-driver` nur an `127.0.0.1` bindet.

**Symptome:**
- Von vault-a aus ist `http://vault-b:4444/status` nicht erreichbar (Connection refused)
- Docker-Netzwerk und DNS funktionieren korrekt
- Problem liegt an `LISTEN 127.0.0.1:4444` statt `0.0.0.0:4444`

**Mögliche Lösungen:**
1. **socat Proxy:** `socat TCP-LISTEN:4446,fork,bind=0.0.0.0 TCP:127.0.0.1:4444` - Funktioniert teilweise, aber tauri-driver antwortet nicht korrekt
2. **Tests vom Host ausführen:** Port-Mappings nutzen (localhost:4444 für vault-a, localhost:4445 für vault-b)
3. **Network namespace bridge:** iptables DNAT Regeln für Container-übergreifende Kommunikation

**Status:** Tests sind mit `test.describe.skip` markiert bis Infrastruktur-Lösung implementiert ist.

**Docker-Compose Setup (bereits implementiert):**
```yaml
vault-a:
  ports:
    - "3000:3000"   # Webtop
    - "19455:19455" # Bridge
    - "4444:4444"   # tauri-driver
vault-b:
  ports:
    - "3001:3000"
    - "19456:19455"
    - "4445:4444"
```

---

### Multi-Device Testing (Legacy)
**Problem:** Echte Multi-Device-Szenarien werden nur simuliert (eine Vault-Instanz mit verschiedenen deviceIds).

**Workaround:** Sync-Server erhält Changes von verschiedenen simulierten Devices.

**TODO:** Echte Multi-Device-Tests mit mehreren Vault-Instanzen.

---

### Browser-Kompatibilität
**Problem:** Nur Chromium wird getestet.

**Grund:** Browser Extensions funktionieren unterschiedlich in Firefox/Safari.

**TODO:** Firefox-Support hinzufügen (manifest v2 vs v3).

---

### Konfliktauflösung (GELÖST)
**Problem:** Konflikt-Szenarien waren definiert (`sync-test-data.ts`) aber nicht vollständig implementiert.

**Lösung:** Tests für CRDT-basierte Konfliktauflösung (Last-Write-Wins) hinzugefügt in `tests/workflows/remote-sync.spec.ts`:
- `should handle concurrent updates with last-write-wins` - Verifiziert dass bei konkurrierenden Updates der letzte gewinnt
- `should maintain data integrity after rapid updates` - Stresstest mit 10 schnellen Updates

**Status:** ✅ GELÖST

---

### Node.js fetch und Host-Header Override (GELÖST)
**Problem:** Node.js fetch (undici) schließt die Verbindung, wenn ein Host-Header gesetzt wird.

**Symptome:**
```
Error: fetch failed
Cause: SocketError: other side closed
```

**Ursache:** undici verwendet intern HTTP/2 oder hat Probleme mit Host-Header-Overrides bei HTTP/1.1 Verbindungen.

**Lösung:** Node.js `http` Modul statt `fetch` verwenden für Cross-Container-Requests:
```typescript
const http = require('node:http');
const req = http.request({
  hostname: 'vault-b',
  port: 4446,
  path: '/session',
  method: 'POST',
  headers: {
    'Host': 'localhost:4444',  // Required for tauri-driver
    'Content-Type': 'application/json'
  }
}, callback);
```

**Geänderte Dateien:**
- `tests/fixtures.ts` - `httpRequest()` Methode hinzugefügt, verwendet in `createNewSession()` und `invokeTauriCommand()` wenn `needsHostOverride` true ist

---

### remote_storage_add_backend unterstützt nur S3
**Problem:** Der Befehl `remote_storage_add_backend` mit `type: "haex-sync"` schlägt fehl.

**Ursache:** Die `remote_storage` API ist nur für S3-kompatible Storage-Backends gedacht:
```rust
match backend_type {
    "s3" => { ... }
    _ => Err(StorageError::InvalidConfig {
        reason: format!("Unknown backend type: {}", backend_type),
    }),
}
```

**Lösung:** haex-sync-server Integration läuft über die `haex_sync_backends` Tabelle (nicht `remote_storage`):

1. **Sync Backend Tabelle:** `haex_sync_backends` mit Spalten:
   - `id`, `name`, `server_url`, `vault_id`, `email`, `password`
   - `sync_key`, `vault_key_salt`, `enabled`, `priority`
   - `last_push_hlc_timestamp`, `last_pull_server_timestamp`

2. **Konfiguration via SQL:** Da keine Tauri-Commands für Sync-Konfiguration existieren, nutzen wir `sql_execute_with_crdt`:
```typescript
await vault.configureSyncBackend({
  serverUrl: "http://sync-server:3002",
  email: "test@example.com",
  password: "password",
  vaultId: "vault-uuid",
});
```

3. **Sync-Server Auth:** Registrierung und Login über REST API:
   - `POST /auth/register` - User erstellen
   - `POST /auth/login` - JWT Token erhalten
   - `POST /sync/vault-key` - Vault-Key auf Server speichern

**Geänderte Dateien:**
- `tests/fixtures.ts` - `configureSyncBackend()`, `getSyncBackends()` Methoden
- `tests/sync/dual-vault-sync.spec.ts` - Tests für Sync-Konfiguration

---

## Gelöste Probleme

### Supabase Auth (GoTrue) für E2E-Tests nicht verfügbar (GELÖST)
**Problem:** Der haex-sync-server verwendet Supabase Auth für Benutzer-Authentifizierung. Das E2E-Test-Setup hat nur die PostgreSQL-Datenbank, nicht den vollständigen Supabase-Stack.

**Lösung:** Admin-Endpoint `/auth/admin/create-user` zum sync-server hinzugefügt, der mit dem `SUPABASE_SERVICE_KEY` autorisiert wird.

**Implementierung:**
```typescript
// In haex-sync-server/src/routes/auth.ts
app.post('/admin/create-user', async (c) => {
  // Verify Service Role Key in Authorization header
  const providedKey = authHeader.substring(7);
  if (providedKey !== process.env.SUPABASE_SERVICE_KEY) {
    return c.json({ error: 'Invalid service key' }, 403);
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true
  });
});
```

**Verwendung in E2E-Tests:**
```typescript
// In tests/fixtures.ts - SyncServerClient.register()
const response = await fetch(`${this.baseUrl}/auth/admin/create-user`, {
  headers: {
    "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  },
  body: JSON.stringify({ email, password }),
});
```

**Geänderte Dateien:**
- `haex-sync-server/src/routes/auth.ts` - Admin-Endpoint hinzugefügt
- `tests/fixtures.ts` - `SyncServerClient.register()` nutzt Admin-Endpoint
- `docker/docker-compose.yml` - `SUPABASE_SERVICE_KEY` zu vault-a und vault-b hinzugefügt

---

### WebSocket Connection Timeout
**Problem:** Tests schlugen fehl wenn Vault nicht schnell genug startete.

**Lösung:** `waitForBridgeConnection()` Helper mit Retry-Logik (500ms Intervall, 10s Timeout).

---

### Auth Tag Handling bei AES-GCM
**Problem:** Entschlüsselung schlug fehl.

**Ursache:** Auth Tag war nicht korrekt vom Ciphertext getrennt.

**Lösung:**
```typescript
const authTag = ciphertext.subarray(ciphertext.length - 16);
const encryptedData = ciphertext.subarray(0, ciphertext.length - 16);
decipher.setAuthTag(authTag);
```

---

### Extension Service Worker nicht gefunden
**Problem:** `context.serviceWorkers()` war initial leer.

**Lösung:** Warten auf `serviceworker` Event:
```typescript
let [background] = context.serviceWorkers();
if (!background) {
  background = await context.waitForEvent("serviceworker");
}
```

---

### WebDriver Session ID Format
**Problem:** Unterschiedliche Response-Formate von tauri-driver.

**Lösung:** Beide Formate unterstützen:
```typescript
this.sessionId = data.value?.sessionId || data.sessionId;
```

---

### Docker Shared Memory
**Problem:** Chrome/Chromium crashte im Container.

**Lösung:** `shm_size: 2gb` in docker-compose.yml

---

### Foreign Key Constraint bei Client-Autorisierung
**Problem:** `FOREIGN KEY constraint failed` beim Aufrufen von `external_bridge_client_allow`.

**Ursache:** Die Tabelle `haex_external_authorized_clients` hat einen FK auf `haex_extensions(id)`. Browser-Clients werden einer Extension zugeordnet, um zu kontrollieren auf welche Extension-Funktionen sie zugreifen dürfen.

**Lösung (2 Schritte):**

1. Im **global-setup.ts** muss die haex-pass Extension registriert werden:
```typescript
const extensionId = await invokeTauriCommand(sessionId, "register_extension_in_database", {
  manifest: HAEX_PASS_MANIFEST,
  customPermissions: { database: [], filesystem: [], http: [], shell: [] },
});
// Speichere Extension ID für Tests
fs.writeFileSync("/tmp/e2e-haex-pass-extension-id.txt", extensionId);
```

2. In **fixtures.ts** muss `authorizeClient` die **haex-vault Extension ID** verwenden (nicht die Chrome Extension ID!):
```typescript
function getHaexVaultExtensionId(): string {
  return fs.readFileSync("/tmp/e2e-haex-pass-extension-id.txt", "utf-8").trim();
}

// In authorizeClient():
const vaultExtensionId = getHaexVaultExtensionId();
await vault.approveClient(clientId, clientName, publicKey, vaultExtensionId);
```

**Wichtig:** Die Chrome Extension ID (z.B. `abcdefghijklmnop...`) ist NICHT dieselbe wie die haex-vault Extension ID (UUID wie `c3ff5a28-03ec-4d1e-b0dd-942283143d11`).

Die Extension-Daten stammen aus `/repos/haextension/apps/haex-pass/haextension/manifest.json`.

---

### Tauri v2 invoke API
**Problem:** `window.__TAURI__.invoke is not a function`

**Ursache:** Tauri v2 verwendet `window.__TAURI_INTERNALS__` statt `window.__TAURI__`.

**Lösung:** Script anpassen:
```javascript
const { invoke } = window.__TAURI_INTERNALS__;
invoke('command', args)...
```

---

### Extension Public Key Mismatch bei Migrations
**Problem:** Extension-Installation schlägt fehl mit "Extension can only operate on tables with prefix 'XXX__haex-pass__'. Got: 'YYY__haex-pass__...'"

**Ursache:** Die Extension-Migrations verwenden Tabellennamen mit dem Public Key als Prefix. Wenn wir einen neuen E2E-Test-Key generieren, stimmt er nicht mit dem im Repo eingecheckten Key überein.

**Lösung im Dockerfile:**
```dockerfile
# 1. Key generieren BEVOR die Extension gebaut wird
RUN pnpm exec haex keygen -o /tmp/e2e-keys

# 2. Public Key in manifest.json aktualisieren
RUN NEW_KEY=$(cat /tmp/e2e-keys/public.key) && \
    OLD_KEY=$(jq -r '.publicKey' haextension/manifest.json) && \
    jq --arg pk "$NEW_KEY" '.publicKey = $pk' haextension/manifest.json > /tmp/manifest.json && \
    mv /tmp/manifest.json haextension/manifest.json

# 3. Alten Key-Prefix in allen Migration SQL-Dateien ersetzen
RUN find app/database/migrations -name "*.sql" -exec sed -i "s/${OLD_KEY}/${NEW_KEY}/g" {} \;

# 4. Dann erst bauen und signieren
RUN pnpm --filter haex-pass build
RUN pnpm exec haex sign .output/public -k /tmp/e2e-keys/private.key -o /app/haex-pass.haex
```

---

### Request nach Autorisierung abgelehnt (ROOT CAUSE GEFUNDEN)
**Problem:** Nach erfolgreicher Client-Autorisierung werden Requests trotzdem als "not authorized" abgelehnt.

**Symptome:**
```
[ExternalBridge] notify_authorization_granted called for client_id=XXX
[ExternalBridge] Sent authorization update to client XXX: Ok(())
[E2E] Authorization granted!
...
[ExternalBridge] Received request: action=get-logins, client_id=Some("..."), ext_pk=None, ext_name=None
[ExternalBridge] Request rejected: client not authorized
```

**Root Cause (haex-vault Bug):**
1. Die Autorisierung wird mit einer **spezifischen Extension-ID** in der DB gespeichert
2. Bei der Request-Verarbeitung prüft `check_client_authorized_for_extension()` ob der Client für eine Extension autorisiert ist
3. Der Request enthält **keine Extension-Informationen** (`ext_pk=None, ext_name=None`)
4. Ohne Extension-Info im Request kann der Server nicht wissen, welche Extension angesprochen werden soll

**Analyse des haex-vault Codes:**
- Handshake: `check_client_authorized()` prüft nur ob client_id existiert (nicht extension-spezifisch)
- Request: `check_client_authorized_for_extension()` prüft ob client für **spezifische** Extension autorisiert ist
- Problem: Request-Message enthält kein Feld für Extension-Identifier

**Lösungsoptionen (in haex-vault zu implementieren):**
1. Extension-ID aus bestehender Client-Autorisierung ableiten wenn `ext_pk=None`
2. Extension-Info im Request-Protokoll verpflichtend machen
3. Handshake mit Extension-Info erweitern und bei Request wiederverwenden

**Lösung für E2E-Tests (Teil 1):**
Der E2E-Client muss `extensionPublicKey` und `extensionName` im Request mitsenden:

```typescript
const request = {
  type: "request",
  action,
  message: ciphertext.toString("base64"),
  iv: iv.toString("base64"),
  clientId: this.clientId,
  publicKey: ephemeralPublicKeyBase64,
  extensionPublicKey: "...",        // Hex-String aus manifest.json
  extensionName: "haex-pass",       // Name der Ziel-Extension
};
```

**Verbleibender Bug in haex-vault (Race Condition):**
Selbst mit Extension-Info schlägt die Autorisierung fehl. Root Cause:

```rust
// In handle_connection():
let mut authorized = false;  // Lokale Variable, beim Handshake gesetzt

// notify_authorization_granted() setzt client.authorized = true auf dem Server-Object
// ABER die lokale Variable 'authorized' wird nicht aktualisiert!

// Bei Request-Prüfung:
let is_authorized = if authorized {  // Prüft lokale Variable (immer false!)
    true
} else if session_authorizations.contains_key(cid) {
    true  // Nur für "allow once" (remember=false)
} else {
    false
};
```

**Fix benötigt in haex-vault:**
Die Request-Prüfung sollte `client.authorized` aus dem `clients` Map lesen, nicht die lokale Variable.

**Geänderte Dateien (E2E-Tests):**
- `docker/Dockerfile` - Kopiert Public Key nach `/app/haex-pass-public.key`
- `tests/fixtures.ts` - Liest Key und sendet ihn im Request
- `tests/global-setup.ts` - Verwendet `list_vaults` und `vaultPath` statt `vaultName`

---

### tauri-driver + WebKit about:blank Problem (GELÖST)
**Problem:** Bei E2E-Tests mit tauri-driver auf Linux bleibt die WebView auf `about:blank` hängen, obwohl `__TAURI_INTERNALS__` verfügbar ist.

**Symptome:**
```
[Setup] Document state: {"hasTauri":true,"origin":"null","isRealUrl":false,"ready":true,"href":"about:blank"}
[Setup] Tauri command 'list_vaults' failed: Origin header is not a valid URL
```

**Ursache:**
- tauri-driver verbindet sich über WebKitWebDriver mit der App
- Das WebView-Fenster wird erstellt, aber die Navigation zur App-URL (`tauri://localhost`) wird nicht im WebDriver-Kontext reflektiert
- Tauri v2 IPC erfordert einen gültigen Origin-Header, aber `about:blank` hat `origin: "null"`
- Dies ist ein bekanntes Problem mit tauri-driver auf Linux mit WebKit

**Lösung: Dev-Server Mode**

1. **tauri.conf.json modifizieren** (im Dockerfile):
```dockerfile
RUN jq '.build.frontendDist = "http://localhost:3003" | .app.security.csp["default-src"] += ["http://localhost:3003"] ...' src-tauri/tauri.conf.json
```

2. **Nuxt Dev-Server starten** bevor die App gestartet wird (in start-all.sh):
```bash
cd /repos/haex-vault
NUXT_HOST=0.0.0.0 pnpm dev &
# Warten bis Port 3003 bereit ist
```

3. **tauri-driver startet die Binary** die jetzt auf den Dev-Server zeigt

**Ergebnis:**
```json
{"hasTauri":true,"origin":"http://localhost:3003","isRealUrl":true,"href":"http://localhost:3003/en"}
```

**Status:** ✅ GELÖST - Tauri-Commands funktionieren jetzt korrekt.

---

### tauri-driver GTK Initialization Race Condition (GELÖST)
**Problem:** tauri-driver crashte beim Container-Start mit:
```
Failed to initialize gtk backend!: BoolError { message: "Failed to initialize GTK" }
```

**Ursache:** Das init-Script (`99-start-services.sh`) startete tauri-driver bevor X11 und GTK vollständig initialisiert waren. Obwohl `xdpyinfo` erfolgreich war, waren die GTK-Bibliotheken noch nicht bereit.

**Lösung:**
1. **GTK-Readiness-Check hinzugefügt:**
```bash
echo "Waiting for GTK to be ready..."
for i in {1..30}; do
    if DISPLAY=:1 gtk-query-settings 2>/dev/null | head -1 >/dev/null; then
        echo "GTK is ready!"
        break
    fi
    sleep 1
done
```

2. **Retry-Logik für tauri-driver:**
```bash
start_tauri_driver() {
    DISPLAY=:1 nohup tauri-driver > /var/log/tauri-driver.log 2>&1 &
    TAURI_PID=$!
    for i in {1..15}; do
        if curl -s http://localhost:4444/status >/dev/null 2>&1; then
            return 0
        fi
        if ! kill -0 $TAURI_PID 2>/dev/null; then
            return 1  # Crashed
        fi
        sleep 1
    done
    return 1
}

# 3 Versuche mit 5s Pause
for attempt in 1 2 3; do
    if start_tauri_driver; then break; fi
    sleep 5
done
```

**Geänderte Dateien:**
- `docker/custom-cont-init.d/99-start-services.sh`

**Status:** ✅ GELÖST - tauri-driver startet jetzt zuverlässig beim ersten oder zweiten Versuch.

---

### Extension Handler nicht registriert in nativen Webviews (GELÖST)
**Problem:** Wenn eine Extension über den windowManager geöffnet wird, registriert sie keine External-Request-Handler. Requests geben "No handler registered for action: ..." zurück.

**Root Cause:**
Der `extensionBroadcastStore.setupEventListeners()` wurde erst beim Rendern der ersten `extension-frame.vue` Komponente aufgerufen. Wenn ein External Request (z.B. von der Browser-Extension via WebSocket Bridge) eintraf bevor ein Extension-Fenster gerendert wurde, konnte er nicht an die Extension weitergeleitet werden.

**Lösung (in haex-vault `src/pages/vault.vue`):**
`setupEventListeners()` des `extensionBroadcastStore` wird jetzt in `onMounted()` direkt nach `loadExtensionsAsync()` aufgerufen — nicht erst beim Rendern eines Extension-Fensters. Damit sind die Event-Listener bereit sobald der Vault geöffnet wird.

```typescript
// vault.vue onMounted()
await Promise.all([loadExtensionsAsync(), readNotificationsAsync()])
setupBroadcastListeners()  // <-- Fix: Early initialization
```

**Zusätzliches Problem: `cargo build` vs `cargo tauri build`:**
Beim manuellen Rebuild im Container muss `cargo tauri build --no-bundle` verwendet werden, nicht `cargo build --release`. Nur `cargo tauri build` führt den `beforeBuildCommand` (`pnpm generate`) aus und embedded die Frontend-Assets korrekt. Mit `cargo build --release` bleiben die Assets nicht embedded und die App zeigt nur `about:blank`.

**Status:** ✅ GELÖST

---

### Sync Tests - Fehlende Tauri Commands (BEKANNT)
**Problem:** Alle Sync-Tests in `tests/sync/realtime-sync.spec.ts` schlagen fehl mit:
```
Command get_sync_status not found
```

**Ursache:** haex-vault hat den Command `get_sync_status` nicht implementiert.

**Betroffene Tests:**
- `should establish realtime subscription after sync setup`
- `should recover from CHANNEL_ERROR with retry`
- `should maintain connection when auth token is refreshed`
- `should fall back to periodic pull when realtime fails`
- `should properly cleanup channel on unsubscribe`

**Status:** ❌ OFFEN - Erfordert Änderungen in haex-vault (neue Tauri Commands für Sync-Status).

---

### haex-pass Extension Request Timeout (GELÖST)
**Problem:** Nach Autorisierung schlagen Requests an die haex-pass Extension mit Timeout fehl.

**Symptome:**
```
[E2E] Request attempt 1/3 failed: Request timeout
```

**Root Cause:**
Das Script `scripts/stop-all.sh` enthielt `pkill -f tauri-driver`, was den tauri-driver nach jedem Test-Run killte. Da tauri-driver vom Container-Init-Script (`99-start-services.sh`) verwaltet wird und zwischen Test-Runs weiterlaufen sollte, führte dies zu Timeouts in nachfolgenden Tests.

**Lösung:**
Entfernung der `pkill -f tauri-driver` Zeile aus `stop-all.sh`:
```bash
# Don't stop tauri-driver - it's managed by the container init script
# and should remain running for subsequent test runs.
# pkill -f tauri-driver 2>/dev/null || true  # REMOVED
```

**Geänderte Dateien:**
- `scripts/stop-all.sh` - tauri-driver kill entfernt
- `tests/fixtures.ts` - Debug-Logging für Request-Tracing hinzugefügt

**Status:** ✅ GELÖST - Alle 68 haex-pass Tests bestehen jetzt.

---

### haex-pass API: SET_ITEM für Create und Update (GELÖST)
**Problem:** Die Extension verwendet "set-item" für sowohl Create als auch Update. Die Test-Konstanten hatten fälschlicherweise separate "create-item" und "update-item" Methoden definiert.

**Verfügbare Methoden:**
- `GET_ITEMS` - Einträge abrufen
- `GET_TOTP` - TOTP-Code generieren
- `SET_ITEM` - Eintrag erstellen oder aktualisieren (mit `id` Feld = Update, ohne = Create)
- `GET_PASSWORD_CONFIG` - Passwort-Generator-Konfiguration
- `GET_PASSWORD_PRESETS` - Passwort-Generator-Presets
- `PASSKEY_*` - WebAuthn-Methoden

**Fehlend:**
- `DELETE_ITEM` - Eintrag löschen

**Lösung:** `CREATE_ITEM` und `UPDATE_ITEM` in `haex-pass-api.ts` als deprecated Aliase für `SET_ITEM` ("set-item") definiert.

**Status:** GELÖST

---

### UI-E2E-Testing mit Tauri/WebDriver: Bekannte Hürden (GELÖST)

**1. Pinia Store-Zugriff aus WebDriver executeScript:**
`window.__pinia__` existiert NICHT in Nuxt 3. Stattdessen:
```javascript
const app = document.getElementById('__nuxt')?.__vue_app__;
const pinia = app?.config?.globalProperties?.$pinia;
const store = pinia?._s?.get('storeName');
```

**2. Cross-Container Requests (Vault B):**
`VaultAutomation.findElement()` und `sendKeys()` nutzen intern `fetch` ohne Host-Header-Override → scheitert bei Cross-Container-Zugriff (Vault B via socat-Proxy).
**Fix:** Immer `executeScript()` verwenden für Vault B — das nutzt `httpRequest()` mit korrektem Host-Header wenn `needsHostOverride` true ist.

**3. Settings-Fenster öffnen:**
Settings ist ein Floating-Window (kein Route). Der Launcher-Klick (`[data-testid="launcher-settings-item"]`) funktioniert über WebDriver nicht zuverlässig.
**Fix:** Direkt über den windowManager Pinia Store öffnen:
```javascript
const wm = pinia._s.get('windowManager');
wm.openWindowAsync({ sourceId: 'settings', type: 'system', params: { category: 'spaces' } });
```
Dann `[data-testid="settings-category-{cat}"]` klicken.

**4. Nuxt UI UiSelectMenu:**
`<UiSelectMenu multiple>` rendert Kontakt-Items als `data-slot` Buttons **ohne textContent**. WebDriver-basierte Selektion über Text ist nicht möglich.
**Workaround:** Für den Invite-Dialog: UI-Navigation zum Dialog verifizieren (Dropdown → Menüitem → Dialog öffnet), dann den eigentlichen Invite via `local_delivery_push_invite` Tauri-Command senden.

**5. Invite Dialog öffnen (SpaceListItem):**
Der Invite-Dropdown-Trigger ist ein **Icon-only Button** (kein Text). Finden über:
```javascript
const btn = [...item.querySelectorAll('button')].find(b => {
  const title = (b.getAttribute('title') || '').toLowerCase();
  return title.includes('invite') || title.includes('einlad');
});
```
Dropdown-Items haben `[role="menuitem"]`.

**6. Pending Invite Accept/Decline Buttons nicht sichtbar:**
Der `handle_push_invite` Handler erstellt auf Vault B einen Space-Eintrag in `haex_spaces`. Dadurch wird das Invite-Item als reguläres Space-Item gerendert (nicht als dashed-border Pending-Item). Accept/Decline Buttons sind dann nicht direkt sichtbar.
**Workaround:** Fallback auf CRDT-Delete für Decline, Status-Update für Accept.

**7. Outbox-Verarbeitung (processOutboxAsync):**
Wird NICHT automatisch nach `queueQuicInviteAsync` getriggert. Der Sync-Orchestrator ruft es periodisch auf. Dynamische Imports (`import('/src/...')`) funktionieren nicht aus `executeScript`.
**Workaround:** Direkt `local_delivery_push_invite` verwenden statt über die Outbox.

**8. Self-Invite Verhalten:**
`local_delivery_push_invite` an eigene nodeId wirft: `"Connecting to ourself is not supported"` (Error, nicht `false` Return). Test muss try/catch verwenden.

**Status:** ✅ GELÖST — Alle 19 QUIC Invite E2E Tests bestehen.

---

### QUIC Connection Lost bei sequentiellen Peer-Storage-Requests (GELÖST)
**Problem:** P2P-Tests scheiterten mit `Protocol error: Failed to read from stream: connection lost` beim zweiten Request an denselben Peer.

**Root Cause:** Jede `remote_*()` Methode in `peer_storage/endpoint.rs` erstellte per `endpoint.connect()` eine neue QUIC-Verbindung, obwohl der Server (`handle_connection`) für Stream-Multiplexing auf einer einzelnen Verbindung gebaut ist. Die Verbindungs-Teardown-Race-Condition war in Docker-CI besonders ausgeprägt.

**Lösung:** Connection-Caching per Remote-Peer in `PeerEndpoint`:
- `open_stream()` Helper: cached Connections in `Mutex<HashMap<EndpointId, Connection>>`, evicted stale Connections automatisch
- `send_request()` / `send_request_header()` Helpers: eliminieren ~240 Zeilen Boilerplate
- Pattern folgt dem `PeerSession` aus `space_delivery/local/peer.rs`

**Geänderte Dateien:**
- `haex-vault/src-tauri/src/peer_storage/endpoint.rs` — Connection-Cache + DRY-Refactoring (115 Zeilen hinzu, 240 entfernt)

**Status:** ✅ GELÖST — P2P Storage Tests bestehen (338 passed)

---

### QUIC Invite Accept scheitert (TEILWEISE GELÖST)

**Ursprüngliches Problem:** `startP2PEndpoint()` nutzte `executeScript` statt den echten UI-Flow → Leader wurden nicht gestartet → kein `delivery_handler` → Connection lost.

**Fix 1 — P2P Start via UI (GELÖST):**
`startP2PEndpoint()` umgebaut: Settings → P2P Storage → Connection → Start-Button klicken.
- Triggert `onToggleEndpointAsync()` in `connection.vue` → voller Vue-Lifecycle
- Leader werden korrekt gestartet (`isLeader=true`)
- PushInvite-Delivery A→B funktioniert (Outbox: delivered, Pending Invite auf B erstellt)

**Fix 2 — Stale Invite Data Cleanup (GELÖST):**
Vor jedem Invite-Test: alte `haex_pending_invites`, `haex_spaces`, `haex_invite_outbox` Einträge auf Vault B löschen.
- PushInvite-Handler rejected Invites wenn der Space bereits `status='active'` ist
- Ohne Cleanup werden re-runs abgelehnt

**Fix 3 — MLS "GroupId already exists" (GELÖST in haex-vault):**
`process_welcome()` in `mls/manager.rs` bereinigt jetzt bestehende MLS-Gruppen vor dem Re-Join:
```rust
if let Ok(Some(mut old_group)) = MlsGroup::load(self.provider.storage(), &expected_group_id) {
    let _ = old_group.delete(self.provider.storage());
}
```
Ohne diesen Fix crasht ClaimInvite wenn eine MLS-Gruppe von einem früheren Join existiert.

**Verbleibendes Problem — UI Accept-Button:**
Der Accept-Button in der UI wird korrekt geklickt, aber `onAcceptInviteAsync()` schlägt manchmal fehl.
Mögliche Ursache: Der Vue-Handler erkennt den Entry nicht als `kind === 'pending'`, oder der ClaimInvite schlägt aus anderen Gründen fehl. Der direkte Tauri-Command-Aufruf (`local_delivery_claim_invite`) funktioniert als Fallback.

**Geänderte Dateien:**
- `haex-e2e-tests/tests/spaces/invitations/quic-invite-flow.spec.ts` — `startP2PEndpoint()` UI-Flow, Cleanup, Diagnostik
- `haex-vault/src-tauri/src/mls/manager.rs` — Stale-Group-Cleanup in `process_welcome()`

**Status:** ⏳ IN PROGRESS — P2P Start + Invite Delivery gelöst, Accept braucht noch Verifikation

---

## Debugging-Tipps

### WebSocket-Kommunikation loggen
Alle Logs mit `[E2E]` Prefix sind Test-Logs:
```bash
# Nur E2E-Logs anzeigen
pnpm test 2>&1 | grep "\[E2E\]"
```

### Vault-State prüfen
```typescript
const vault = new VaultAutomation();
await vault.createSession();
const pending = await vault.getPendingAuthorizations();
console.log("Pending:", pending);
const dirty = await vault.getDirtyTables();
console.log("Dirty tables:", dirty);
```

### Headed Mode für Debugging
```bash
pnpm test:headed
# oder
pnpm test:debug  # Mit Playwright Inspector
```
