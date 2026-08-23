# API Contracts

## Browser Bridge WebSocket Protocol (Port 19455)

### Handshake

**Client → Server:**
```json
{
  "type": "handshake",
  "version": 1,
  "client": {
    "clientId": "hex-string-32-chars",
    "clientName": "E2E Test Client",
    "publicKey": "base64-spki-public-key"
  }
}
```

**Server → Client:**
```json
{
  "type": "handshakeResponse",
  "serverPublicKey": "base64-spki-public-key",
  "authorized": false,
  "pendingApproval": true
}
```

### Authorization Update

**Server → Client:**
```json
{
  "type": "authorizationUpdate",
  "authorized": true
}
```

### Encrypted Request

**Client → Server:**
```json
{
  "type": "request",
  "action": "get-logins",
  "message": "base64-aes-gcm-encrypted-payload",
  "iv": "base64-12-bytes",
  "clientId": "hex-string-32-chars",
  "publicKey": "base64-ephemeral-public-key"
}
```

**Payload (vor Verschlüsselung):**
```json
{
  "requestId": "hex-string-32-chars",
  "url": "https://example.com",
  "fields": ["username", "password"]
}
```

### Encrypted Response

**Server → Client:**
```json
{
  "type": "response",
  "action": "get-logins",
  "message": "base64-aes-gcm-encrypted-response",
  "iv": "base64-12-bytes",
  "clientId": "hex-string",
  "publicKey": "base64-ephemeral-public-key"
}
```

### Error Response

**Server → Client:**
```json
{
  "type": "error",
  "code": "NOT_AUTHORIZED",
  "message": "Client not authorized"
}
```

---

## haex-pass Actions

### get-logins

**Request:**
```json
{
  "requestId": "string",
  "url": "https://example.com",
  "fields": ["username", "password", "totp"]
}
```

**Response:**
```json
{
  "requestId": "string",
  "success": true,
  "entries": [
    {
      "id": "entry-uuid",
      "title": "Example Site",
      "username": "user@example.com",
      "password": "secret123",
      "totp": "123456"
    }
  ]
}
```

### set-login

**Request:**
```json
{
  "requestId": "string",
  "title": "New Entry",
  "url": "https://newsite.com",
  "username": "newuser",
  "password": "newpass",
  "groupId": null
}
```

**Response:**
```json
{
  "requestId": "string",
  "success": true,
  "entryId": "new-entry-uuid"
}
```

### get-totp

**Request:**
```json
{
  "requestId": "string",
  "entryId": "entry-uuid"
}
```

**Response:**
```json
{
  "requestId": "string",
  "success": true,
  "totp": "123456",
  "period": 30,
  "remaining": 15
}
```

---

## Tauri Commands (via WebDriver)

### create_encrypted_database

**Args:**
```json
{
  "vaultName": "string",
  "key": "string",
  "vaultId": null
}
```

**Response:** `string` - Vault file path (NOT a UUID), e.g. `/config/.local/share/space.haex.vault/vaults/my-vault.db`

### open_encrypted_database

**Args:**
```json
{
  "vaultPath": "string",
  "key": "string"
}
```

**Response:** `string` - Vault file path (same format as create_encrypted_database)

### get_pending_authorizations

**Response:**
```typescript
Array<{
  clientId: string;
  clientName: string;
  publicKey: string;
  extensionId: string;
}>
```

### approve_client_authorization

**Args:**
```json
{
  "clientId": "string",
  "clientName": "string",
  "publicKey": "string",
  "extensionId": "string"
}
```

### deny_client_authorization

**Args:**
```json
{
  "clientId": "string"
}
```

### revoke_client_authorization

**Args:**
```json
{
  "clientId": "string"
}
```

### get_dirty_tables

**Response:**
```typescript
string[]  // ["entries", "groups", ...]
```

### trigger_sync_push / trigger_sync_pull

**Response:** void

### get_sync_state

**Response:**
```typescript
{
  isConnected: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
}
```

---

## haex-sync-server REST API (Port 3002)

### DID-Auth proof of possession

All protected sync-server HTTP routes use a request-bound DID-Auth header,
not a bearer token:

```
Authorization: DID <base64url-payload>.<base64url-signature>
```

The payload is created with `@haex-space/ucan`'s
`createSignedAuthHeader` and binds the signature to the complete request:

- HTTP method (defaults to `GET`)
- URL pathname
- raw query string (without `?`)
- exact raw request body (or an empty string)

`createDidAuthHeader(privateKeyBase64, did, { method?, url, body? })` in
`tests/helpers/sync-server-helpers.ts` is the only E2E helper for creating
this value. Reusing a valid header for a different method, path, query, or
body must fail with `401` and `PoP request mismatch`.

The WebSocket endpoint applies the same binding. It accepts the unprefixed
DID token as `GET /ws?token=<payload>.<signature>`; the signature is made for
`GET /ws` with an empty raw query and body. Authentication failures close the
connection with code `4001`.

### Health Check

`GET /`

**Response:**
```json
{
  "name": "haex-sync-server",
  "version": "1.0.0",
  "status": "ok"
}
```

### Push Changes

`POST /sync/push`

**Headers:**
- `Authorization: DID <signed-request>`
- `Content-Type: application/json`

**Request:**
```json
{
  "vaultId": "vault-uuid",
  "changes": [
    {
      "tableName": "entries",
      "rowPks": "{\"id\":\"entry-uuid\"}",
      "columnName": "title",
      "hlcTimestamp": "2024-01-15T10:30:00.000Z:00000001:device-id",
      "deviceId": "device-uuid",
      "encryptedValue": "base64-encrypted",
      "nonce": "base64-nonce"
    }
  ]
}
```

**Response:**
```json
{
  "count": 1,
  "lastHlc": "2024-01-15T10:30:00.000Z:00000001:device-id",
  "serverTimestamp": "2024-01-15T10:30:01.000Z"
}
```

### Pull Changes

`GET /sync/pull`

**Query Parameters:**
- `vaultId` (required)
- `excludeDeviceId` (optional)
- `afterUpdatedAt` (optional)
- `limit` (optional, default 1000)

**Headers:**
- `Authorization: DID <signed-request>`

**Response:**
```json
{
  "changes": [
    {
      "tableName": "entries",
      "rowPks": "{\"id\":\"entry-uuid\"}",
      "columnName": "title",
      "hlcTimestamp": "2024-01-15T10:30:00.000Z:00000001:other-device",
      "encryptedValue": "base64-encrypted",
      "nonce": "base64-nonce",
      "deviceId": "other-device-id",
      "updatedAt": "2024-01-15T10:30:01.000Z"
    }
  ],
  "hasMore": false,
  "serverTimestamp": "2024-01-15T10:31:00.000Z"
}
```

### List Vaults

`GET /sync/vaults`

**Headers:**
- `Authorization: DID <signed-request>`

**Response:**
```json
{
  "vaults": [
    {
      "vaultId": "vault-uuid",
      "encryptedVaultName": "base64-encrypted",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### Delete Vault

`DELETE /sync/vault/:vaultId`

**Headers:**
- `Authorization: DID <signed-request>`

**Response:** 204 No Content

---

## HLC Timestamp Format

```
<ISO-Timestamp>:<Counter>:<NodeId>

Beispiel: 2024-01-15T10:30:00.000Z:00000001:device-abc123
```

- ISO-Timestamp: RFC 3339 Format
- Counter: 8-stellig, zero-padded
- NodeId: Device/Node Identifier
