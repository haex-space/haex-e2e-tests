import crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  deleteVault,
  pushChanges,
  pullChanges,
  makeSyncChange,
} from "../helpers";

test.describe("sync: push-changes", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();
  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-push-device-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, vaultId);
  });

  test.afterAll(async () => {
    try {
      await deleteVault(accessToken, vaultId);
    } catch {
      // Best effort cleanup
    }
  });

  test("push single change returns count 1 and serverTimestamp", async () => {
    const change = makeSyncChange({
      tableName: "entries",
      rowPks: JSON.stringify({ id: crypto.randomUUID() }),
      columnName: "title",
      deviceId,
      hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
    });

    const result = await pushChanges(accessToken, vaultId, [change]);

    expect(result.count).toBe(1);
    expect(typeof result.serverTimestamp).toBe("string");
    const ts = new Date(result.serverTimestamp);
    expect(ts.getTime()).not.toBeNaN();
  });

  test("push multiple changes returns correct count", async () => {
    const entryId = crypto.randomUUID();
    const changes = [
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryId }),
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000002:${deviceId}`,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryId }),
        columnName: "username",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000003:${deviceId}`,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks: JSON.stringify({ id: entryId }),
        columnName: "password",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000004:${deviceId}`,
      }),
    ];

    const result = await pushChanges(accessToken, vaultId, changes);

    expect(result.count).toBe(3);
    expect(typeof result.serverTimestamp).toBe("string");
  });

  test("pull back pushed changes returns all with correct values", async () => {
    const entryId = crypto.randomUUID();
    const encryptedValue = crypto.randomBytes(16).toString("base64");
    const nonce = crypto.randomBytes(12).toString("base64");

    const change = makeSyncChange({
      tableName: "entries",
      rowPks: JSON.stringify({ id: entryId }),
      columnName: "title",
      deviceId,
      hlcTimestamp: `${new Date().toISOString()}:00000010:${deviceId}`,
      encryptedValue,
      nonce,
    });

    await pushChanges(accessToken, vaultId, [change]);

    // Pull without excluding own device to see our changes
    const pulled = await pullChanges(accessToken, vaultId);

    const found = pulled.changes.find(
      (c) =>
        c.rowPks === JSON.stringify({ id: entryId }) &&
        c.columnName === "title",
    );

    expect(found).not.toBeUndefined();
    expect(found!.tableName).toBe("entries");
    expect(found!.encryptedValue).toBe(encryptedValue);
    expect(found!.nonce).toBe(nonce);
    expect(found!.deviceId).toBe(deviceId);
  });

  test("exclude own device from pull filters out own changes", async () => {
    const entryId = crypto.randomUUID();

    const change = makeSyncChange({
      tableName: "entries",
      rowPks: JSON.stringify({ id: entryId }),
      columnName: "title",
      deviceId,
      hlcTimestamp: `${new Date().toISOString()}:00000020:${deviceId}`,
    });

    await pushChanges(accessToken, vaultId, [change]);

    // Pull excluding own device
    const pulled = await pullChanges(accessToken, vaultId, {
      excludeDeviceId: deviceId,
    });

    const found = pulled.changes.find(
      (c) =>
        c.rowPks === JSON.stringify({ id: entryId }) &&
        c.columnName === "title" &&
        c.deviceId === deviceId,
    );

    expect(found).toBeUndefined();
  });

  test("last-write-wins: later HLC overwrites earlier for same cell", async () => {
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });
    const otherDevice = `e2e-other-device-${Date.now()}`;

    const earlyValue = crypto.randomBytes(16).toString("base64");
    const lateValue = crypto.randomBytes(16).toString("base64");

    // Push early version
    const earlyChange = makeSyncChange({
      tableName: "entries",
      rowPks,
      columnName: "title",
      deviceId,
      hlcTimestamp: `2020-01-01T00:00:00.000Z:00000001:${deviceId}`,
      encryptedValue: earlyValue,
    });

    await pushChanges(accessToken, vaultId, [earlyChange]);

    // Push late version from another device
    const lateChange = makeSyncChange({
      tableName: "entries",
      rowPks,
      columnName: "title",
      deviceId: otherDevice,
      hlcTimestamp: `2099-01-01T00:00:00.000Z:00000001:${otherDevice}`,
      encryptedValue: lateValue,
    });

    await pushChanges(accessToken, vaultId, [lateChange]);

    // Pull all changes for this cell
    const pulled = await pullChanges(accessToken, vaultId);

    const matches = pulled.changes.filter(
      (c) => c.rowPks === rowPks && c.columnName === "title",
    );

    // Server should return only the winning (later HLC) version
    expect(matches).toHaveLength(1);
    expect(matches[0].encryptedValue).toBe(lateValue);
    expect(matches[0].deviceId).toBe(otherDevice);
  });
});
