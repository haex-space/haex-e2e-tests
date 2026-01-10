# Code-Patterns & Konventionen

## Dateistruktur

### Test-Dateien
- Speicherort: `tests/<feature>/*.spec.ts`
- Naming: `<feature-name>.spec.ts`
- Imports immer aus `../fixtures`

### Fixture-Dateien
- Speicherort: `fixtures/*.ts`
- Export: Named exports für Interfaces und Daten-Arrays

## Test-Patterns

### Test-Setup
```typescript
import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  waitForBridgeConnection,
  authorizeClient,
  HAEX_PASS_METHODS, // IMMER Konstanten aus SDK verwenden!
} from "../fixtures";

test.describe("feature-name", () => {
  test.describe.configure({ mode: "serial" }); // Immer serial wegen geteiltem State

  test("should do something", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      await authorizeClient(client, EXTENSION_ID);
      // ... test logic
    } finally {
      client.disconnect(); // IMMER im finally-Block
    }
  });
});
```

### Ressourcen-Cleanup
```typescript
// Pattern: try/finally für alle Clients
const client = new VaultBridgeClient();
const vault = new VaultAutomation();

try {
  // Test-Logik
} finally {
  client.disconnect();
  await vault.deleteSession();
}
```

### Async Polling
```typescript
// Nutze waitFor Helper für async Bedingungen
import { waitFor } from "../fixtures";

const result = await waitFor(
  async () => {
    const data = await fetchSomething();
    return data.ready ? data : null;
  },
  { timeout: 10000, interval: 100, message: "Data not ready" }
);
```

## Naming-Konventionen

### Variablen
- `client` - VaultBridgeClient Instanz
- `vault` - VaultAutomation Instanz
- `syncClient` - SyncServerClient Instanz
- `state` - Connection/Sync State Objekt

### Konstanten
- `EXTENSION_ID` - Browser Extension ID
- `WEBSOCKET_PORT`, `WEBSOCKET_URL` - WebSocket Konfiguration
- `TAURI_DRIVER_URL` - WebDriver URL
- `SYNC_SERVER_URL` - Sync Server URL
- `HAEX_PASS_METHODS` - API-Methoden aus SDK (KEINE magic strings!)

### HAEX_PASS_METHODS
**WICHTIG:** Immer Konstanten statt Strings verwenden!
```typescript
// RICHTIG:
client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, { ... })
client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, { ... })
client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, { ... })

// FALSCH:
client.sendRequest("set-item", { ... })
client.sendRequest("get-items", { ... })
```

### Test-IDs
- Format: `test-entry-<name>` für Einträge
- Format: `test-group-<name>` für Gruppen
- Format: `test-vault-<random>` für Vaults

## Logging

```typescript
// Prefix [E2E] für alle Test-Logs
console.log("[E2E] WebSocket connected to bridge");
console.error("[E2E] Failed to decrypt response:", err);
console.warn("[E2E] Unknown message type:", message.type);
```

## Verschlüsselung

### ECDH-Schlüsselpaar generieren
```typescript
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

// Export als Base64 SPKI
const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
const publicKeyBase64 = publicKeyDer.toString("base64");
```

### Client-ID aus Public Key
```typescript
const hash = crypto.createHash("sha256").update(publicKeyDer).digest();
const clientId = hash.subarray(0, 16).toString("hex");
```

### AES-256-GCM Verschlüsselung
```typescript
// Verschlüsseln
const iv = crypto.randomBytes(12); // 12 Bytes für GCM
const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();
const ciphertext = Buffer.concat([encrypted, authTag]);

// Entschlüsseln
const authTag = ciphertext.subarray(ciphertext.length - 16);
const encryptedData = ciphertext.subarray(0, ciphertext.length - 16);
const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
decipher.setAuthTag(authTag);
const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
```

## Test-Daten

### Entry-Struktur
```typescript
interface TestEntry {
  id: string;
  title: string;
  url: string | null;
  username: string | null;
  password: string | null;
  otpSecret: string | null;
  otpDigits?: number;      // Default: 6
  otpPeriod?: number;      // Default: 30
  otpAlgorithm?: string;   // Default: SHA1
  groupId: string | null;
  keyValues?: { key: string; value: string }[];
}
```

### TOTP Test-Secrets
- Standard: `JBSWY3DPEHPK3PXP`
- SHA256: `GEZDGNBVGY3TQOJQ`

## Error Handling

### Request-Fehler
```typescript
// Erwartete Fehler prüfen
await expect(
  client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, { url: "https://example.com" })
).rejects.toThrow("Not authorized");
```

### State-Prüfung vor Request
```typescript
if (this.state !== "paired") {
  throw new Error("Not authorized");
}
if (!this.ws || this.ws.readyState !== WS.OPEN) {
  throw new Error("Not connected");
}
```

## Playwright-Konfiguration

### Extension laden
```typescript
const context = await chromium.launchPersistentContext("", {
  headless: false, // Extensions brauchen headed mode
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
  ],
});
```

### Extension-ID ermitteln
```typescript
let [background] = context.serviceWorkers();
if (!background) {
  background = await context.waitForEvent("serviceworker");
}
const extensionId = background.url().split("/")[2];
```
