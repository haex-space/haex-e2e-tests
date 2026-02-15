/**
 * haex-pass API Constants
 *
 * These constants mirror the HAEX_PASS_METHODS from @haextension/haex-pass/api/external
 * Keep in sync with: /repos/haextension/apps/haex-pass/app/api/external.ts
 */

/**
 * Available methods for haex-pass External Requests
 */
export const HAEX_PASS_METHODS = {
  /** Get items (logins) for a URL and optional field names */
  GET_ITEMS: "get-items",
  /** Get TOTP code for an entry */
  GET_TOTP: "get-totp",
  /** Create new item */
  CREATE_ITEM: "create-item",
  /** Update existing item */
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

export type HaexPassMethod = (typeof HAEX_PASS_METHODS)[keyof typeof HAEX_PASS_METHODS];
