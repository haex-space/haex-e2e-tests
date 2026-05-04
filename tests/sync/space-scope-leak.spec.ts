/**
 * Data-leak coverage for the cloud sync pipeline.
 *
 * Background: a member of two shared spaces (call them S and T) used to leak
 * Space T rows over a Space S backend, because the haex-vault client iterated
 * every dirty CRDT table and pushed every changed row regardless of which
 * space the row belonged to. The MLS epoch key was per-space, but the SET
 * of rows pushed was not, so any peer of Space S would decrypt and ingest
 * Space T rows. Tracked + fixed in haex-vault PR #214.
 *
 * The fix is purely client-side (push.ts now filters by spaceId per row for
 * built-in tables and by haex_shared_space_sync for extension tables). The
 * sync server keeps storing whatever is pushed — a deliberate choice so that
 * any future regression on the client is observable here, not silently
 * swallowed by a receive-side filter.
 *
 * These tests:
 *   1. Document the leak shape so a future maintainer cannot remove the
 *      client-side filter unnoticed.
 *   2. Provide reusable assertions other sync specs can call to fail loudly
 *      the moment a foreign-space row appears on a shared-space pull.
 *   3. Cover the table whitelist + per-row policy at the server boundary,
 *      so the "what may legitimately cross a shared-space stream" contract
 *      is locked down on both ends.
 */
import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { AuthContext } from "../helpers";
import {
  checkSyncServerHealth,
  createAdminUserWithIdentity,
  createSpace as createSharedSpace,
  signAndPushSpaceChanges,
  pullChanges,
  makeSyncChange,
  toAuthContext,
} from "../helpers";

/**
 * Tables that may legitimately appear on a shared-space pull. Mirror of
 * `SHARED_SPACE_BUILTIN_TABLES` in
 * `haex-vault/src/stores/sync/sharedSpaceScope.ts`. Anything else arriving
 * over a shared-space pull is a leak.
 */
const SHARED_SPACE_BUILTIN_TABLES = new Set<string>([
  "haex_spaces",
  "haex_space_members",
  "haex_space_devices",
  "haex_peer_shares",
  "haex_mls_sync_keys",
  "haex_device_mls_enrollments",
  "haex_ucan_tokens",
  "haex_pending_invites",
  "haex_sync_rules",
  "haex_shared_space_sync",
]);

interface PulledChange {
  tableName: string;
  rowPks: string;
  columnName: string;
  hlcTimestamp: string;
  deviceId: string;
}

/**
 * Reusable scope-leak detector. Returns the list of changes that violate
 * the shared-space scope contract for `expectedSpaceId`:
 *   - tableName outside the built-in whitelist (and not opted in via
 *     `extraAllowedTables` for extension data registered through
 *     haex_shared_space_sync — the caller knows which extensions belong);
 *   - haex_spaces row whose `id` primary key is some OTHER space (the
 *     classic phantom-space leak shape).
 *
 * Other built-in tables carry their spaceId in a non-PK column, so we
 * cannot decide from rowPks alone — the haex-vault unit test
 * (sharedSpaceScope.test.ts) covers that part. This detector handles
 * everything we CAN check from a server-side pull.
 */
export function findScopeViolations(
  changes: PulledChange[],
  expectedSpaceId: string,
  options: { extraAllowedTables?: Set<string> } = {},
): PulledChange[] {
  const allowed = new Set([
    ...SHARED_SPACE_BUILTIN_TABLES,
    ...(options.extraAllowedTables ?? []),
  ]);
  const violations: PulledChange[] = [];

  for (const change of changes) {
    if (!allowed.has(change.tableName)) {
      violations.push(change);
      continue;
    }
    if (change.tableName === "haex_spaces") {
      try {
        const pks = JSON.parse(change.rowPks) as Record<string, unknown>;
        if (pks.id !== expectedSpaceId) violations.push(change);
      } catch {
        // Malformed rowPks counts as a violation — an honest peer never
        // produces these.
        violations.push(change);
      }
    }
  }
  return violations;
}

test.describe("sync: shared-space scope (data-leak prevention)", () => {
  test.describe.configure({ mode: "serial" });

  // The realistic shape: user B owns two unrelated shared spaces. The
  // original leak fired when a member of S+T pushed dirty rows for both
  // through the S-bound pipeline; the asymmetry is encoded in which space
  // the changes are pushed to (S vs T), not in who is doing the pushing.
  // Owner-side pulls are enough to inspect what landed under each space —
  // member pulls would need a UCAN dance unrelated to the leak shape.
  let authB: AuthContext;
  let userB: { privateKeyBase64: string; publicKey: string };
  const spaceS = crypto.randomUUID();
  const spaceT = crypto.randomUUID();
  const deviceB = `device-b-${Date.now()}`;

  /** Sign-and-push wrapper bound to user B (the only pusher in this spec). */
  const pushAsB = (spaceId: string, changes: Parameters<typeof signAndPushSpaceChanges>[2]) =>
    signAndPushSpaceChanges(authB, spaceId, changes, userB.privateKeyBase64, userB.publicKey);

  test.beforeAll(async () => {
    expect(await checkSyncServerHealth()).toBe(true);
    // *WithIdentity gives us the public-key half too (sync server requires
    // every push to be signed and the signedBy field is the pusher's
    // pubkey), so use that flavour and keep the raw record around.
    const adminB = await createAdminUserWithIdentity();
    authB = toAuthContext(adminB);
    userB = { privateKeyBase64: adminB.privateKeyBase64, publicKey: adminB.publicKey };

    const sRes = await createSharedSpace(authB, spaceS, "scope-leak: space S");
    expect(sRes.status).toBe(201);
    const tRes = await createSharedSpace(authB, spaceT, "scope-leak: space T");
    expect(tRes.status).toBe(201);
  });

  test("baseline: well-behaved push only sends in-scope rows for the target space", async () => {
    // Simulates the haex-vault client AFTER the fix: when pushing to
    // backend S, the row belongs to space S.
    await pushAsB(spaceS, [
      makeSyncChange({
        tableName: "haex_spaces",
        rowPks: JSON.stringify({ id: spaceS }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T10:00:00.000Z:00000001:${deviceB}`,
      }),
      makeSyncChange({
        tableName: "haex_space_members",
        rowPks: JSON.stringify({ id: `mem-${spaceS}` }),
        columnName: "role",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T10:00:00.000Z:00000002:${deviceB}`,
      }),
    ]);

    const pulled = await pullChanges(authB, spaceS);
    const violations = findScopeViolations(pulled.changes, spaceS);
    expect(violations).toEqual([]);
  });

  test("regression detector catches a haex_spaces phantom (the original leak shape)", async () => {
    // This push simulates the PRE-FIX client: pushing to backend S but
    // including a haex_spaces row for Space T. The server happily stores
    // it (no per-row scope on the server, by design). The detector must
    // flag the resulting pull. If this assertion ever flips, the
    // server-side scope policy changed and the policy mirror at the top
    // of this file likely needs to follow.
    await pushAsB(spaceS, [
      makeSyncChange({
        tableName: "haex_spaces",
        rowPks: JSON.stringify({ id: spaceT }), // <-- foreign space's PK
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T11:00:00.000Z:00000001:${deviceB}`,
      }),
    ]);

    const pulled = await pullChanges(authB, spaceS);
    const violations = findScopeViolations(pulled.changes, spaceS);
    const phantomSpaceRow = violations.find(
      (v) =>
        v.tableName === "haex_spaces" &&
        JSON.parse(v.rowPks).id === spaceT,
    );
    expect(phantomSpaceRow).toBeDefined();
  });

  test("regression detector catches a vault-private table (must never cross shared-space)", async () => {
    // Vault-private tables — identities, vault settings, sync backends —
    // must never travel over a shared-space backend regardless of who
    // ships them. We simulate the exact buggy shape and assert the
    // detector flags it.
    await pushAsB(spaceS, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "leaked-setting" }),
        columnName: "value",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T12:00:00.000Z:00000001:${deviceB}`,
      }),
      makeSyncChange({
        tableName: "haex_identities",
        rowPks: JSON.stringify({ id: "leaked-identity" }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T12:00:00.000Z:00000002:${deviceB}`,
      }),
    ]);

    const pulled = await pullChanges(authB, spaceS);
    const violations = findScopeViolations(pulled.changes, spaceS);
    const tables = new Set(violations.map((v) => v.tableName));
    expect(tables.has("haex_vault_settings")).toBe(true);
    expect(tables.has("haex_identities")).toBe(true);
  });

  test("legitimate built-in shared-space tables are accepted by the detector", async () => {
    // Smoke check: every entry of the whitelist must be reachable via a
    // valid push, otherwise the whitelist is actively wrong. Push a
    // minimal row per table and confirm none of them are flagged.
    const hlcBase = `2026-04-01T13:00:00.000Z`;
    let counter = 1;
    for (const table of SHARED_SPACE_BUILTIN_TABLES) {
      const seq = String(counter++).padStart(8, "0");
      await pushAsB(spaceS, [
        makeSyncChange({
          tableName: table,
          rowPks:
            table === "haex_spaces"
              ? JSON.stringify({ id: spaceS })
              : JSON.stringify({ id: `${table}-${seq}` }),
          columnName: "value",
          deviceId: deviceB,
          hlcTimestamp: `${hlcBase}:${seq}:${deviceB}`,
        }),
      ]);
    }

    const pulled = await pullChanges(authB, spaceS);
    const violations = findScopeViolations(pulled.changes, spaceS);
    // Only the foreign haex_spaces row from the earlier test plus the
    // vault-private rows (also from earlier) should still be there.
    // Anything from THIS test's push must NOT show up in violations.
    const violationTables = new Set(violations.map((v) => v.tableName));
    for (const table of SHARED_SPACE_BUILTIN_TABLES) {
      if (table === "haex_spaces") continue; // already covered explicitly
      expect(violationTables.has(table)).toBe(false);
    }
  });

  test("a member of S+T pushing only S rows produces a clean S pull", async () => {
    // Direct rehearsal of the original real-world scenario: User B is a
    // member of two spaces and dispatches changes to both. After the fix
    // the client refuses to mix the two streams; we simulate that here by
    // explicitly only pushing S-scoped rows to the S backend, never
    // touching the S backend with T-scoped data.
    const cleanSpaceForRehearsal = crypto.randomUUID();
    expect((await createSharedSpace(authB, cleanSpaceForRehearsal, "rehearsal-S")).status).toBe(201);

    await pushAsB(cleanSpaceForRehearsal, [
      makeSyncChange({
        tableName: "haex_spaces",
        rowPks: JSON.stringify({ id: cleanSpaceForRehearsal }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T14:00:00.000Z:00000001:${deviceB}`,
      }),
      makeSyncChange({
        tableName: "haex_peer_shares",
        rowPks: JSON.stringify({ id: `share-${cleanSpaceForRehearsal}` }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T14:00:00.000Z:00000002:${deviceB}`,
      }),
    ]);

    // T-scoped rows go to the T backend ONLY, exactly as a fixed client
    // does it. They must NOT leak into the S pull.
    await pushAsB(spaceT, [
      makeSyncChange({
        tableName: "haex_peer_shares",
        rowPks: JSON.stringify({ id: `share-${spaceT}` }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-04-01T14:00:00.000Z:00000003:${deviceB}`,
      }),
    ]);

    const pulled = await pullChanges(authB, cleanSpaceForRehearsal);
    const violations = findScopeViolations(pulled.changes, cleanSpaceForRehearsal);
    // No phantom-spaces, no foreign tables, no surprises.
    expect(violations).toEqual([]);
    // And the T row never appears under S.
    const foreignShare = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: `share-${spaceT}` }),
    );
    expect(foreignShare).toBeUndefined();
  });
});
