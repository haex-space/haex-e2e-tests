import crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { AuthContext } from "../helpers";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  deleteVault,
  pushChanges,
  makeSyncChange,
  toAuthContext,
  createDidAuthHeader,
  DidAuthAction,
} from "../helpers";

test.describe("sync: batch-validation", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();
  let auth: AuthContext;
  const spaceId = crypto.randomUUID();
  const deviceId = `e2e-batch-device-${Date.now()}`;

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

  test("complete batch (seq 1,2,3 of 3) is accepted with count 3", async () => {
    const batchId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const changes = [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000001:${deviceId}`,
        batchId,
        batchSeq: 1,
        batchTotal: 3,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "username",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000002:${deviceId}`,
        batchId,
        batchSeq: 2,
        batchTotal: 3,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000003:${deviceId}`,
        batchId,
        batchSeq: 3,
        batchTotal: 3,
      }),
    ];

    const result = await pushChanges(auth, spaceId, changes);

    expect(result.count).toBe(3);
    expect(typeof result.serverTimestamp).toBe("string");
  });

  test("incomplete batch (missing seq 2) returns 400 with missingSequences", async () => {
    const batchId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const changes = [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000010:${deviceId}`,
        batchId,
        batchSeq: 1,
        batchTotal: 3,
      }),
      // Seq 2 intentionally missing
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000012:${deviceId}`,
        batchId,
        batchSeq: 3,
        batchTotal: 3,
      }),
    ];

    const bodyStr = JSON.stringify({ spaceId, changes });

    const res = await fetch(`${baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Incomplete batch");
    expect(data.batchId).toBe(batchId);
    expect(Array.isArray(data.missingSequences)).toBe(true);
    expect(data.missingSequences).toContain(2);
    expect(data.expected).toBe(3);
    expect(data.received).toBe(2);
  });

  test("duplicate sequence numbers in batch returns 400", async () => {
    const batchId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const rowPks = JSON.stringify({ id: entryId });

    const changes = [
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "title",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000020:${deviceId}`,
        batchId,
        batchSeq: 1,
        batchTotal: 3,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "username",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000021:${deviceId}`,
        batchId,
        batchSeq: 1, // Duplicate seq 1
        batchTotal: 3,
      }),
      makeSyncChange({
        tableName: "entries",
        rowPks,
        columnName: "password",
        deviceId,
        hlcTimestamp: `${new Date().toISOString()}:00000022:${deviceId}`,
        batchId,
        batchSeq: 3,
        batchTotal: 3,
      }),
    ];

    const bodyStr = JSON.stringify({ spaceId, changes });

    const res = await fetch(`${baseUrl}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.SyncPush, bodyStr),
      },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
  });
});
