import crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  deleteVault,
  pushChanges,
  pullChanges,
  makeSyncChange,
} from "../helpers";

test.describe("sync: pull-changes", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const spaceId = crypto.randomUUID();
  const deviceId = `e2e-pull-device-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, spaceId);
  });

  test.afterAll(async () => {
    try {
      await deleteVault(accessToken, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("pull from empty vault returns empty changes and hasMore false", async () => {
    const pulled = await pullChanges(accessToken, spaceId);

    expect(Array.isArray(pulled.changes)).toBe(true);
    expect(pulled.changes).toHaveLength(0);
    expect(pulled.hasMore).toBe(false);
    expect(typeof pulled.serverTimestamp).toBe("string");
  });

  test("push changes then pull returns all changes", async () => {
    const entryId1 = crypto.randomUUID();
    const entryId2 = crypto.randomUUID();

    const value1 = crypto.randomBytes(16).toString("base64");
    const value2 = crypto.randomBytes(16).toString("base64");

    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryId1 }),
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
        encryptedValue: value1,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryId2 }),
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000002:${deviceId}`,
        encryptedValue: value2,
      }),
    ]);

    const pulled = await pullChanges(accessToken, spaceId);

    const found1 = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryId1 }),
    );
    const found2 = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryId2 }),
    );

    expect(found1).not.toBeUndefined();
    expect(found1!.encryptedValue).toBe(value1);
    expect(found1!.tableName).toBe("entries");
    expect(found1!.columnName).toBe("title");

    expect(found2).not.toBeUndefined();
    expect(found2!.encryptedValue).toBe(value2);
  });

  test("pull with limit returns limited set and hasMore true", async () => {
    // Create a fresh vault to control exact count
    const limitSpaceId = crypto.randomUUID();
    await createVaultKey(accessToken, limitSpaceId);

    try {
      // Push 5 changes
      const changes = Array.from({ length: 5 }, (_, i) =>
        makeSyncChange({
          tableName: "entries",
          rowPks: JSON.stringify({ id: crypto.randomUUID() }),
          columnName: "title",
          deviceId,
          hlcTimestamp: `${new Date().toISOString()}:${String(i + 1).padStart(8, "0")}:${deviceId}`,
        }),
      );

      await pushChanges(accessToken, limitSpaceId, changes);

      // Pull with limit 2
      const pulled = await pullChanges(accessToken, limitSpaceId, { limit: 2 });

      expect(pulled.changes).toHaveLength(2);
      expect(pulled.hasMore).toBe(true);
    } finally {
      await deleteVault(accessToken, limitSpaceId);
    }
  });

  test("pull with afterUpdatedAt returns only newer changes", async () => {
    // Push first batch and get server timestamp
    const entryIdBefore = crypto.randomUUID();
    const beforeResult = await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryIdBefore }),
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000010:${deviceId}`,
      }),
    ]);

    const cutoff = beforeResult.serverTimestamp;

    // Push second batch after cutoff
    const entryIdAfter = crypto.randomUUID();
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryIdAfter }),
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000011:${deviceId}`,
      }),
    ]);

    const pulled = await pullChanges(accessToken, spaceId, {
      afterUpdatedAt: cutoff,
    });

    // After-cutoff entry should be present
    const foundAfter = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryIdAfter }),
    );
    expect(foundAfter).not.toBeUndefined();

    // Before-cutoff entry should NOT be present
    const foundBefore = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryIdBefore }),
    );
    expect(foundBefore).toBeUndefined();
  });

  test("pull returns all columns of a row when any column is updated (row-level granularity)", async () => {
    // Create a fresh vault to avoid interference
    const rowSpaceId = crypto.randomUUID();
    await createVaultKey(accessToken, rowSpaceId);

    try {
      const entryId = crypto.randomUUID();
      const rowPks = JSON.stringify({ id: entryId });

      const titleValue = crypto.randomBytes(16).toString("base64");
      const usernameValue = crypto.randomBytes(16).toString("base64");

      // Push title column first
      const firstResult = await pushChanges(accessToken, rowSpaceId, [
        makeSyncChange({
          tableName: "entries",
          rowPks,
          columnName: "title",
          deviceId,
          hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
          encryptedValue: titleValue,
        }),
      ]);

      const cutoff = firstResult.serverTimestamp;

      // Push username column after cutoff (updating a different column of same row)
      await pushChanges(accessToken, rowSpaceId, [
        makeSyncChange({
          tableName: "entries",
          rowPks,
          columnName: "username",
          deviceId,
          hlcTimestamp: `${new Date().toISOString()}:00000002:${deviceId}`,
          encryptedValue: usernameValue,
        }),
      ]);

      // Pull with afterUpdatedAt=cutoff: should return ALL columns of the row
      // because the row was updated (username column changed after cutoff)
      const pulled = await pullChanges(accessToken, rowSpaceId, {
        afterUpdatedAt: cutoff,
      });

      const rowChanges = pulled.changes.filter((c) => c.rowPks === rowPks);
      const columns = rowChanges.map((c) => c.columnName).sort();

      // Both title and username should be returned since any column of the row was updated
      expect(columns).toEqual(["title", "username"]);

      const titleChange = rowChanges.find((c) => c.columnName === "title");
      const usernameChange = rowChanges.find(
        (c) => c.columnName === "username",
      );

      expect(titleChange!.encryptedValue).toBe(titleValue);
      expect(usernameChange!.encryptedValue).toBe(usernameValue);
    } finally {
      await deleteVault(accessToken, rowSpaceId);
    }
  });
});
