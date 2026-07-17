import * as crypto from "crypto";
import {
  test,
  expect,
  VaultBridgeClient,
  VaultAutomation,
  waitForBridgeConnection,
  sendRequestWithRetry,
  BRIDGE_METHODS,
} from "../fixtures";
import { createSqlHelpers, SqlHelpers } from "../helpers/sql-helpers";

/**
 * Regression coverage for haex-vault PR #667 Finding 1 (P1): granting
 * multiple targets (core + an extension) called `clientAllow` once per
 * target. The first call dropped the pending authorization, so later
 * targets got an empty manifest (no ExtensionApi rows; with remember=true,
 * `requested_permissions` was cleared, forcing re-authorization on the next
 * handshake). With remember=false, `session_authorizations` was keyed by
 * `client_id` alone, so each target overwrote the previous one.
 *
 * The fix grants every selected target in a single `clientAllow` call. Fixed
 * on branch `worktree-fix+external-bridge-scope-and-multiselect` (haex-vault
 * PR #674). See docs/plans/external-bridge-scope-and-multiselect.md.
 *
 * These tests drive `clientAllow({ extensionIds: [...] })` directly rather
 * than through the approval-dialog UI, and verify the multi-target grant at
 * the permission-row / session-state layer the bug actually broke — not a
 * live extension round-trip, which would need a real extension's own action
 * handler and isn't what this bug was about.
 */

const CORE_EXTENSION_ID = "__core__";

interface Extension {
  id: string;
  name: string;
  publicKey: string;
}

/** Waits for `client` to reach `pending_approval`, then grants `extensionIds`
 *  in one `clientAllow` call via `vault` — mirrors `authorizeClient` in
 *  fixtures.ts, but supports multiple targets and `remember=false`. */
async function authorizeMultiTarget(
  vault: VaultAutomation,
  client: VaultBridgeClient,
  extensionIds: string[],
  remember: boolean,
  timeout = 30000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = client.getState();
    if (state.state === "pending_approval") break;
    if (state.state === "paired") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const pending = await vault.getPendingAuthorizations();
  const clientId = client.getClientId();
  const pendingAuth = pending.find((p) => p.clientId === clientId);
  if (!pendingAuth) return false;

  await vault.approveClient(
    pendingAuth.clientId,
    pendingAuth.clientName,
    pendingAuth.publicKey,
    extensionIds,
    remember,
  );

  return client.waitForAuthorization(timeout);
}

test.describe("external-bridge: multi-target-grant", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let sql: SqlHelpers;
  let haexNotes: Extension;

  test.beforeAll(async () => {
    vault = new VaultAutomation();
    await vault.createSession();
    sql = createSqlHelpers(vault);

    const extensions = await vault.invokeTauriCommand<Extension[]>(
      "get_all_extensions",
      {},
    );
    const found = extensions.find((ext) => ext.name === "haex-notes");
    expect(found, "haex-notes must be installed for multi-target tests").not.toBeUndefined();
    haexNotes = found!;
  });

  test.afterAll(async () => {
    await vault?.deleteSession();
  });

  test("remember=true: core + extension grant in one call covers both targets", async () => {
    const client = new VaultBridgeClient({
      requestedExtensions: [
        {
          name: haexNotes.name,
          extensionPublicKey: haexNotes.publicKey,
          actions: ["e2e-multi-target-probe"],
        },
      ],
    });
    await waitForBridgeConnection(client);

    const authorized = await authorizeMultiTarget(
      vault,
      client,
      [CORE_EXTENSION_ID, haexNotes.id],
      true,
    );
    expect(authorized).toBe(true);

    // Core path: a core request succeeds (ExtensionPermission rows for core
    // were built while the pending manifest was still present).
    const coreResponse = await sendRequestWithRetry<{ success: boolean }>(
      client,
      BRIDGE_METHODS.GET_ITEMS,
      { url: `https://multi-target-core-${Date.now()}.example.com` },
    );
    expect(coreResponse.success).toBe(true);

    // Extension path: the second target's ExtensionApi row must exist too —
    // this is exactly the row Finding 1 left empty for every target after
    // the first.
    const clientId = client.getClientId()!;
    const target = `${haexNotes.publicKey}::${haexNotes.name}::e2e-multi-target-probe`;
    const rows = await sql.select("haex_principal_permissions", ["status"], {
      where: "principal_id = ? AND resource_type = ? AND target = ?",
      params: [clientId, "extensionApi", target],
    });
    expect(rows.length).toBe(1);
    expect(rows[0]![0]).toBe("granted");

    client.disconnect();
  });

  test("remember=true: reconnecting with the same keys and manifest re-authorizes without a prompt", async () => {
    const keyPair = crypto.generateKeyPairSync("x25519");
    const requestedExtensions = [
      {
        name: haexNotes.name,
        extensionPublicKey: haexNotes.publicKey,
        actions: ["e2e-multi-target-probe"],
      },
    ];

    const client = new VaultBridgeClient({ keyPair, requestedExtensions });
    await waitForBridgeConnection(client);
    const authorized = await authorizeMultiTarget(
      vault,
      client,
      [CORE_EXTENSION_ID, haexNotes.id],
      true,
    );
    expect(authorized).toBe(true);
    client.disconnect();

    // Reconnect with the identical keys + manifest. If Finding 1's bug were
    // present, the second `clientAllow` call would have overwritten
    // `requested_permissions` with an empty canonical manifest, and this
    // handshake would come back as a fresh pending-approval instead of an
    // immediate re-authorization.
    const reconnected = new VaultBridgeClient({ keyPair, requestedExtensions });
    const connected = await waitForBridgeConnection(reconnected);
    expect(connected).toBe(true);

    const paired = await reconnected.waitForAuthorization(15000);
    expect(paired).toBe(true);
    expect(reconnected.getState().state).toBe("paired");

    reconnected.disconnect();
  });

  test("remember=false: both targets stay usable within the same session", async () => {
    const client = new VaultBridgeClient({
      requestedExtensions: [
        {
          name: haexNotes.name,
          extensionPublicKey: haexNotes.publicKey,
          actions: ["e2e-multi-target-probe"],
        },
      ],
    });
    await waitForBridgeConnection(client);

    const authorized = await authorizeMultiTarget(
      vault,
      client,
      [CORE_EXTENSION_ID, haexNotes.id],
      false,
    );
    expect(authorized).toBe(true);

    const coreResponse = await sendRequestWithRetry<{ success: boolean }>(
      client,
      BRIDGE_METHODS.GET_ITEMS,
      { url: `https://multi-target-session-${Date.now()}.example.com` },
    );
    expect(coreResponse.success).toBe(true);

    const clientId = client.getClientId()!;
    const sessionAuths = await vault.getSessionAuthorizations();
    const forThisClient = sessionAuths.filter((sa) => sa.clientId === clientId);
    const grantedTargets = forThisClient.map((sa) => sa.extensionId).sort();
    expect(grantedTargets).toEqual([CORE_EXTENSION_ID, haexNotes.id].sort());

    client.disconnect();
  });

  test("session revoke removes both targets and denies follow-up requests", async () => {
    const client = new VaultBridgeClient({
      requestedExtensions: [
        {
          name: haexNotes.name,
          extensionPublicKey: haexNotes.publicKey,
          actions: ["e2e-multi-target-probe"],
        },
      ],
    });
    await waitForBridgeConnection(client);

    const authorized = await authorizeMultiTarget(
      vault,
      client,
      [CORE_EXTENSION_ID, haexNotes.id],
      false,
    );
    expect(authorized).toBe(true);

    const clientId = client.getClientId()!;
    const beforeRevoke = (await vault.getSessionAuthorizations()).filter(
      (sa) => sa.clientId === clientId,
    );
    expect(beforeRevoke.length).toBe(2);

    await vault.revokeSessionAuthorization(clientId);

    const afterRevoke = (await vault.getSessionAuthorizations()).filter(
      (sa) => sa.clientId === clientId,
    );
    expect(afterRevoke.length).toBe(0);

    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
    }>(client, BRIDGE_METHODS.GET_ITEMS, {
      url: `https://multi-target-revoked-${Date.now()}.example.com`,
    });
    expect(response.success).toBe(false);
    expect(response.error?.toLowerCase()).toMatch(/not authorized/);

    client.disconnect();
  });
});
