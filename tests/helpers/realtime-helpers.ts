// tests/helpers/realtime-helpers.ts
//
// Shared helpers for WebSocket-based Realtime E2E tests.
// The sync-server uses a plain WebSocket endpoint at /ws with DID-Auth token authentication.
// There is no subscribe/unsubscribe protocol — the server loads space memberships at connect
// time and broadcasts to all connected members automatically.

import WebSocket from "ws";
import { createDidAuthHeader, getSyncServerUrl } from "./sync-server-helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

/**
 * A message received from the sync-server WebSocket.
 *
 * Known event types:
 * - `{ type: 'sync', spaceId }` — new changes were pushed to a space
 * - `{ type: 'membership', spaceId }` — space membership changed
 * - `{ type: 'mls', spaceId }` — MLS message available
 */
export interface WsMessage {
  type: string;
  spaceId?: string;
  [key: string]: unknown;
}

/**
 * WebSocket test client that connects to the sync-server's /ws endpoint
 * using DID-Auth for authentication.
 *
 * The server loads space memberships when the connection opens and broadcasts
 * events to all connected members. There is no subscribe/unsubscribe protocol.
 */
export class RealtimeTestClient {
  private ws: WebSocket | null = null;
  private messages: WsMessage[] = [];
  private messageListeners: Array<(msg: WsMessage) => void> = [];
  private closeCode: number | null = null;
  private closeReason: string | null = null;

  constructor(
    private privateKeyBase64: string,
    private did: string,
    private serverUrl: string = SYNC_SERVER_URL,
  ) {}

  /**
   * Connect to the WebSocket endpoint with DID-Auth.
   * Resolves when the connection is open, rejects on error or auth failure (code 4001).
   */
  async connect(): Promise<void> {
    const authHeader = await createDidAuthHeader(
      this.privateKeyBase64,
      this.did,
      "ws-connect",
    );
    // Strip "DID " prefix — the WS token is just payload.signature
    const token = authHeader.slice(4);
    const wsUrl =
      this.serverUrl.replace(/^http/, "ws") +
      `/ws?token=${encodeURIComponent(token)}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => resolve());

      this.ws.on("error", (err) => reject(err));

      this.ws.on("close", (code, reason) => {
        this.closeCode = code;
        this.closeReason = reason.toString();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsMessage;
          this.messages.push(msg);
          for (const fn of this.messageListeners) {
            fn(msg);
          }
        } catch {
          // Ignore non-JSON messages
        }
      });
    });
  }

  /**
   * Connect and expect auth failure (close code 4001).
   * Returns true if auth was rejected, false if connection succeeded.
   */
  async connectExpectingFailure(timeoutMs = 5000): Promise<boolean> {
    const authHeader = await createDidAuthHeader(
      this.privateKeyBase64,
      this.did,
      "ws-connect",
    );
    const token = authHeader.slice(4);
    const wsUrl =
      this.serverUrl.replace(/^http/, "ws") +
      `/ws?token=${encodeURIComponent(token)}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.close();
        resolve(false);
      }, timeoutMs);

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        // Connection opened — wait briefly to see if the server closes it
        // The server calls ws.close(4001) in onOpen when auth fails
        setTimeout(() => {
          if (this.closeCode === 4001) {
            clearTimeout(timer);
            resolve(true);
          } else {
            clearTimeout(timer);
            resolve(false);
          }
        }, 1000);
      });

      this.ws.on("close", (code) => {
        this.closeCode = code;
        clearTimeout(timer);
        resolve(code === 4001);
      });

      this.ws.on("error", () => {
        clearTimeout(timer);
        resolve(true); // Connection error counts as rejection
      });
    });
  }

  /**
   * Connect with a raw token string (for testing invalid tokens).
   * Returns true if connection was rejected, false if it stayed open.
   */
  async connectWithRawToken(
    token: string,
    timeoutMs = 5000,
  ): Promise<{ rejected: boolean; closeCode: number | null }> {
    const wsUrl =
      this.serverUrl.replace(/^http/, "ws") +
      `/ws?token=${encodeURIComponent(token)}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.close();
        resolve({ rejected: false, closeCode: this.closeCode });
      }, timeoutMs);

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        // Wait to see if server closes it
        setTimeout(() => {
          if (this.closeCode != null) {
            clearTimeout(timer);
            resolve({ rejected: true, closeCode: this.closeCode });
          } else {
            clearTimeout(timer);
            resolve({ rejected: false, closeCode: null });
          }
        }, 1000);
      });

      this.ws.on("close", (code) => {
        this.closeCode = code;
        clearTimeout(timer);
        resolve({ rejected: true, closeCode: code });
      });

      this.ws.on("error", () => {
        clearTimeout(timer);
        resolve({ rejected: true, closeCode: this.closeCode });
      });
    });
  }

  /**
   * Connect without any token (for testing unauthenticated access).
   */
  async connectWithoutToken(
    timeoutMs = 5000,
  ): Promise<{ rejected: boolean; closeCode: number | null }> {
    const wsUrl = this.serverUrl.replace(/^http/, "ws") + `/ws`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.close();
        resolve({ rejected: false, closeCode: this.closeCode });
      }, timeoutMs);

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        setTimeout(() => {
          if (this.closeCode != null) {
            clearTimeout(timer);
            resolve({ rejected: true, closeCode: this.closeCode });
          } else {
            clearTimeout(timer);
            resolve({ rejected: false, closeCode: null });
          }
        }, 1000);
      });

      this.ws.on("close", (code) => {
        this.closeCode = code;
        clearTimeout(timer);
        resolve({ rejected: true, closeCode: code });
      });

      this.ws.on("error", () => {
        clearTimeout(timer);
        resolve({ rejected: true, closeCode: this.closeCode });
      });
    });
  }

  /**
   * Wait for a message matching the predicate.
   * Checks already received messages first.
   */
  async waitForMessage(
    predicate: (msg: WsMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<WsMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timeout waiting for message (${timeoutMs}ms)`),
        );
      }, timeoutMs);

      const listener = (msg: WsMessage) => {
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const idx = this.messageListeners.indexOf(listener);
        if (idx >= 0) this.messageListeners.splice(idx, 1);
      };

      this.messageListeners.push(listener);
    });
  }

  /**
   * Wait for a sync broadcast for a specific space.
   */
  async waitForSyncBroadcast(
    spaceId: string,
    timeoutMs = 5000,
  ): Promise<WsMessage> {
    return this.waitForMessage(
      (msg) => msg.type === "sync" && msg.spaceId === spaceId,
      timeoutMs,
    );
  }

  /**
   * Wait for any broadcast for a specific space (sync or membership).
   */
  async waitForSpaceBroadcast(
    spaceId: string,
    timeoutMs = 5000,
  ): Promise<WsMessage> {
    return this.waitForMessage(
      (msg) => msg.spaceId === spaceId,
      timeoutMs,
    );
  }

  /**
   * Wait until at least `count` messages matching the predicate have been collected,
   * or times out.
   */
  async waitForMessageCount(
    predicate: (msg: WsMessage) => boolean,
    count: number,
    timeoutMs = 5000,
  ): Promise<WsMessage[]> {
    const start = Date.now();
    while (
      this.messages.filter(predicate).length < count &&
      Date.now() - start < timeoutMs
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.messages.filter(predicate);
  }

  /**
   * Get all collected messages.
   */
  getMessages(): WsMessage[] {
    return [...this.messages];
  }

  /**
   * Get messages for a specific space.
   */
  getSpaceMessages(spaceId: string): WsMessage[] {
    return this.messages.filter((m) => m.spaceId === spaceId);
  }

  /**
   * Clear collected messages.
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Disconnect the WebSocket.
   */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.messages = [];
    this.messageListeners = [];
  }

  /**
   * Whether the WebSocket is currently open.
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * The close code from the server (e.g. 4001 for auth failure).
   */
  get lastCloseCode(): number | null {
    return this.closeCode;
  }

  /**
   * The close reason from the server.
   */
  get lastCloseReason(): string | null {
    return this.closeReason;
  }
}
