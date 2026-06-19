/**
 * external-bridge API Constants
 *
 * These method strings are the haex-vault *core* external API exposed over the
 * external WebSocket bridge and routed via the `__core__` sentinel (passwords
 * and passkeys are core features now, no longer a separate haex-pass app).
 * Keep in sync with the core handler map in haex-vault:
 * src/composables/handlers/useCoreExternalRequestHandlers.ts
 */

/**
 * Available methods for external-bridge requests
 */
export const BRIDGE_METHODS = {
  /** Get items (logins) for a URL and optional field names */
  GET_ITEMS: "get-items",
  /** Get TOTP code for an entry */
  GET_TOTP: "get-totp",
  /** Create a new item */
  CREATE_ITEM: "create-item",
  /** Update an existing item */
  UPDATE_ITEM: "update-item",
  /** Get password generator configuration */
  GET_PASSWORD_CONFIG: "get-password-config",
  /** Get all password generator presets */
  GET_PASSWORD_PRESETS: "get-password-presets",
  /** Create new passkey (WebAuthn Registration) */
  PASSKEY_CREATE: "passkey-create",
  /** Authenticate with passkey (WebAuthn Authentication) */
  PASSKEY_GET: "passkey-get",
  /** Get passkeys for a relying party */
  PASSKEY_LIST: "passkey-list",
} as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
