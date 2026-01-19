import {
  test as base,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { WebSocket as WS } from "ws";
import * as crypto from "crypto";
import * as fs from "node:fs";
import * as http from "node:http";

// Import command constants from vault-sdk
// In container: vault-sdk is linked via pnpm link /repos/vault-sdk
// On host: install with `pnpm add -D @haex-space/vault-sdk@github:haex-space/vault-sdk`
import { TAURI_COMMANDS } from "@haex-space/vault-sdk";

// Import haex-pass API constants
import { HAEX_PASS_METHODS } from "./haex-pass-api";

// Path to built browser extension
const EXTENSION_PATH = "/repos/haextension/apps/haex-pass-browser/extension";

// WebSocket connection settings
const WEBSOCKET_PORT = 19455;
const WEBSOCKET_URL = `ws://localhost:${WEBSOCKET_PORT}`;
const PROTOCOL_VERSION = 1;
const CLIENT_NAME = "E2E Test Client";

// tauri-driver WebDriver URLs (different for each vault container)
const TAURI_DRIVER_URL = "http://localhost:4444";

// Multi-vault configuration for dual-container testing
// tauri-driver binds to localhost only, but we use socat proxy on port 4446 for cross-container access
// IMPORTANT: tauri-driver validates Host header - must be "localhost:4444"

// Detect which container we're running in
// VAULT_INSTANCE is set in docker-compose.yml for each container
const rawVaultInstance = process.env.VAULT_INSTANCE;
// Normalize to uppercase and trim to handle any formatting issues
const currentInstance = rawVaultInstance?.toUpperCase().trim() as "A" | "B" | undefined;

// If VAULT_INSTANCE is not set, we assume we're running in the primary vault container (A)
// This is the case when using `docker compose run vault-a pnpm test` which doesn't
// properly pass through environment variables from the docker-compose.yml service definition
const effectiveInstance = currentInstance ?? "A";
const isInContainer = rawVaultInstance !== undefined;

// Debug logging for CI troubleshooting
console.log("[E2E Config] VAULT_INSTANCE raw:", JSON.stringify(rawVaultInstance));
console.log("[E2E Config] VAULT_INSTANCE normalized:", JSON.stringify(currentInstance));
console.log("[E2E Config] effectiveInstance:", effectiveInstance);
console.log("[E2E Config] isInContainer:", isInContainer);

// Helper to determine URL for a vault instance
// When running in the same container as the vault, use localhost
// When running in a different container, use the container hostname via socat proxy
function getVaultUrl(targetInstance: "A" | "B"): string {
  // Use effectiveInstance which defaults to "A" if not set
  const isLocalInstance = effectiveInstance === targetInstance;
  if (isLocalInstance) {
    return "http://localhost:4444";
  }
  // Use container hostname for cross-container access
  return targetInstance === "A" ? "http://vault-a:4446" : "http://vault-b:4446";
}

export const VAULT_CONFIG = {
  A: {
    // When in vault-a container: use localhost directly
    // When in other container: use socat proxy on port 4446 (requires Host header override)
    tauriDriverUrl: getVaultUrl("A"),
    // Host header that tauri-driver expects
    tauriDriverHostHeader: "localhost:4444",
    // Bridge is always local (localhost:19455) - no cross-container access needed
    // Sync between vaults happens via sync-server, not via WebSocket bridge
    bridgePort: 19455,
    bridgeHost: "localhost",
    webtopPort: 3000,
    containerName: "haex_e2e_vault_a",
    // Whether we need to override Host header for this config
    // Use effectiveInstance for consistent behavior
    needsHostOverride: effectiveInstance !== "A",
  },
  B: {
    // When in vault-b container: use localhost directly
    // When in other container: use socat proxy on port 4446 (requires Host header override)
    tauriDriverUrl: getVaultUrl("B"),
    tauriDriverHostHeader: "localhost:4444",
    // Bridge is always local (localhost:19455) - no cross-container access needed
    // Sync between vaults happens via sync-server, not via WebSocket bridge
    bridgePort: 19455,
    bridgeHost: "localhost",
    webtopPort: 3001,
    containerName: "haex_e2e_vault_b",
    // Use effectiveInstance for consistent behavior
    needsHostOverride: effectiveInstance !== "B",
  },
} as const;

// Log the final configuration for debugging
console.log("[E2E Config] VAULT_CONFIG.A.tauriDriverUrl:", VAULT_CONFIG.A.tauriDriverUrl);
console.log("[E2E Config] VAULT_CONFIG.B.tauriDriverUrl:", VAULT_CONFIG.B.tauriDriverUrl);

export type VaultInstance = keyof typeof VAULT_CONFIG;

// haex-vault extension ID file (written by global-setup)
const HAEX_VAULT_EXTENSION_ID_FILE = "/tmp/e2e-haex-pass-extension-id.txt";

// haex-pass extension public key file (copied by Dockerfile)
const HAEX_PASS_PUBLIC_KEY_FILE = "/app/haex-pass-public.key";

// haex-pass extension name
const HAEX_PASS_EXTENSION_NAME = "haex-pass";

// Sync server URL (from docker-compose environment)
const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL || "http://localhost:3002";

/**
 * Get the haex-vault extension ID (for client authorization)
 * This is different from the Chrome extension ID!
 */
function getHaexVaultExtensionId(): string {
  try {
    return fs.readFileSync(HAEX_VAULT_EXTENSION_ID_FILE, "utf-8").trim();
  } catch {
    throw new Error(
      `Could not read haex-vault extension ID from ${HAEX_VAULT_EXTENSION_ID_FILE}. ` +
      `Make sure global-setup has run and registered the haex-pass extension.`
    );
  }
}

/**
 * Get the haex-pass extension public key (for request routing)
 */
function getHaexPassPublicKey(): string {
  try {
    return fs.readFileSync(HAEX_PASS_PUBLIC_KEY_FILE, "utf-8").trim();
  } catch {
    throw new Error(
      `Could not read haex-pass public key from ${HAEX_PASS_PUBLIC_KEY_FILE}. ` +
      `Make sure the Docker image was built correctly.`
    );
  }
}

/**
 * ECDH key pair for encryption
 */
interface KeyPair {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

/**
 * Connection state types matching the browser extension
 */
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "pending_approval"
  | "paired";

/**
 * Vault connection state
 */
interface VaultConnectionState {
  state: ConnectionState;
  clientId: string | null;
  error: string | null;
  serverPublicKey: crypto.KeyObject | null;
}

/**
 * Pending authorization from the Vault
 */
interface PendingAuthorization {
  clientId: string;
  clientName: string;
  publicKey: string;
  extensionId: string;
}

/**
 * Custom fixture types
 */
export type TestFixtures = {
  context: BrowserContext;
  extensionId: string;
  vaultClient: VaultBridgeClient;
  vaultPage: Page;
};

/**
 * Client for communicating with haex-vault via the browser bridge
 */
export class VaultBridgeClient {
  private ws: WS | null = null;
  private keyPair: KeyPair | null = null;
  private clientId: string | null = null;
  private publicKeyBase64: string | null = null;
  private serverPublicKey: crypto.KeyObject | null = null;
  private state: ConnectionState = "disconnected";
  private error: string | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();
  private stateChangeHandlers: Set<(state: VaultConnectionState) => void> =
    new Set();
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    // Generate ECDH key pair using P-256 curve
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });

    this.keyPair = { publicKey, privateKey };

    // Export public key to SPKI format and base64 encode
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    this.publicKeyBase64 = publicKeyDer.toString("base64");

    // Generate client ID from public key hash (first 16 bytes of SHA-256)
    const hash = crypto.createHash("sha256").update(publicKeyDer).digest();
    this.clientId = hash.subarray(0, 16).toString("hex");
  }

  private notifyStateChange() {
    const connection: VaultConnectionState = {
      state: this.state,
      clientId: this.clientId,
      error: this.error,
      serverPublicKey: this.serverPublicKey,
    };
    this.stateChangeHandlers.forEach((handler) => handler(connection));
  }

  onStateChange(handler: (state: VaultConnectionState) => void): () => void {
    this.stateChangeHandlers.add(handler);
    handler({
      state: this.state,
      clientId: this.clientId,
      error: this.error,
      serverPublicKey: this.serverPublicKey,
    });
    return () => this.stateChangeHandlers.delete(handler);
  }

  getState(): VaultConnectionState {
    return {
      state: this.state,
      clientId: this.clientId,
      error: this.error,
      serverPublicKey: this.serverPublicKey,
    };
  }

  getClientId(): string | null {
    return this.clientId;
  }

  getPublicKeyBase64(): string | null {
    return this.publicKeyBase64;
  }

  /**
   * Connect to the browser bridge WebSocket
   */
  async connect(): Promise<void> {
    await this.initPromise;

    if (this.ws && this.ws.readyState === WS.OPEN) {
      return;
    }

    this.state = "connecting";
    this.error = null;
    this.notifyStateChange();

    return new Promise((resolve, reject) => {
      this.ws = new WS(WEBSOCKET_URL);

      this.ws.on("open", () => {
        console.log("[E2E] WebSocket connected to bridge");
        this.sendHandshake();
      });

      this.ws.on("message", async (data: Buffer) => {
        await this.handleMessage(data.toString());
      });

      this.ws.on("close", () => {
        console.log("[E2E] WebSocket closed");
        this.state = "disconnected";
        this.serverPublicKey = null;
        this.notifyStateChange();
      });

      this.ws.on("error", (err: Error) => {
        console.error("[E2E] WebSocket error:", err);
        this.error = "Connection failed - is haex-vault running?";
        this.state = "disconnected";
        this.notifyStateChange();
        reject(new Error(this.error));
      });

      // Wait for connection to stabilize
      setTimeout(() => {
        if (this.ws?.readyState === WS.OPEN) {
          resolve();
        }
      }, 100);
    });
  }

  private sendHandshake(): void {
    if (!this.ws || !this.clientId || !this.publicKeyBase64) return;

    const handshake = {
      type: "handshake",
      version: PROTOCOL_VERSION,
      client: {
        clientId: this.clientId,
        clientName: CLIENT_NAME,
        publicKey: this.publicKeyBase64,
      },
    };

    console.log("[E2E] Sending handshake");
    this.ws.send(JSON.stringify(handshake));
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "handshakeResponse":
          await this.handleHandshakeResponse(message);
          break;

        case "response":
          await this.handleEncryptedResponse(message);
          break;

        case "authorizationUpdate":
          this.handleAuthorizationUpdate(message);
          break;

        case "error":
          console.error("[E2E] Server error:", message.code, message.message);
          this.error = message.message;
          this.notifyStateChange();
          break;

        case "pong":
          // Ignore pong responses
          break;

        default:
          console.warn("[E2E] Unknown message type:", message.type);
      }
    } catch (err) {
      console.error("[E2E] Failed to handle message:", err);
    }
  }

  private async handleHandshakeResponse(response: {
    serverPublicKey: string;
    authorized: boolean;
    pendingApproval: boolean;
  }): Promise<void> {
    console.log("[E2E] Received handshake response:", {
      authorized: response.authorized,
      pendingApproval: response.pendingApproval,
    });

    // Import server's public key
    if (response.serverPublicKey) {
      const keyDer = Buffer.from(response.serverPublicKey, "base64");
      this.serverPublicKey = crypto.createPublicKey({
        key: keyDer,
        format: "der",
        type: "spki",
      });
    }

    if (response.authorized) {
      this.state = "paired";
      console.log("[E2E] Client is authorized");
    } else if (response.pendingApproval) {
      this.state = "pending_approval";
      console.log("[E2E] Waiting for user approval in haex-vault");
    } else {
      this.state = "connected";
      console.log("[E2E] Connected but not authorized");
    }

    this.notifyStateChange();
  }

  private async handleEncryptedResponse(envelope: {
    action: string;
    message: string;
    iv: string;
    clientId: string;
    publicKey: string;
  }): Promise<void> {
    if (!this.keyPair) {
      console.error("[E2E] Cannot decrypt: no keypair");
      return;
    }

    try {
      // Import sender's ephemeral public key
      const senderKeyDer = Buffer.from(envelope.publicKey, "base64");
      const senderPublicKey = crypto.createPublicKey({
        key: senderKeyDer,
        format: "der",
        type: "spki",
      });

      // Derive shared secret using ECDH
      const sharedSecret = crypto.diffieHellman({
        privateKey: this.keyPair.privateKey,
        publicKey: senderPublicKey,
      });

      // Use first 32 bytes as AES key
      const aesKey = sharedSecret.subarray(0, 32);

      // Decrypt the message
      const iv = Buffer.from(envelope.iv, "base64");
      const ciphertext = Buffer.from(envelope.message, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);

      // AES-GCM includes auth tag in the last 16 bytes
      const authTag = ciphertext.subarray(ciphertext.length - 16);
      const encryptedData = ciphertext.subarray(0, ciphertext.length - 16);

      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);

      const decryptedData = JSON.parse(decrypted.toString("utf-8"));
      console.log("[E2E] Decrypted response:", decryptedData);

      // Check if this is a response to a pending request
      const requestId = decryptedData.requestId;
      if (requestId && this.pendingRequests.has(requestId)) {
        const pending = this.pendingRequests.get(requestId)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        pending.resolve(decryptedData);
      }
    } catch (err) {
      console.error("[E2E] Failed to decrypt response:", err);
    }
  }

  private handleAuthorizationUpdate(update: { authorized: boolean }): void {
    if (update.authorized) {
      this.state = "paired";
      console.log("[E2E] Authorization granted!");
    } else {
      this.state = "connected";
      console.log("[E2E] Authorization denied");
    }
    this.notifyStateChange();
  }

  /**
   * Wait for authorization to be granted
   */
  async waitForAuthorization(timeout = 30000): Promise<boolean> {
    if (this.state === "paired") {
      return true;
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);

      const cleanup = this.onStateChange((state) => {
        if (state.state === "paired") {
          clearTimeout(timeoutId);
          cleanup();
          resolve(true);
        } else if (
          state.state === "disconnected" ||
          state.state === "connected"
        ) {
          // Authorization was denied or connection lost
          clearTimeout(timeoutId);
          cleanup();
          resolve(false);
        }
      });
    });
  }

  /**
   * Send an encrypted request to the vault
   */
  async sendRequest<T = unknown>(
    action: string,
    payload: object,
    timeout = 10000
  ): Promise<T> {
    await this.initPromise;

    if (!this.ws || this.ws.readyState !== WS.OPEN) {
      throw new Error("Not connected");
    }

    if (!this.serverPublicKey || !this.keyPair) {
      throw new Error("Handshake not complete");
    }

    if (this.state !== "paired") {
      throw new Error("Not authorized");
    }

    const requestId = crypto.randomBytes(16).toString("hex");
    const payloadWithId = { ...payload, requestId };

    // Generate ephemeral key pair for forward secrecy
    const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } =
      crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });

    // Derive shared secret using ECDH
    const sharedSecret = crypto.diffieHellman({
      privateKey: ephemeralPrivate,
      publicKey: this.serverPublicKey,
    });

    // Use first 32 bytes as AES key
    const aesKey = sharedSecret.subarray(0, 32);

    // Generate random IV (12 bytes for GCM)
    const iv = crypto.randomBytes(12);

    // Encrypt the payload
    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payloadWithId), "utf-8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine encrypted data with auth tag
    const ciphertext = Buffer.concat([encrypted, authTag]);

    // Export ephemeral public key
    const ephemeralPublicKeyBase64 = ephemeralPublic
      .export({ type: "spki", format: "der" })
      .toString("base64");

    // Get extension info for request routing
    const extensionPublicKey = getHaexPassPublicKey();

    // Create request envelope with extension info
    const request = {
      type: "request",
      action,
      message: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      clientId: this.clientId,
      publicKey: ephemeralPublicKeyBase64,
      extensionPublicKey,
      extensionName: HAEX_PASS_EXTENSION_NAME,
    };

    console.log("[E2E] Sending request:", {
      action,
      requestId,
      extensionPublicKey: extensionPublicKey.substring(0, 16) + "...",
      extensionName: HAEX_PASS_EXTENSION_NAME,
      clientId: this.clientId,
      timeout,
    });

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.log("[E2E] Request timeout for requestId:", requestId);
        reject(new Error("Request timeout"));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutHandle,
      });

      this.ws!.send(JSON.stringify(request));
      console.log("[E2E] Request sent via WebSocket");
    });
  }

  /**
   * Get items (logins) matching a URL
   */
  async getItems(url: string, fields: string[]): Promise<unknown> {
    return this.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, { url, fields });
  }

  /**
   * Save a new item entry
   */
  async setItem(entry: object): Promise<unknown> {
    return this.sendRequest(HAEX_PASS_METHODS.SET_ITEM, entry);
  }

  /**
   * Get TOTP code for an entry
   */
  async getTotp(entryId: string): Promise<unknown> {
    return this.sendRequest(HAEX_PASS_METHODS.GET_TOTP, { entryId });
  }

  // Legacy aliases for backwards compatibility
  /** @deprecated Use getItems instead */
  async getLogins(url: string, fields: string[]): Promise<unknown> {
    return this.getItems(url, fields);
  }

  /** @deprecated Use setItem instead */
  async setLogin(entry: object): Promise<unknown> {
    return this.setItem(entry);
  }

  /**
   * Disconnect from the bridge
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.state = "disconnected";
    this.serverPublicKey = null;
    this.notifyStateChange();
  }
}

/**
 * Sync change from the server
 */
export interface SyncChange {
  tableName: string;
  rowPks: string;
  columnName: string | null;
  hlcTimestamp: string;
  encryptedValue: string | null;
  nonce: string | null;
  deviceId?: string;
  updatedAt: string;
}

/**
 * Client for direct communication with haex-sync-server
 * Used for test verification and simulating server-side changes
 */
export class SyncServerClient {
  private authToken: string | null = null;
  private refreshToken: string | null = null;
  private baseUrl: string;

  constructor(baseUrl: string = SYNC_SERVER_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Set the authentication token (from Supabase login)
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Get the current auth token
   */
  getAuthToken(): string | null {
    return this.authToken;
  }

  /**
   * Get the refresh token
   */
  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  /**
   * Check if the sync server is healthy
   */
  async healthCheck(): Promise<{ name: string; version: string; status: string }> {
    const response = await fetch(`${this.baseUrl}/`);
    if (!response.ok) {
      throw new Error(`Sync server health check failed: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Register a new user on the sync server via admin endpoint
   * Requires the SUPABASE_SERVICE_KEY for authorization
   */
  async register(email: string, password: string): Promise<{
    message: string;
    user: { id: string; email: string };
  }> {
    // Use the admin endpoint with service key authorization
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!serviceKey) {
      throw new Error("SUPABASE_SERVICE_KEY environment variable not set");
    }

    const response = await fetch(`${this.baseUrl}/auth/admin/create-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Registration failed: ${response.status} - ${error.error || error.message}`);
    }

    const data = await response.json();
    return {
      message: "Registration successful",
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    };
  }

  /**
   * Login to the sync server and get JWT token
   * Uses GoTrue for authentication via the standard /auth/login endpoint
   */
  async login(email: string, password: string): Promise<{
    message: string;
    user: { id: string; email: string };
    access_token: string;
    refresh_token: string;
  }> {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Login failed: ${response.status} - ${error.error || error.message}`);
    }

    const data = await response.json();
    this.authToken = data.access_token;
    this.refreshToken = data.refresh_token;
    return {
      message: "Login successful",
      user: data.user,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    };
  }

  /**
   * Store encrypted vault key on the server
   */
  async storeVaultKey(params: {
    vaultId: string;
    encryptedVaultKey: string;
    salt: string;
    nonce: string;
    encryptedVaultName?: string;
  }): Promise<void> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const response = await fetch(`${this.baseUrl}/sync/vault-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Store vault key failed: ${response.status} - ${error.error || error.message}`);
    }
  }

  /**
   * Get encrypted vault key from the server
   */
  async getVaultKey(vaultId: string): Promise<{
    encryptedVaultKey: string;
    salt: string;
    nonce: string;
  }> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const response = await fetch(`${this.baseUrl}/sync/vault-key/${vaultId}`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Get vault key failed: ${response.status} - ${error.error || error.message}`);
    }

    return response.json();
  }

  /**
   * Push changes to the sync server
   */
  async pushChanges(
    vaultId: string,
    changes: Array<{
      tableName: string;
      rowPks: string;
      columnName: string | null;
      hlcTimestamp: string;
      deviceId?: string;
      encryptedValue: string | null;
      nonce: string | null;
    }>
  ): Promise<{ count: number; lastHlc: string | null; serverTimestamp: string }> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const response = await fetch(`${this.baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({ vaultId, changes }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Push failed: ${response.status} - ${error.error}`);
    }

    return response.json();
  }

  /**
   * Pull changes from the sync server
   */
  async pullChanges(
    vaultId: string,
    options?: {
      excludeDeviceId?: string;
      afterUpdatedAt?: string;
      limit?: number;
    }
  ): Promise<{ changes: SyncChange[]; hasMore: boolean; serverTimestamp: string }> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const params = new URLSearchParams({ vaultId });
    if (options?.excludeDeviceId) params.set("excludeDeviceId", options.excludeDeviceId);
    if (options?.afterUpdatedAt) params.set("afterUpdatedAt", options.afterUpdatedAt);
    if (options?.limit) params.set("limit", options.limit.toString());

    const response = await fetch(`${this.baseUrl}/sync/pull?${params}`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Pull failed: ${response.status} - ${error.error}`);
    }

    return response.json();
  }

  /**
   * Get all vaults for the authenticated user
   */
  async getVaults(): Promise<{
    vaults: Array<{
      vaultId: string;
      encryptedVaultName: string;
      createdAt: string;
    }>;
  }> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const response = await fetch(`${this.baseUrl}/sync/vaults`, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Get vaults failed: ${response.status} - ${error.error}`);
    }

    return response.json();
  }

  /**
   * Delete a vault and all its data
   */
  async deleteVault(vaultId: string): Promise<void> {
    if (!this.authToken) {
      throw new Error("No auth token set");
    }

    const response = await fetch(`${this.baseUrl}/sync/vault/${vaultId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(`Delete vault failed: ${response.status} - ${error.error}`);
    }
  }
}

/**
 * Sync event types emitted by haex-vault
 */
export type SyncEventType =
  | "crdt:dirty-tables-changed"
  | "sync:tables-updated"
  | "haextension:sync:tables-updated";

/**
 * Sync event data
 */
export interface SyncEvent {
  type: SyncEventType;
  data: {
    tables?: string[];
  };
}

// Session file path (shared with global-setup.ts)
const SESSION_FILE = "/tmp/e2e-webdriver-session.json";

/**
 * Helper class for automating haex-vault via tauri-driver WebDriver
 * Supports multiple vault instances via the `instance` parameter
 */
export class VaultAutomation {
  private sessionId: string | null = null;
  private tauriDriverUrl: string;
  private instance: VaultInstance;

  constructor(instance: VaultInstance = "A") {
    this.instance = instance;
    this.tauriDriverUrl = VAULT_CONFIG[instance].tauriDriverUrl;
  }

  /**
   * Get the vault instance identifier
   */
  getInstance(): VaultInstance {
    return this.instance;
  }

  /**
   * Get the tauri-driver URL for this instance
   */
  getTauriDriverUrl(): string {
    return this.tauriDriverUrl;
  }

  /**
   * Get the WebSocket bridge port for this instance
   */
  getBridgePort(): number {
    return VAULT_CONFIG[this.instance].bridgePort;
  }

  /**
   * Load the existing WebDriver session created by global-setup
   * This reuses the session instead of creating a new one (which would start another app instance)
   */
  async createSession(): Promise<void> {
    // For multi-vault tests, each instance has its own session file
    const sessionFile = this.instance === "A"
      ? SESSION_FILE
      : `/tmp/e2e-webdriver-session-${this.instance.toLowerCase()}.json`;

    try {
      const fs = await import("node:fs");

      // Check if session file exists - if not, we need to create a new session
      if (!fs.existsSync(sessionFile)) {
        console.log(`[E2E] No existing session for Vault ${this.instance}, creating new session...`);
        await this.createNewSession();
        return;
      }

      const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      this.sessionId = sessionData.sessionId;
      console.log(`[E2E] Using existing WebDriver session for Vault ${this.instance}:`, this.sessionId);
    } catch (error) {
      console.log(`[E2E] Failed to load session, creating new one:`, error);
      await this.createNewSession();
    }
  }

  /**
   * Create a new WebDriver session (for multi-vault tests)
   * Uses http module when Host header override is needed (Node.js fetch doesn't handle this)
   */
  async createNewSession(): Promise<void> {
    const vaultBinaryPath = "/repos/haex-vault/src-tauri/target/release/haex-space";

    const capabilities = {
      capabilities: {
        alwaysMatch: {
          "tauri:options": {
            application: vaultBinaryPath,
          },
        },
      },
    };

    console.log(`[E2E] Creating new WebDriver session at ${this.tauriDriverUrl}...`);

    const config = VAULT_CONFIG[this.instance];
    const body = JSON.stringify(capabilities);

    // Use http module when Host header override is needed (Node.js fetch doesn't work)
    if (config.needsHostOverride) {
      const data = await this.httpRequest("POST", "/session", body);
      this.sessionId = data.value?.sessionId || data.sessionId;
    } else {
      // Use fetch for local requests
      const response = await fetch(`${this.tauriDriverUrl}/session`, {
        method: "POST",
        headers: this.buildHeaders(),
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create WebDriver session: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      this.sessionId = data.value?.sessionId || data.sessionId;
    }

    if (!this.sessionId) {
      throw new Error("No session ID in response");
    }

    console.log(`[E2E] Created new WebDriver session for Vault ${this.instance}:`, this.sessionId);

    // Save session to file for potential reuse
    const nodeFs = await import("node:fs");
    const sessionFile = this.instance === "A"
      ? SESSION_FILE
      : `/tmp/e2e-webdriver-session-${this.instance.toLowerCase()}.json`;
    nodeFs.writeFileSync(sessionFile, JSON.stringify({ sessionId: this.sessionId }));
  }

  /**
   * Make HTTP request using Node.js http module
   * This is necessary for cross-container requests where Host header override is needed
   * (Node.js fetch/undici closes the connection when Host header is overridden)
   */
  private async httpRequest(
    method: string,
    path: string,
    body?: string
  ): Promise<Record<string, unknown>> {
    const parsedUrl = new URL(this.tauriDriverUrl);
    const config = VAULT_CONFIG[this.instance];

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(config.needsHostOverride ? { Host: config.tauriDriverHostHeader } : {}),
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        timeout: 30000,
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON response: ${data}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Build headers for WebDriver requests
   * tauri-driver validates Host header, so we need to override it when using proxy
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Override Host header when accessing through socat proxy
    const config = VAULT_CONFIG[this.instance];
    if (config.needsHostOverride) {
      headers["Host"] = config.tauriDriverHostHeader;
    }

    return headers;
  }

  /**
   * Call a Tauri command via WebDriver execute
   * Uses http module for cross-container requests where Host header override is needed
   */
  async invokeTauriCommand<T = unknown>(
    command: string,
    args: object = {}
  ): Promise<T> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    // Tauri v2 uses __TAURI_INTERNALS__ for the invoke function
    // WebDriver execute/async expects the script to call a callback (last argument)
    const script = `
      const callback = arguments[arguments.length - 1];
      const { invoke } = window.__TAURI_INTERNALS__;
      invoke('${command}', ${JSON.stringify(args)})
        .then(result => callback({ success: true, data: result }))
        .catch(error => callback({ success: false, error: error.message || String(error) }));
    `;

    const config = VAULT_CONFIG[this.instance];
    const body = JSON.stringify({ script, args: [] });
    let data: Record<string, unknown>;

    // Use http module when Host header override is needed
    if (config.needsHostOverride) {
      data = await this.httpRequest("POST", `/session/${this.sessionId}/execute/async`, body);
    } else {
      const response = await fetch(
        `${this.tauriDriverUrl}/session/${this.sessionId}/execute/async`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[E2E] Tauri command '${command}' on Vault ${this.instance} failed:`, errorText);
        throw new Error(`Failed to execute Tauri command '${command}': ${response.status} - ${errorText}`);
      }

      data = await response.json();
    }

    const result = data.value;

    // Handle our wrapper format from async script
    if (result && typeof result === "object" && "success" in result) {
      const typedResult = result as { success: boolean; data?: unknown; error?: unknown };
      if (!typedResult.success) {
        // Log the raw error for debugging
        console.error(`[E2E] Tauri command '${command}' error:`, typedResult.error);
        // Convert error to string, handling objects
        let errorMsg: string;
        try {
          errorMsg = typeof typedResult.error === "object"
            ? JSON.stringify(typedResult.error, null, 2)
            : String(typedResult.error);
        } catch {
          errorMsg = String(typedResult.error);
        }
        throw new Error(`Tauri command '${command}' failed: ${errorMsg}`);
      }
      return typedResult.data as T;
    }

    return result as T;
  }

  /**
   * Get pending authorization requests
   */
  async getPendingAuthorizations(): Promise<PendingAuthorization[]> {
    return this.invokeTauriCommand<PendingAuthorization[]>(
      TAURI_COMMANDS.externalBridge.getPendingAuthorizations
    );
  }

  /**
   * Allow a client authorization (approve)
   */
  async approveClient(
    clientId: string,
    clientName: string,
    publicKey: string,
    extensionId: string
  ): Promise<void> {
    console.log("[E2E] Calling external_bridge_client_allow with:", {
      clientId,
      clientName,
      publicKey: publicKey.substring(0, 50) + "...",
      extensionId,
      remember: true,
    });
    try {
      const result = await this.invokeTauriCommand(TAURI_COMMANDS.externalBridge.clientAllow, {
        clientId,
        clientName,
        publicKey,
        extensionId,
        remember: true, // Store permanently in database
      });
      console.log("[E2E] external_bridge_client_allow result:", result);

      // Verify the client was actually saved to the database
      const authorizedClients = await this.invokeTauriCommand<Array<{clientId: string}>>(
        TAURI_COMMANDS.externalBridge.getAuthorizedClients
      );
      const saved = authorizedClients.some(c => c.clientId === clientId);
      console.log("[E2E] Client saved to database:", saved, "Total authorized clients:", authorizedClients.length);
      if (!saved) {
        console.error("[E2E] WARNING: Client was not saved to database!");
      }
    } catch (error) {
      console.error("[E2E] external_bridge_client_allow FAILED:", error);
      throw error;
    }
  }

  /**
   * Block a client authorization (deny)
   */
  async denyClient(clientId: string): Promise<void> {
    await this.invokeTauriCommand(TAURI_COMMANDS.externalBridge.clientBlock, {
      clientId,
      remember: false, // Only block for this session
    });
  }

  // ==========================================
  // Sync-related Tauri commands
  // ==========================================

  /**
   * Get dirty tables that need to be synced
   */
  async getDirtyTables(): Promise<Array<{ tableName: string; lastModified: string }>> {
    return this.invokeTauriCommand<Array<{ tableName: string; lastModified: string }>>("get_dirty_tables");
  }

  /**
   * Trigger a sync push to the server
   */
  async triggerSyncPush(): Promise<void> {
    await this.invokeTauriCommand("trigger_sync_push");
  }

  /**
   * Trigger a sync pull from the server
   */
  async triggerSyncPull(): Promise<void> {
    await this.invokeTauriCommand("trigger_sync_pull");
  }

  /**
   * Get the current sync state
   */
  async getSyncState(): Promise<{
    isConnected: boolean;
    lastSyncAt: string | null;
    pendingChanges: number;
  }> {
    return this.invokeTauriCommand("get_sync_state");
  }

  /**
   * Find element by CSS selector
   */
  async findElement(selector: string): Promise<string | null> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    const response = await fetch(
      `${this.tauriDriverUrl}/session/${this.sessionId}/element`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          using: "css selector",
          value: selector,
        }),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.value?.ELEMENT || data.value?.["element-6066-11e4-a52e-4f735466cecf"] || null;
  }

  /**
   * Click an element
   */
  async clickElement(elementId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    await fetch(
      `${this.tauriDriverUrl}/session/${this.sessionId}/element/${elementId}/click`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({}),
      }
    );
  }

  /**
   * Actually delete the WebDriver session (for cleanup)
   */
  async terminateSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      await fetch(`${this.tauriDriverUrl}/session/${this.sessionId}`, {
        method: "DELETE",
        headers: this.buildHeaders(),
      });
      console.log(`[E2E] Terminated WebDriver session for Vault ${this.instance}`);
    } catch (error) {
      console.error(`[E2E] Failed to terminate session:`, error);
    }

    this.sessionId = null;
  }

  /**
   * Release the WebDriver session reference (does NOT delete the session)
   * The session is kept alive for other tests to reuse
   */
  async deleteSession(): Promise<void> {
    // Don't actually delete the session - it's shared across all tests
    // Just clear our reference
    this.sessionId = null;
    console.log("[E2E] WebDriver session reference released (session kept alive)");
  }

  // ==========================================
  // Sync Backend Configuration
  // ==========================================

  /**
   * Execute arbitrary JavaScript in the frontend context
   * This allows us to interact with Vue/Nuxt/Pinia stores
   */
  async executeScript<T = unknown>(script: string): Promise<T> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    // Wrap script to handle async and return value via callback
    const wrappedScript = `
      const callback = arguments[arguments.length - 1];
      (async () => {
        try {
          const result = await (async () => { ${script} })();
          callback({ success: true, data: result });
        } catch (error) {
          callback({ success: false, error: error.message || String(error) });
        }
      })();
    `;

    const config = VAULT_CONFIG[this.instance];
    const body = JSON.stringify({ script: wrappedScript, args: [] });
    let data: Record<string, unknown>;

    if (config.needsHostOverride) {
      data = await this.httpRequest("POST", `/session/${this.sessionId}/execute/async`, body);
    } else {
      const response = await fetch(
        `${this.tauriDriverUrl}/session/${this.sessionId}/execute/async`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to execute script: ${response.status} - ${errorText}`);
      }

      data = await response.json();
    }

    const result = data.value;

    if (result && typeof result === "object" && "success" in result) {
      const typedResult = result as { success: boolean; data?: unknown; error?: unknown };
      if (!typedResult.success) {
        throw new Error(`Script execution failed: ${typedResult.error}`);
      }
      return typedResult.data as T;
    }

    return result as T;
  }

  /**
   * Configure a sync backend in the vault by inserting directly into the database
   * This bypasses the frontend UI and uses sql_execute_with_crdt
   */
  async configureSyncBackend(config: {
    serverUrl: string;
    email: string;
    password: string;
    vaultId: string;
    name?: string;
    enabled?: boolean;
  }): Promise<string> {
    const backendId = crypto.randomUUID();
    const name = config.name || new URL(config.serverUrl).hostname;
    const enabled = config.enabled ?? true;
    const now = new Date().toISOString();

    // Insert sync backend directly into haex_sync_backends table
    const sql = `
      INSERT INTO haex_sync_backends (
        id, name, server_url, vault_id, email, password,
        enabled, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `;

    const params = [
      backendId,
      name,
      config.serverUrl,
      config.vaultId,
      config.email,
      config.password,
      enabled ? 1 : 0,
      now,
      now,
    ];

    console.log(`[E2E] Configuring sync backend on Vault ${this.instance}:`, {
      backendId,
      name,
      serverUrl: config.serverUrl,
      vaultId: config.vaultId,
      email: config.email,
    });

    await this.invokeTauriCommand("sql_execute_with_crdt", {
      sql,
      params,
    });

    console.log(`[E2E] Sync backend configured successfully: ${backendId}`);
    return backendId;
  }

  /**
   * Get all sync backends from the database
   */
  async getSyncBackends(): Promise<Array<{
    id: string;
    name: string;
    serverUrl: string;
    vaultId: string;
    email: string;
    enabled: boolean;
  }>> {
    const sql = `
      SELECT id, name, server_url, vault_id, email, enabled
      FROM haex_sync_backends
      WHERE haex_tombstone = 0
    `;

    const result = await this.invokeTauriCommand<Array<Record<string, unknown>>>(
      "sql_select_with_crdt",
      { sql, params: [] }
    );

    return result.map(row => ({
      id: row.id as string,
      name: row.name as string,
      serverUrl: row.server_url as string,
      vaultId: row.vault_id as string,
      email: row.email as string,
      enabled: row.enabled === 1,
    }));
  }

  /**
   * Complete the welcome dialog that appears when a new vault is created.
   * The dialog has 3 steps: Device Name, Extensions, Sync.
   * Uses data-testid attributes for reliable element selection.
   */
  async completeWelcomeDialog(options: {
    deviceName: string;
    skipExtensions?: boolean;
    skipSync?: boolean;
  }): Promise<void> {
    console.log(`[E2E] Completing welcome dialog on Vault ${this.instance}`);

    // Wait for welcome dialog to appear
    await this.wait(2000);

    const maxIterations = 15;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Check which step we're on by looking for data-testid elements
      const stepInfo = await this.executeScript<{ step: string | null; hasDialog: boolean }>(`
        const deviceInput = document.querySelector('[data-testid="welcome-device-name-input"]');
        const skipExtBtn = document.querySelector('[data-testid="welcome-skip-extensions-button"]');
        const skipSyncBtn = document.querySelector('[data-testid="welcome-skip-sync-button"]');
        const nextBtn = document.querySelector('[data-testid="welcome-next-button"]');

        if (deviceInput) return { step: 'device', hasDialog: true };
        if (skipExtBtn) return { step: 'extensions', hasDialog: true };
        if (skipSyncBtn) return { step: 'sync', hasDialog: true };
        if (nextBtn) return { step: 'unknown', hasDialog: true };
        return { step: null, hasDialog: false };
      `);

      if (!stepInfo?.hasDialog) {
        console.log(`[E2E] Welcome dialog completed (iteration ${iteration})`);
        return;
      }

      // Step 0: Device Name
      if (stepInfo.step === "device") {
        console.log(`[E2E] Welcome dialog: Setting device name`);
        await this.executeScript(`
          const input = document.querySelector('[data-testid="welcome-device-name-input"] input') ||
                       document.querySelector('[data-testid="welcome-device-name-input"]');
          if (input) {
            input.value = ${JSON.stringify(options.deviceName)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        `);
        await this.wait(500);
        // Click Next
        await this.executeScript(`
          const nextBtn = document.querySelector('[data-testid="welcome-next-button"]');
          if (nextBtn) nextBtn.click();
        `);
        await this.wait(1500);
        continue;
      }

      // Step 1: Extensions
      if (stepInfo.step === "extensions") {
        if (options.skipExtensions) {
          console.log(`[E2E] Welcome dialog: Skipping extensions`);
          await this.executeScript(`
            const skipBtn = document.querySelector('[data-testid="welcome-skip-extensions-button"]');
            if (skipBtn) skipBtn.click();
          `);
        } else {
          console.log(`[E2E] Welcome dialog: Continuing past extensions`);
          await this.executeScript(`
            const nextBtn = document.querySelector('[data-testid="welcome-next-button"]');
            if (nextBtn) nextBtn.click();
          `);
        }
        await this.wait(1500);
        continue;
      }

      // Step 2: Sync
      if (stepInfo.step === "sync") {
        if (options.skipSync) {
          console.log(`[E2E] Welcome dialog: Skipping sync setup`);
          await this.executeScript(`
            const skipBtn = document.querySelector('[data-testid="welcome-skip-sync-button"]');
            if (skipBtn) skipBtn.click();
          `);
        } else {
          console.log(`[E2E] Welcome dialog: Clicking Finish`);
          await this.executeScript(`
            const nextBtn = document.querySelector('[data-testid="welcome-next-button"]');
            if (nextBtn) nextBtn.click();
          `);
        }
        await this.wait(2000);
        continue;
      }

      // If we get here, wait a bit and check again
      await this.wait(1000);
    }

    console.log(`[E2E] Warning: Welcome dialog may not have completed properly`);
  }

  /**
   * Create a sync connection via the Settings UI
   * This uses the real UI flow: Settings → Sync → Add Backend
   */
  async createSyncConnection(credentials: {
    serverUrl: string;
    email: string;
    password: string;
  }): Promise<string | null> {
    console.log(`[E2E] Creating sync connection via UI on Vault ${this.instance}`);

    // Step 1: Navigate to Settings → Sync
    await this.navigateTo("/settings/sync");
    await this.wait(500); // Wait for page load

    // Step 2: Click the "Add Backend" button using data-testid
    let addBackendButton: string | null = null;
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries && !addBackendButton; attempt++) {
      console.log(`[E2E] Looking for Add Backend button (attempt ${attempt}/${maxRetries})`);
      addBackendButton = await this.findElement('[data-testid="sync-add-backend-button"]');

      if (!addBackendButton && attempt < maxRetries) {
        await this.wait(1000);
      }
    }

    if (!addBackendButton) {
      throw new Error("Add Backend button not found");
    }
    await this.clickElement(addBackendButton);
    await this.wait(300); // Wait for form to appear

    // Step 3: Fill in the form fields using executeScript
    // This is more reliable than WebDriver value setting for Vue components
    await this.executeScript(`
      const serverUrl = ${JSON.stringify(credentials.serverUrl)};
      const email = ${JSON.stringify(credentials.email)};
      const password = ${JSON.stringify(credentials.password)};

      // Find and fill server URL input or select custom option
      const serverInputs = document.querySelectorAll('input[placeholder*="Server"], input[type="url"]');
      if (serverInputs.length > 0) {
        const serverInput = serverInputs[0];
        serverInput.value = serverUrl;
        serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // Try to find a select/dropdown for server
        const select = document.querySelector('[role="combobox"], select');
        if (select) {
          // Click to open, then look for custom option
          select.click();
        }
      }

      // Find and fill email input
      const emailInput = document.querySelector('input[type="email"]');
      if (emailInput) {
        emailInput.value = email;
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Find and fill password input
      const passwordInput = document.querySelector('input[type="password"]');
      if (passwordInput) {
        passwordInput.value = password;
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);

    await this.wait(200);

    // Step 4: Click the submit button using data-testid
    await this.executeScript(`
      const submitBtn = document.querySelector('[data-testid="sync-submit-button"]');
      if (submitBtn) {
        submitBtn.click();
      } else {
        throw new Error('Submit button not found');
      }
    `);

    // Step 5: Wait for the connection to be established (max 30 seconds)
    const maxWaitTime = 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      await this.wait(500);

      // Check if loading overlay is gone and form is closed
      const isStillLoading = await this.executeScript<boolean>(`
        const loader = document.querySelector('.loading-spinner, [class*="loading"][class*="spinner"]');
        const emailInput = document.querySelector('input[type="email"]');
        // Form should close on success
        return !!(loader || emailInput);
      `);

      if (!isStillLoading) {
        break;
      }
    }

    // Step 6: Check for success by looking for the backend in database
    await this.wait(500);

    const backends = await this.getSyncBackends();
    const newBackend = backends.find(
      (b) => b.serverUrl === credentials.serverUrl && b.email === credentials.email
    );

    if (newBackend) {
      console.log(`[E2E] Sync connection created successfully: ${newBackend.id}`);
      return newBackend.id;
    }

    // Check if form is still visible (error case)
    const formVisible = await this.findElement('input[type="email"]');
    if (formVisible) {
      console.error(`[E2E] Sync connection setup failed - form still visible`);
      throw new Error("Sync connection failed - form still visible after timeout");
    }

    console.log(`[E2E] Sync connection may have been created but couldn't verify`);
    return null;
  }

  /**
   * Helper to wait for a specified time
   */
  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Navigate to a specific route in the app
   * Uses Vue Router navigation via JavaScript execution
   */
  async navigateTo(path: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    // Use Vue Router for navigation - this is more reliable than WebDriver URL navigation
    // for Tauri apps which use a custom URL scheme
    const script = `
      // Try to use Vue Router if available
      const router = window.__NUXT__?.vueApp?.config?.globalProperties?.$router
        || window.$nuxt?.$router
        || window.__VUE_APP__?.config?.globalProperties?.$router;

      if (router) {
        router.push('${path}');
        return { success: true, method: 'router' };
      }

      // Fallback: use window.location for relative paths
      const basePath = window.location.origin;
      const fullPath = '${path}'.startsWith('/') ? '${path}' : '/' + '${path}';
      window.location.href = basePath + fullPath;
      return { success: true, method: 'location' };
    `;

    await this.executeScript(script);

    // Wait for navigation to complete
    await new Promise((r) => setTimeout(r, 1000));
  }

  /**
   * Get the current page source (HTML)
   * Useful for checking if elements are present
   */
  async getPageSource(): Promise<string> {
    if (!this.sessionId) {
      throw new Error("No WebDriver session");
    }

    const config = VAULT_CONFIG[this.instance];

    if (config.needsHostOverride) {
      const data = await this.httpRequest("GET", `/session/${this.sessionId}/source`, undefined);
      return (data.value as string) || "";
    } else {
      const response = await fetch(
        `${this.tauriDriverUrl}/session/${this.sessionId}/source`,
        {
          method: "GET",
          headers: this.buildHeaders(),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get page source: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return data.value || "";
    }
  }

  /**
   * Get the current vault ID from the vault store
   */
  async getCurrentVaultId(): Promise<string | null> {
    const script = `
      const { useVaultStore } = await import('/src/stores/vault');
      const vaultStore = useVaultStore();
      return vaultStore.currentVaultId;
    `;

    try {
      return await this.executeScript<string | null>(script);
    } catch {
      // Fallback: Get vault ID from sql query
      const result = await this.invokeTauriCommand<Array<Record<string, unknown>>>(
        "sql_select",
        {
          sql: "SELECT value FROM haex_crdt_configs WHERE key = 'vault_id'",
          params: [],
        }
      );

      if (result && result.length > 0) {
        return result[0].value as string;
      }

      return null;
    }
  }
}

/**
 * Extended test fixtures with browser extension and vault bridge support
 */
export const test = base.extend<TestFixtures>({
  context: async ({}, use) => {
    // Launch browser with extension loaded
    const context = await chromium.launchPersistentContext("", {
      headless: false, // Extensions require headed mode
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // Get extension ID from service worker
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent("serviceworker");
    }
    const extensionId = background.url().split("/")[2];
    await use(extensionId);
  },

  vaultClient: async ({}, use) => {
    const client = new VaultBridgeClient();
    await use(client);
    client.disconnect();
  },

  vaultPage: async ({}, use) => {
    // This fixture would be used for Playwright-based vault automation
    // For now, we use VaultAutomation with tauri-driver instead
    await use(null as unknown as Page);
  },
});

export { expect } from "@playwright/test";

// Re-export haex-pass API constants for tests
export { HAEX_PASS_METHODS } from "./haex-pass-api";

/**
 * Helper to wait for WebSocket connection to bridge
 */
export async function waitForBridgeConnection(
  client: VaultBridgeClient,
  timeout = 10000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await client.connect();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

/**
 * Options for sendRequestWithRetry
 */
interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay between retries in ms (default: 2000) */
  initialDelay?: number;
  /** Delay multiplier for exponential backoff (default: 1.5) */
  backoffMultiplier?: number;
  /** Request timeout in ms (default: 30000, increased to handle CI variability) */
  requestTimeout?: number;
  /** Initial wait before first request in ms (default: 0) */
  initialWait?: number;
}

/**
 * Helper to send request with retry logic and exponential backoff.
 * Useful for requests that may fail due to extension initialization timing.
 */
export async function sendRequestWithRetry<T = unknown>(
  client: VaultBridgeClient,
  action: string,
  payload: object,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 2000,
    backoffMultiplier = 1.5,
    requestTimeout = 30000, // Increased to handle GitHub Actions runner variability
    initialWait = 0,
  } = options;

  // Wait before first request if specified
  if (initialWait > 0) {
    console.log(`[E2E] Waiting ${initialWait}ms before first request...`);
    await new Promise((resolve) => setTimeout(resolve, initialWait));
  }

  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.sendRequest<T>(action, payload, requestTimeout);
      return response;
    } catch (err) {
      lastError = err as Error;
      console.log(`[E2E] Request attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);

      if (attempt < maxAttempts) {
        console.log(`[E2E] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.round(delay * backoffMultiplier);
      }
    }
  }

  throw lastError || new Error(`Request failed after ${maxAttempts} attempts`);
}

/**
 * Helper to wait for extension to be ready.
 *
 * When a VaultAutomation instance is provided, this uses the real
 * useExtensionReadyStore().waitForReady() from haex-vault via executeScript.
 * This is the preferred method as it uses the actual haex-vault functionality.
 *
 * When only a VaultBridgeClient is provided (legacy), it falls back to
 * polling via sendRequestWithRetry.
 */
export async function waitForExtensionReady(
  client: VaultBridgeClient,
  options: {
    testAction?: string;
    testPayload?: object;
    vault?: VaultAutomation;
    extensionId?: string;
    timeout?: number;
  } = {}
): Promise<boolean> {
  const {
    testAction = HAEX_PASS_METHODS.GET_ITEMS,
    testPayload = { url: "https://example.com" },
    vault,
    extensionId = "haex-pass",
    timeout = 30000,
  } = options;

  console.log("[E2E] Waiting for extension to be ready...");

  // Preferred method: Use haex-vault's useExtensionReadyStore().waitForReady()
  if (vault) {
    try {
      const isReady = await vault.executeScript<boolean>(`
        // Access the Pinia store for extension ready state
        const pinia = window.__NUXT__?.vueApp?.$pinia
          || window.__NUXT__?._context?.provides?.pinia
          || window.$pinia;

        if (!pinia) {
          throw new Error('Pinia not available');
        }

        const extensionReadyStore = pinia._s.get('extensionReady');
        if (!extensionReadyStore) {
          throw new Error('extensionReady store not found');
        }

        // Wait for the extension to signal ready (with timeout)
        const result = await extensionReadyStore.waitForReady(
          ${JSON.stringify(extensionId)},
          ${timeout}
        );

        return result;
      `);

      if (isReady) {
        console.log("[E2E] Extension is ready (via useExtensionReadyStore)!");
        return true;
      } else {
        console.error("[E2E] Extension ready check returned false");
        return false;
      }
    } catch (err) {
      console.error("[E2E] Extension ready check failed:", err);
      // Fall through to legacy method
    }
  }

  // Legacy fallback: Polling via sendRequestWithRetry
  console.log("[E2E] Using legacy polling method for extension ready...");
  try {
    // Use 30s per request (not timeout/5) to handle slow CI environments
    // where responses can take 15-20+ seconds due to resource constraints
    await sendRequestWithRetry(client, testAction, testPayload, {
      maxAttempts: 5,
      initialDelay: 2000,
      backoffMultiplier: 1.5,
      requestTimeout: 30000,
      initialWait: 3000, // Give extension time to auto-start
    });
    console.log("[E2E] Extension is ready!");
    return true;
  } catch (err) {
    console.error("[E2E] Extension failed to become ready:", err);
    return false;
  }
}

/**
 * Helper to complete the authorization flow
 * Note: The extensionId parameter is the Chrome extension ID (for Playwright).
 * For vault authorization, we use the haex-vault extension ID from global-setup.
 *
 * IMPORTANT: This function waits for the extension to be registered in the database
 * before attempting authorization. This prevents FOREIGN KEY constraint failures
 * when the authorization is persisted (remember=true).
 */
export async function authorizeClient(
  client: VaultBridgeClient,
  _extensionId: string, // Chrome extension ID - not used for vault auth
  timeout = 30000
): Promise<boolean> {
  // Get the haex-vault extension ID (different from Chrome extension ID!)
  const vaultExtensionId = getHaexVaultExtensionId();
  console.log("[E2E] Using haex-vault extension ID for authorization:", vaultExtensionId);

  // Create vault automation
  const vault = new VaultAutomation();

  try {
    // Create WebDriver session - the vault should already be running from global setup
    await vault.createSession();

    // CRITICAL: Wait for the extension to exist in database before authorizing
    // This prevents FOREIGN KEY constraint failures when persisting authorization
    console.log("[E2E] Waiting for extension to be registered in database...");
    const extensionReady = await waitForExtensionInDatabase(vault, vaultExtensionId, timeout);
    if (!extensionReady) {
      console.error("[E2E] Extension not found in database after timeout");
      return false;
    }
    console.log("[E2E] Extension found in database, proceeding with authorization");

    // Wait for the client to be in pending_approval state
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const state = client.getState();
      if (state.state === "pending_approval") {
        break;
      }
      if (state.state === "paired") {
        return true; // Already authorized
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Get pending authorizations via Tauri command
    const pending = await vault.getPendingAuthorizations();
    const clientId = client.getClientId();
    const publicKey = client.getPublicKeyBase64();

    const pendingAuth = pending.find((p) => p.clientId === clientId);
    if (pendingAuth) {
      // Approve the authorization using haex-vault extension ID
      await vault.approveClient(
        pendingAuth.clientId,
        pendingAuth.clientName,
        pendingAuth.publicKey,
        vaultExtensionId
      );

      // Wait for authorization update
      return await client.waitForAuthorization(timeout);
    }

    // If no pending auth found, try to approve with the client's info
    if (clientId && publicKey) {
      await vault.approveClient(clientId, CLIENT_NAME, publicKey, vaultExtensionId);
      return await client.waitForAuthorization(timeout);
    }

    return false;
  } finally {
    await vault.deleteSession();
  }
}

/**
 * Wait for an extension to be registered in the haex_extensions database table.
 * This is required before authorization can be persisted (due to FOREIGN KEY constraint).
 */
async function waitForExtensionInDatabase(
  vault: VaultAutomation,
  extensionId: string,
  timeout: number
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      // Query the extensions table to check if extension exists
      const extensions = await vault.invokeTauriCommand<Array<{ id: string; name: string }>>(
        "get_all_extensions"
      );

      const found = extensions.some((ext) => ext.id === extensionId || ext.name === extensionId);
      if (found) {
        return true;
      }
    } catch (error) {
      console.log("[E2E] Error checking extension in database:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * Helper to send request via browser extension's service worker
 */
export async function sendExtensionRequest(
  context: BrowserContext,
  extensionId: string,
  action: string,
  payload: object
): Promise<unknown> {
  // Find extension service worker
  const backgroundPage = context
    .serviceWorkers()
    .find((sw: Worker) => sw.url().includes(extensionId));

  if (!backgroundPage) {
    throw new Error("Extension background page not found");
  }

  // Execute request via extension's connection manager
  return backgroundPage.evaluate(
    async (args: { action: string; payload: object }) => {
      // Access the vaultConnection from the extension global scope
      const vaultConnection = (
        globalThis as unknown as {
          vaultConnection: {
            sendRequest: (action: string, payload: object) => Promise<unknown>;
          };
        }
      ).vaultConnection;

      if (!vaultConnection) {
        throw new Error("vaultConnection not available in extension");
      }

      return vaultConnection.sendRequest(args.action, args.payload);
    },
    { action, payload }
  );
}

// ==========================================
// Sync Test Helpers
// ==========================================

/**
 * Wait for the sync server to be ready
 */
export async function waitForSyncServer(
  timeout = 30000
): Promise<boolean> {
  const client = new SyncServerClient();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const health = await client.healthCheck();
      if (health.status === "ok") {
        console.log(`[E2E] Sync server ready: ${health.name} v${health.version}`);
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error("[E2E] Sync server not available");
  return false;
}

/**
 * Generate a unique vault ID for test isolation
 */
export function generateTestVaultId(): string {
  return `test-vault-${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Generate an HLC timestamp for testing
 * Format: ISO timestamp + counter + node ID
 */
export function generateHlcTimestamp(
  nodeId: string = "test-node",
  counter: number = 0
): string {
  const timestamp = new Date().toISOString();
  return `${timestamp}:${counter.toString().padStart(8, "0")}:${nodeId}`;
}

/**
 * Create a test sync change
 */
export function createTestSyncChange(options: {
  tableName: string;
  rowPks: Record<string, string>;
  columnName: string;
  value: string;
  deviceId?: string;
}): {
  tableName: string;
  rowPks: string;
  columnName: string;
  hlcTimestamp: string;
  deviceId: string;
  encryptedValue: string;
  nonce: string;
} {
  const deviceId = options.deviceId || `test-device-${crypto.randomBytes(4).toString("hex")}`;

  return {
    tableName: options.tableName,
    rowPks: JSON.stringify(options.rowPks),
    columnName: options.columnName,
    hlcTimestamp: generateHlcTimestamp(deviceId),
    deviceId,
    // In real tests, these would be encrypted - using base64 for testing
    encryptedValue: Buffer.from(options.value).toString("base64"),
    nonce: crypto.randomBytes(12).toString("base64"),
  };
}

/**
 * Wait for a specific condition with polling
 */
export async function waitFor<T>(
  condition: () => Promise<T | null | undefined>,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<T> {
  const { timeout = 10000, interval = 100, message = "Condition not met" } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = await condition();
    if (result !== null && result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`);
}
