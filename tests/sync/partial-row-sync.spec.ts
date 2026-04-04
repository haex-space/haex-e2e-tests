/**
 * Tests for partial row sync scenarios.
 *
 * Verifies that when a row has multiple NOT NULL columns and only some columns
 * are updated on one device, the server still returns ALL columns when another
 * device pulls. This prevents NOT NULL constraint violations on INSERT.
 *
 * Root cause scenario:
 * 1. Device A pushes a row with columns (identity_id, type, value) — all NOT NULL
 * 2. Device B pulls all data, then updates only "value" column
 * 3. Device B pushes — only "value" goes to server (other columns unchanged)
 * 4. Device A pulls with afterUpdatedAt cursor — server must return ALL columns
 *    of the row, not just the updated "value" column
 *
 * Without the row-level pull guarantee, Device A would try to INSERT with only
 * "value" and fail with: NOT NULL constraint failed: identity_id
 */

import crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { AuthContext } from "../helpers";
import {
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  deleteVault,
  pushChanges,
  pullChanges,
  makeSyncChange,
  toAuthContext,
} from "../helpers";

test.describe("sync: partial-row-sync (NOT NULL safety)", () => {
  test.describe.configure({ mode: "serial" });

  let auth: AuthContext;
  const spaceId = crypto.randomUUID();
  const deviceA = `e2e-device-a-${Date.now()}`;
  const deviceB = `e2e-device-b-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    auth = toAuthContext(admin);
    await createVaultKey(auth, spaceId);
  });

  test.afterAll(async () => {
    try {
      await deleteVault(auth, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("pull returns ALL columns when only one column of a row was updated after cursor", async () => {
    // Simulate: Device A creates a row with 3 NOT NULL columns
    const rowId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: rowId });

    const identityIdValue = crypto.randomBytes(16).toString("base64");
    const typeValue = crypto.randomBytes(16).toString("base64");
    const valueValue = crypto.randomBytes(16).toString("base64");

    // Device A pushes all 3 columns of the row
    const pushResult = await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "identity_id",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: identityIdValue,
      }),
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "type",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000002:${deviceA}`,
        encryptedValue: typeValue,
      }),
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "value",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000003:${deviceA}`,
        encryptedValue: valueValue,
      }),
    ]);

    expect(pushResult.count).toBe(3);

    // Record the server timestamp as Device A's cursor
    const deviceACursor = pushResult.serverTimestamp;

    // Device B updates ONLY the "value" column (simulating updateClaimAsync)
    const updatedValue = crypto.randomBytes(16).toString("base64");
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "value",
        deviceId: deviceB,
        hlcTimestamp: `2024-06-01T00:00:00.000Z:00000001:${deviceB}`,
        encryptedValue: updatedValue,
      }),
    ]);

    // Device A pulls with afterUpdatedAt = its cursor
    // The server should return ALL 3 columns (identity_id, type, value)
    // even though only "value" was updated after the cursor
    const pulled = await pullChanges(auth, spaceId, {
      afterUpdatedAt: deviceACursor,
    });

    const rowChanges = pulled.changes.filter((c) => c.rowPks === rowPks);
    const columnNames = rowChanges.map((c) => c.columnName).sort();

    // CRITICAL: All 3 columns must be returned, not just "value"
    expect(columnNames).toEqual(["identity_id", "type", "value"]);

    // Verify values are correct
    const identityIdChange = rowChanges.find((c) => c.columnName === "identity_id");
    const typeChange = rowChanges.find((c) => c.columnName === "type");
    const valueChange = rowChanges.find((c) => c.columnName === "value");

    expect(identityIdChange!.encryptedValue).toBe(identityIdValue);
    expect(typeChange!.encryptedValue).toBe(typeValue);
    // value should be the UPDATED value (Device B's push wins via LWW)
    expect(valueChange!.encryptedValue).toBe(updatedValue);
  });

  test("new row pushed with only one column is returned as single column on pull", async () => {
    // Edge case: what if a device pushes only ONE column for a NEW row?
    // This simulates the bug scenario where only "value" was pushed.
    const rowId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: rowId });

    const firstPush = await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "value",
        deviceId: deviceB,
        hlcTimestamp: `2024-07-01T00:00:00.000Z:00000001:${deviceB}`,
      }),
    ]);

    const cursor = firstPush.serverTimestamp;

    // Pull with no cursor (full sync) should return the single column
    const pulledFull = await pullChanges(auth, spaceId);
    const rowChangesFull = pulledFull.changes.filter((c) => c.rowPks === rowPks);
    expect(rowChangesFull).toHaveLength(1);
    expect(rowChangesFull[0].columnName).toBe("value");

    // Now push the missing columns (simulating a fix/re-push)
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "identity_id",
        deviceId: deviceB,
        hlcTimestamp: `2024-07-01T00:00:01.000Z:00000001:${deviceB}`,
      }),
      makeSyncChange({
        tableName: "haex_identity_claims",
        rowPks,
        columnName: "type",
        deviceId: deviceB,
        hlcTimestamp: `2024-07-01T00:00:01.000Z:00000002:${deviceB}`,
      }),
    ]);

    // Pull after cursor should now return ALL 3 columns
    const pulledAfter = await pullChanges(auth, spaceId, {
      afterUpdatedAt: cursor,
    });
    const rowChangesAfter = pulledAfter.changes.filter((c) => c.rowPks === rowPks);
    const columnsAfter = rowChangesAfter.map((c) => c.columnName).sort();

    // All 3 columns should be returned (row-level granularity)
    expect(columnsAfter).toEqual(["identity_id", "type", "value"]);
  });

  test("two devices: partial column updates from both are merged correctly on pull", async () => {
    // Device A creates a row, Device B updates some columns,
    // Device A updates other columns — pull should return all latest values
    const rowId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: rowId });

    // Device A pushes initial row (3 columns)
    const initialPush = await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: "title-v1",
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "username",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000002:${deviceA}`,
        encryptedValue: "user-v1",
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000003:${deviceA}`,
        encryptedValue: "pass-v1",
      }),
    ]);

    const cursorAfterInit = initialPush.serverTimestamp;

    // Device B updates only "username"
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "username",
        deviceId: deviceB,
        hlcTimestamp: `2024-06-01T00:00:00.000Z:00000001:${deviceB}`,
        encryptedValue: "user-v2-from-B",
      }),
    ]);

    // Device A updates only "password"
    await pushChanges(auth, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId: deviceA,
        hlcTimestamp: `2024-06-02T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: "pass-v2-from-A",
      }),
    ]);

    // A third device pulls with cursor from before any updates
    const pulled = await pullChanges(auth, spaceId, {
      afterUpdatedAt: cursorAfterInit,
    });

    const rowChanges = pulled.changes.filter((c) => c.rowPks === rowPks);
    const columns = rowChanges.map((c) => c.columnName).sort();

    // All 3 columns should be returned
    expect(columns).toEqual(["password", "title", "username"]);

    // Values should reflect LWW (last-write-wins)
    const titleChange = rowChanges.find((c) => c.columnName === "title");
    const usernameChange = rowChanges.find((c) => c.columnName === "username");
    const passwordChange = rowChanges.find((c) => c.columnName === "password");

    expect(titleChange!.encryptedValue).toBe("title-v1"); // unchanged
    expect(usernameChange!.encryptedValue).toBe("user-v2-from-B"); // updated by B
    expect(passwordChange!.encryptedValue).toBe("pass-v2-from-A"); // updated by A
  });
});
