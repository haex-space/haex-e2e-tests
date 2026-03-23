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

test.describe("sync: conflict-resolution", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const spaceId = crypto.randomUUID();
  const deviceA = `e2e-device-a-${Date.now()}`;
  const deviceB = `e2e-device-b-${Date.now()}`;

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

  test("same cell from two devices: later HLC wins", async () => {
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const earlyValue = crypto.randomBytes(16).toString("base64");
    const lateValue = crypto.randomBytes(16).toString("base64");

    // Device A pushes with early timestamp
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `2024-01-01T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: earlyValue,
      }),
    ]);

    // Device B pushes same cell with later timestamp
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceB,
        hlcTimestamp: `2024-06-01T00:00:00.000Z:00000001:${deviceB}`,
        encryptedValue: lateValue,
      }),
    ]);

    const pulled = await pullChanges(accessToken, spaceId);

    const matches = pulled.changes.filter(
      (c) => c.rowPks === rowPks && c.columnName === "title",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].encryptedValue).toBe(lateValue);
    expect(matches[0].deviceId).toBe(deviceB);
  });

  test("push multiple columns of same row returns all on pull", async () => {
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const titleValue = crypto.randomBytes(16).toString("base64");
    const usernameValue = crypto.randomBytes(16).toString("base64");
    const passwordValue = crypto.randomBytes(16).toString("base64");

    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `${new Date().toISOString()}:00000010:${deviceA}`,
        encryptedValue: titleValue,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "username",
        deviceId: deviceA,
        hlcTimestamp: `${new Date().toISOString()}:00000011:${deviceA}`,
        encryptedValue: usernameValue,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId: deviceA,
        hlcTimestamp: `${new Date().toISOString()}:00000012:${deviceA}`,
        encryptedValue: passwordValue,
      }),
    ]);

    const pulled = await pullChanges(accessToken, spaceId);

    const rowChanges = pulled.changes.filter((c) => c.rowPks === rowPks);
    const columns = rowChanges.map((c) => c.columnName).sort();

    expect(columns).toEqual(["password", "title", "username"]);

    const titleChange = rowChanges.find((c) => c.columnName === "title");
    const usernameChange = rowChanges.find((c) => c.columnName === "username");
    const passwordChange = rowChanges.find((c) => c.columnName === "password");

    expect(titleChange!.encryptedValue).toBe(titleValue);
    expect(usernameChange!.encryptedValue).toBe(usernameValue);
    expect(passwordChange!.encryptedValue).toBe(passwordValue);
  });

  test("push then push again with later timestamp overwrites", async () => {
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const firstValue = crypto.randomBytes(16).toString("base64");
    const secondValue = crypto.randomBytes(16).toString("base64");

    // First push
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `2024-03-01T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: firstValue,
      }),
    ]);

    // Second push with later HLC
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `2024-09-01T00:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: secondValue,
      }),
    ]);

    const pulled = await pullChanges(accessToken, spaceId);

    const matches = pulled.changes.filter(
      (c) => c.rowPks === rowPks && c.columnName === "title",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].encryptedValue).toBe(secondValue);
  });

  test("pull with afterUpdatedAt returns only newer changes", async () => {
    // Push a change and record the server timestamp
    const entryIdOld = crypto.randomUUID();
    const oldResult = await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryIdOld }),
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `${new Date().toISOString()}:00000030:${deviceA}`,
      }),
    ]);

    const cutoff = oldResult.serverTimestamp;

    // Push a newer change after the cutoff
    const entryIdNew = crypto.randomUUID();
    await pushChanges(accessToken, spaceId, [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryIdNew }),
        columnName: "title",
        deviceId: deviceA,
        hlcTimestamp: `${new Date().toISOString()}:00000031:${deviceA}`,
      }),
    ]);

    // Pull only changes after cutoff
    const pulled = await pullChanges(accessToken, spaceId, {
      afterUpdatedAt: cutoff,
    });

    // The new entry should be present
    const foundNew = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryIdNew }),
    );
    expect(foundNew).not.toBeUndefined();

    // The old entry should NOT be present (it was at or before cutoff)
    const foundOld = pulled.changes.find(
      (c) => c.rowPks === JSON.stringify({ id: entryIdOld }),
    );
    expect(foundOld).toBeUndefined();
  });
});
