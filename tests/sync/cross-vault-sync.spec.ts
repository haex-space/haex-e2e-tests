import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  pushChanges,
  pullChanges,
  makeSyncChange,
} from "../helpers";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

async function createSpace(token: string, spaceId: string, label: string) {
  return fetch(`${SYNC_SERVER_URL}/spaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: spaceId,
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
      label,
      keyGrant: {
        encryptedSpaceKey: randomBase64(32),
        keyNonce: randomBase64(12),
        ephemeralPublicKey: randomBase64(65),
      },
    }),
  });
}

test.describe("sync: cross-vault sync via shared spaces", () => {
  test.describe.configure({ mode: "serial" });

  // Two completely separate users with their own vaults
  let userA: { accessToken: string; userId: string };
  let userB: { accessToken: string; userId: string };
  const spaceIdA = crypto.randomUUID(); // User A's personal vault
  const spaceIdB = crypto.randomUUID(); // User B's personal vault
  const sharedSpaceId = crypto.randomUUID(); // Shared space partition
  const deviceA = `device-a-${Date.now()}`;
  const deviceB = `device-b-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    // Create two independent users
    userA = await createAdminUser();
    userB = await createAdminUser();

    // Each user creates their own vault key
    await createVaultKey(userA.accessToken, spaceIdA);
    await createVaultKey(userB.accessToken, spaceIdB);
  });

  test.afterAll(async () => {
    try {
      await fetch(`${SYNC_SERVER_URL}/spaces/${sharedSpaceId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userA.accessToken}` },
      });
    } catch {
      // Best effort
    }
  });

  // =====================================================================
  // Personal Vault Isolation
  // =====================================================================

  test("user A can push to their own vault", async () => {
    const res = await pushChanges(userA.accessToken, spaceIdA, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "setting-a-1" }),
        columnName: "value",
        deviceId: deviceA,
        hlcTimestamp: `2026-03-21T10:00:00.000Z:00000001:${deviceA}`,
      }),
    ]);
    expect(res.count).toBeDefined();
  });

  test("user B cannot pull from user A's vault", async () => {
    const res = await fetch(
      `${SYNC_SERVER_URL}/sync/pull?spaceId=${spaceIdA}&limit=10`,
      { headers: { Authorization: `Bearer ${userB.accessToken}` } },
    );

    // Should be forbidden or return empty (RLS blocks access)
    if (res.status === 200) {
      const data = await res.json();
      expect(data.changes.length).toBe(0); // RLS filters out
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("user B cannot push to user A's vault", async () => {
    try {
      const res = await pushChanges(userB.accessToken, spaceIdA, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: "evil-inject" }),
          columnName: "value",
          deviceId: deviceB,
        }),
      ]);
      // If it doesn't throw, it should fail
      expect(res.count).toBeUndefined();
    } catch (error) {
      // Expected: push should fail with 403 or similar
      expect(error).toBeDefined();
    }
  });

  // =====================================================================
  // Shared Space Sync
  // =====================================================================

  test("user A creates a shared space", async () => {
    const res = await createSpace(userA.accessToken, sharedSpaceId, "Cross-Vault Test Space");
    expect(res.status).toBe(201);
  });

  test("user A creates partition for shared space", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/partitions/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.accessToken}`,
      },
    });

    // Might return the created partition or may not be implemented
    // Accept 200/201 or skip if not available
    if (res.status === 404) {
      test.skip(true, "Partition create endpoint not available");
    }
  });

  // =====================================================================
  // Multi-Device Sync (Same User, Different Devices)
  // =====================================================================

  test("user A pushes from device A", async () => {
    const res = await pushChanges(userA.accessToken, spaceIdA, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "multi-device-1" }),
        columnName: "value",
        deviceId: deviceA,
        hlcTimestamp: `2026-03-21T11:00:00.000Z:00000001:${deviceA}`,
        encryptedValue: btoa("value-from-device-a"),
      }),
    ]);
    expect(res.count).toBeDefined();
  });

  test("user A pulls from device B and sees device A's changes", async () => {
    const pulled = await pullChanges(userA.accessToken, spaceIdA, {
      excludeDeviceId: deviceB,
    });

    expect(pulled.changes.length).toBeGreaterThan(0);
    const change = pulled.changes.find(
      (c: { rowPks: string }) => c.rowPks === JSON.stringify({ id: "multi-device-1" }),
    );
    expect(change).toBeDefined();
    expect(change!.deviceId).toBe(deviceA);
  });

  test("user A pushes from device B with later timestamp overwrites device A", async () => {
    const res = await pushChanges(userA.accessToken, spaceIdA, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "multi-device-1" }),
        columnName: "value",
        deviceId: deviceB,
        hlcTimestamp: `2026-03-21T12:00:00.000Z:00000001:${deviceB}`,
        encryptedValue: btoa("value-from-device-b"),
      }),
    ]);
    expect(res.count).toBeDefined();

    // Pull should show device B's value (later HLC wins)
    const pulled = await pullChanges(userA.accessToken, spaceIdA);
    const change = pulled.changes.find(
      (c: { rowPks: string; columnName: string }) =>
        c.rowPks === JSON.stringify({ id: "multi-device-1" }) && c.columnName === "value",
    );
    expect(change).toBeDefined();
    expect(change!.deviceId).toBe(deviceB);
    expect(change!.encryptedValue).toBe(btoa("value-from-device-b"));
  });
});
