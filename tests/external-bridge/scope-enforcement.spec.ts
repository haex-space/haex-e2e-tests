import * as crypto from "crypto";
import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  BRIDGE_METHODS,
} from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers/sql-helpers";

/**
 * Regression coverage for haex-vault PR #667 Finding 2 (P1, security): a
 * tag-scoped external client could use `get-totp`, `passkey-get`,
 * `passkey-list`, and `passkey-create` OUTSIDE its granted tag scope — only
 * `get-items`/`create-item`/`update-item` enforced the scope. Fixed on
 * branch `worktree-fix+external-bridge-scope-and-multiselect`
 * (haex-vault PR #674).
 *
 * Each test below reproduces the bug against the pre-fix vault build first
 * (red), then passes against the fix branch (green) — see the plan at
 * docs/plans/external-bridge-scope-and-multiselect.md.
 */

const RELYING_PARTY_ID = `scope-test-${Date.now()}.example.com`;

test.describe("external-bridge: scope-enforcement", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;

  let scopedClient: VaultBridgeClient;
  let unrestrictedClient: VaultBridgeClient;

  let inScopeEntry: string;
  let outScopeEntry: string;
  let inScopePasskeyCredentialId: string;
  let outScopePasskeyCredentialId: string;

  test.beforeAll(async () => {
    vault = new VaultAutomation();
    await vault.createSession();
    sql = createSqlHelpers(vault);

    // Unrestricted (all-scope) client sets up the fixture data — its own
    // access is unaffected by the fix and is the section 6 regression check.
    unrestrictedClient = new VaultBridgeClient();
    await waitForBridgeConnection(unrestrictedClient);
    await authorizeClient(unrestrictedClient, "unused");

    const inScopeResponse = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
    }>(unrestrictedClient, BRIDGE_METHODS.CREATE_ITEM, {
      url: `https://in-scope-${Date.now()}.example.com`,
      title: "Scope Test — in scope",
      username: "in-scope-user",
      password: "in-scope-pass",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(inScopeResponse.success).toBe(true);
    inScopeEntry = inScopeResponse.data.entryId;

    const outScopeResponse = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
    }>(unrestrictedClient, BRIDGE_METHODS.CREATE_ITEM, {
      url: `https://out-scope-${Date.now()}.example.com`,
      title: "Scope Test — out of scope",
      username: "out-scope-user",
      password: "out-scope-pass",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(outScopeResponse.success).toBe(true);
    outScopeEntry = outScopeResponse.data.entryId;

    // Tag `inScopeEntry` with "work"; `outScopeEntry` stays untagged.
    const tagId = crypto.randomUUID();
    await sql.insert("haex_passwords_tags", { id: tagId, name: "work" });
    await sql.insert("haex_passwords_item_tags", {
      id: crypto.randomUUID(),
      item_id: inScopeEntry,
      tag_id: tagId,
    });

    // A standalone (item-less) passkey outside every tag scope, inserted
    // directly — it must never be reachable by a scoped grant regardless of
    // relying-party or credential-id matches. Dummy key material is fine:
    // the scope check in passkey-get short-circuits before any crypto use.
    outScopePasskeyCredentialId = crypto
      .randomBytes(32)
      .toString("base64");
    await sql.insert("haex_passwords_passkeys", {
      id: crypto.randomUUID(),
      item_id: outScopeEntry,
      credential_id: outScopePasskeyCredentialId,
      relying_party_id: RELYING_PARTY_ID,
      user_handle: crypto.randomBytes(16).toString("base64"),
      user_name: "out-scope-passkey-user",
      private_key: "unused-dummy-private-key",
      public_key: "unused-dummy-public-key",
      algorithm: -7,
      sign_count: 0,
      is_discoverable: true,
    });

    // Tag-scoped client: only "work" is in scope.
    scopedClient = new VaultBridgeClient({
      passwordsPermissions: [{ target: "work", operation: "readWrite" }],
    });
    await waitForBridgeConnection(scopedClient);
    await authorizeClient(scopedClient, "unused");
  });

  test.afterAll(async () => {
    scopedClient?.disconnect();
    unrestrictedClient?.disconnect();
    await vault?.deleteSession();
  });

  // ---------------------------------------------------------------------
  // Finding 2: get-totp
  // ---------------------------------------------------------------------

  test("get-totp outside scope is denied", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
    }>(scopedClient, BRIDGE_METHODS.GET_TOTP, { entryId: outScopeEntry });

    expect(response.success).toBe(false);
    expect(response.error?.toLowerCase()).toMatch(/outside the granted tag scope/);
  });

  test("get-totp inside scope succeeds", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { code: string };
    }>(scopedClient, BRIDGE_METHODS.GET_TOTP, { entryId: inScopeEntry });

    expect(response.success).toBe(true);
    expect(response.data.code).toMatch(/^\d{6}$/);
  });

  // ---------------------------------------------------------------------
  // Finding 2: passkey-create (also produces the in-scope passkey used by
  // the passkey-get/passkey-list tests below)
  // ---------------------------------------------------------------------

  test("passkey-create with out-of-scope itemId is denied", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_CREATE, {
      relyingPartyId: RELYING_PARTY_ID,
      relyingPartyName: "Scope Test",
      userHandle: crypto.randomBytes(16).toString("base64"),
      userName: "denied-passkey-user",
      challenge: crypto.randomBytes(32).toString("base64"),
      itemId: outScopeEntry,
    });

    expect(response.success).toBe(false);
    expect(response.error?.toLowerCase()).toMatch(/outside the granted tag scope/);
  });

  test("passkey-create with in-scope itemId succeeds", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { credentialId: string };
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_CREATE, {
      relyingPartyId: RELYING_PARTY_ID,
      relyingPartyName: "Scope Test",
      userHandle: crypto.randomBytes(16).toString("base64"),
      userName: "allowed-passkey-user",
      challenge: crypto.randomBytes(32).toString("base64"),
      itemId: inScopeEntry,
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.credentialId).toBe("string");
    inScopePasskeyCredentialId = response.data.credentialId;
  });

  test("passkey-create without itemId (standalone) is denied for a scoped client", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_CREATE, {
      relyingPartyId: RELYING_PARTY_ID,
      relyingPartyName: "Scope Test",
      userHandle: crypto.randomBytes(16).toString("base64"),
      userName: "standalone-denied-user",
      challenge: crypto.randomBytes(32).toString("base64"),
    });

    expect(response.success).toBe(false);
    expect(response.error?.toLowerCase()).toMatch(/outside the granted tag scope/);
  });

  test("passkey-create without itemId (standalone) succeeds for an unrestricted client", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { credentialId: string };
    }>(unrestrictedClient, BRIDGE_METHODS.PASSKEY_CREATE, {
      relyingPartyId: RELYING_PARTY_ID,
      relyingPartyName: "Scope Test",
      userHandle: crypto.randomBytes(16).toString("base64"),
      userName: "standalone-allowed-user",
      challenge: crypto.randomBytes(32).toString("base64"),
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.credentialId).toBe("string");
  });

  // ---------------------------------------------------------------------
  // Finding 2: passkey-list
  // ---------------------------------------------------------------------

  test("passkey-list for a scoped client only returns in-scope passkeys", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { passkeys: Array<{ credentialId: string }> };
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_LIST, {
      relyingPartyId: RELYING_PARTY_ID,
    });

    expect(response.success).toBe(true);
    const credentialIds = response.data.passkeys.map((p) => p.credentialId);
    expect(credentialIds).toContain(inScopePasskeyCredentialId);
    expect(credentialIds).not.toContain(outScopePasskeyCredentialId);
  });

  test("passkey-list for an unrestricted client sees passkeys of both scopes", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { passkeys: Array<{ credentialId: string }> };
    }>(unrestrictedClient, BRIDGE_METHODS.PASSKEY_LIST, {
      relyingPartyId: RELYING_PARTY_ID,
    });

    expect(response.success).toBe(true);
    const credentialIds = response.data.passkeys.map((p) => p.credentialId);
    expect(credentialIds).toContain(inScopePasskeyCredentialId);
    expect(credentialIds).toContain(outScopePasskeyCredentialId);
  });

  // ---------------------------------------------------------------------
  // Finding 2: passkey-get
  // ---------------------------------------------------------------------

  test("passkey-get with an out-of-scope allowCredentials entry finds no match", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_GET, {
      relyingPartyId: RELYING_PARTY_ID,
      challenge: crypto.randomBytes(32).toString("base64"),
      allowCredentials: [
        { id: outScopePasskeyCredentialId, type: "public-key" },
      ],
    });

    expect(response.success).toBe(false);
    expect(response.error?.toLowerCase()).toMatch(/no matching passkey found/);
  });

  test("passkey-get with an in-scope allowCredentials entry succeeds", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { credentialId: string; signature: string };
    }>(scopedClient, BRIDGE_METHODS.PASSKEY_GET, {
      relyingPartyId: RELYING_PARTY_ID,
      challenge: crypto.randomBytes(32).toString("base64"),
      allowCredentials: [
        { id: inScopePasskeyCredentialId, type: "public-key" },
      ],
    });

    expect(response.success).toBe(true);
    expect(response.data.credentialId).toBe(inScopePasskeyCredentialId);
  });

  // ---------------------------------------------------------------------
  // Section 1.6: regression check — unrestricted ("all") scope unaffected
  // ---------------------------------------------------------------------

  test("an unrestricted client can still get-totp for both entries", async () => {
    const inScopeTotp = await sendRequestWithRetry<{ success: boolean }>(
      unrestrictedClient,
      BRIDGE_METHODS.GET_TOTP,
      { entryId: inScopeEntry },
    );
    const outScopeTotp = await sendRequestWithRetry<{ success: boolean }>(
      unrestrictedClient,
      BRIDGE_METHODS.GET_TOTP,
      { entryId: outScopeEntry },
    );

    expect(inScopeTotp.success).toBe(true);
    expect(outScopeTotp.success).toBe(true);
  });
});
