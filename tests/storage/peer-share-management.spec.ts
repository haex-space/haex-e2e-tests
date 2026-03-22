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

/**
 * Create a CRDT change for haex_peer_shares table.
 * This simulates what the vault app does when adding a share.
 */
function makeShareChange(opts: {
  shareId: string;
  spaceId: string;
  deviceEndpointId: string;
  name: string;
  localPath: string;
  deviceId: string;
  hlcTimestamp?: string;
  columnName: string;
  encryptedValue: string;
}) {
  return makeSyncChange({
    tableName: "haex_peer_shares",
    rowPks: JSON.stringify({ id: opts.shareId }),
    columnName: opts.columnName,
    deviceId: opts.deviceId,
    hlcTimestamp: opts.hlcTimestamp || `2026-03-21T14:00:00.000Z:00000001:${opts.deviceId}`,
    encryptedValue: opts.encryptedValue,
  });
}

/**
 * Push a complete peer share (all columns) as a batch of CRDT changes.
 */
async function pushPeerShare(
  token: string,
  vaultId: string,
  share: {
    id: string;
    spaceId: string;
    deviceEndpointId: string;
    name: string;
    localPath: string;
  },
  deviceId: string,
  timestamp?: string,
) {
  const ts = timestamp || `2026-03-21T14:00:00.000Z:00000001:${deviceId}`;
  const rowPks = JSON.stringify({ id: share.id });

  const changes = [
    { columnName: "space_id", value: share.spaceId },
    { columnName: "device_endpoint_id", value: share.deviceEndpointId },
    { columnName: "name", value: share.name },
    { columnName: "local_path", value: share.localPath },
  ].map((col) =>
    makeSyncChange({
      tableName: "haex_peer_shares",
      rowPks,
      columnName: col.columnName,
      deviceId,
      hlcTimestamp: ts,
      encryptedValue: btoa(col.value),
    }),
  );

  return pushChanges(token, vaultId, changes);
}

/**
 * Push a tombstone (deletion) for a peer share.
 */
async function deletePeerShare(
  token: string,
  vaultId: string,
  shareId: string,
  deviceId: string,
  timestamp?: string,
) {
  const ts = timestamp || `2026-03-21T15:00:00.000Z:00000001:${deviceId}`;

  // Push a tombstone change (haex_tombstone = 1)
  return pushChanges(token, vaultId, [
    makeSyncChange({
      tableName: "haex_peer_shares",
      rowPks: JSON.stringify({ id: shareId }),
      columnName: "haex_tombstone",
      deviceId,
      hlcTimestamp: ts,
      encryptedValue: btoa("1"),
    }),
  ]);
}

test.describe("storage: peer share management via sync", () => {
  test.describe.configure({ mode: "serial" });

  // Two users with separate vaults
  let userA: { accessToken: string; userId: string };
  let userB: { accessToken: string; userId: string };
  const vaultIdA = crypto.randomUUID();
  const vaultIdB = crypto.randomUUID();
  const deviceA = `device-a-${Date.now()}`;
  const deviceB = `device-b-${Date.now()}`;
  const endpointA = crypto.randomBytes(32).toString("hex");
  const endpointB = crypto.randomBytes(32).toString("hex");

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    userA = await createAdminUser();
    userB = await createAdminUser();

    await createVaultKey(userA.accessToken, vaultIdA);
    await createVaultKey(userB.accessToken, vaultIdB);
  });

  // =====================================================================
  // Basic Share CRUD
  // =====================================================================

  test("user A can create a peer share via sync push", async () => {
    const shareId = crypto.randomUUID();

    const res = await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareId,
        spaceId: "personal",
        deviceEndpointId: endpointA,
        name: "Downloads",
        localPath: "/home/user/Downloads",
      },
      deviceA,
    );

    expect(res.count).toBeDefined();
  });

  test("user A can pull back their own shares", async () => {
    const pulled = await pullChanges(userA.accessToken, vaultIdA);
    expect(pulled.changes.length).toBeGreaterThan(0);

    const shareChanges = pulled.changes.filter(
      (c: { tableName: string }) => c.tableName === "haex_peer_shares",
    );
    expect(shareChanges.length).toBeGreaterThan(0);
  });

  test("user B cannot see user A's shares", async () => {
    // User B pulls from their own vault — should not contain A's data
    const pulled = await pullChanges(userB.accessToken, vaultIdB);
    const shareChanges = pulled.changes.filter(
      (c: { tableName: string }) => c.tableName === "haex_peer_shares",
    );
    expect(shareChanges.length).toBe(0);
  });

  // =====================================================================
  // Multi-Device Share Sync (Same User)
  // =====================================================================

  test("shares created on device A are visible when pulling from device B", async () => {
    const shareId = crypto.randomUUID();

    // Push from device A
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareId,
        spaceId: "personal",
        deviceEndpointId: endpointA,
        name: "Photos",
        localPath: "/home/user/Photos",
      },
      deviceA,
      `2026-03-21T14:10:00.000Z:00000001:${deviceA}`,
    );

    // Pull from "device B" (same user, different excludeDeviceId)
    const pulled = await pullChanges(userA.accessToken, vaultIdA, {
      excludeDeviceId: deviceB,
    });

    const photoChanges = pulled.changes.filter(
      (c: { tableName: string; rowPks: string }) =>
        c.tableName === "haex_peer_shares" && c.rowPks === JSON.stringify({ id: shareId }),
    );
    expect(photoChanges.length).toBeGreaterThan(0);
  });

  // =====================================================================
  // Share Deletion
  // =====================================================================

  test("user A can delete their own share", async () => {
    const shareId = crypto.randomUUID();

    // Create share
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareId,
        spaceId: "personal",
        deviceEndpointId: endpointA,
        name: "ToDelete",
        localPath: "/tmp/to-delete",
      },
      deviceA,
      `2026-03-21T14:20:00.000Z:00000001:${deviceA}`,
    );

    // Delete share (push tombstone)
    const delRes = await deletePeerShare(
      userA.accessToken,
      vaultIdA,
      shareId,
      deviceA,
      `2026-03-21T14:21:00.000Z:00000001:${deviceA}`,
    );
    expect(delRes.count).toBeDefined();
  });

  test("share deleted on device A is tombstoned when pulled from device B", async () => {
    const shareId = crypto.randomUUID();

    // Create on device A
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareId,
        spaceId: "personal",
        deviceEndpointId: endpointA,
        name: "CrossDeviceDelete",
        localPath: "/tmp/cross-delete",
      },
      deviceA,
      `2026-03-21T14:30:00.000Z:00000001:${deviceA}`,
    );

    // Delete from device B (same user, different device)
    const delRes = await deletePeerShare(
      userA.accessToken,
      vaultIdA,
      shareId,
      deviceB,
      `2026-03-21T14:31:00.000Z:00000001:${deviceB}`,
    );
    expect(delRes.count).toBeDefined();

    // Pull and verify tombstone exists
    const pulled = await pullChanges(userA.accessToken, vaultIdA);
    const tombstoneChanges = pulled.changes.filter(
      (c: { tableName: string; rowPks: string; columnName: string }) =>
        c.tableName === "haex_peer_shares" &&
        c.rowPks === JSON.stringify({ id: shareId }) &&
        c.columnName === "haex_tombstone",
    );
    expect(tombstoneChanges.length).toBeGreaterThan(0);
  });

  // =====================================================================
  // Device Registration via Sync
  // =====================================================================

  test("device registration data syncs between devices", async () => {
    const deviceRegId = crypto.randomUUID();

    // Push device registration data (haex_space_devices-like data in vault settings)
    const res = await pushChanges(userA.accessToken, vaultIdA, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: deviceRegId }),
        columnName: "value",
        deviceId: deviceA,
        hlcTimestamp: `2026-03-21T14:40:00.000Z:00000001:${deviceA}`,
        encryptedValue: btoa(JSON.stringify({
          endpointId: endpointA,
          deviceName: "Desktop",
          relayUrl: "https://relay.sync.haex.space",
        })),
      }),
    ]);
    expect(res.count).toBeDefined();

    // Pull from device B — should see device A's registration
    const pulled = await pullChanges(userA.accessToken, vaultIdA, {
      excludeDeviceId: deviceB,
    });

    const regChanges = pulled.changes.filter(
      (c: { rowPks: string }) => c.rowPks === JSON.stringify({ id: deviceRegId }),
    );
    expect(regChanges.length).toBeGreaterThan(0);
  });

  // =====================================================================
  // Multiple Shares in Different Spaces
  // =====================================================================

  test("shares are isolated per space", async () => {
    const spacePersonal = "personal";
    const spaceWork = "work-space-" + Date.now();
    const sharePersonal = crypto.randomUUID();
    const shareWork = crypto.randomUUID();

    // Create share in personal space
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: sharePersonal,
        spaceId: spacePersonal,
        deviceEndpointId: endpointA,
        name: "PersonalDocs",
        localPath: "/home/user/personal",
      },
      deviceA,
      `2026-03-21T14:50:00.000Z:00000001:${deviceA}`,
    );

    // Create share in work space
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareWork,
        spaceId: spaceWork,
        deviceEndpointId: endpointA,
        name: "WorkDocs",
        localPath: "/home/user/work",
      },
      deviceA,
      `2026-03-21T14:51:00.000Z:00000001:${deviceA}`,
    );

    // Pull all — both should be there with different space_ids
    const pulled = await pullChanges(userA.accessToken, vaultIdA);

    const personalShares = pulled.changes.filter(
      (c: { tableName: string; rowPks: string; columnName: string }) =>
        c.tableName === "haex_peer_shares" &&
        c.rowPks === JSON.stringify({ id: sharePersonal }) &&
        c.columnName === "space_id",
    );
    expect(personalShares.length).toBe(1);

    const workShares = pulled.changes.filter(
      (c: { tableName: string; rowPks: string; columnName: string }) =>
        c.tableName === "haex_peer_shares" &&
        c.rowPks === JSON.stringify({ id: shareWork }) &&
        c.columnName === "space_id",
    );
    expect(workShares.length).toBe(1);
  });

  // =====================================================================
  // Conflict Resolution for Shares
  // =====================================================================

  test("last-write-wins for share name updates across devices", async () => {
    const shareId = crypto.randomUUID();

    // Device A creates share
    await pushPeerShare(
      userA.accessToken,
      vaultIdA,
      {
        id: shareId,
        spaceId: "personal",
        deviceEndpointId: endpointA,
        name: "OriginalName",
        localPath: "/tmp/lww-test",
      },
      deviceA,
      `2026-03-21T15:00:00.000Z:00000001:${deviceA}`,
    );

    // Device A renames share (later timestamp)
    await pushChanges(userA.accessToken, vaultIdA, [
      makeSyncChange({
        tableName: "haex_peer_shares",
        rowPks: JSON.stringify({ id: shareId }),
        columnName: "name",
        deviceId: deviceA,
        hlcTimestamp: `2026-03-21T15:01:00.000Z:00000001:${deviceA}`,
        encryptedValue: btoa("RenamedByA"),
      }),
    ]);

    // Device B also renames (even later timestamp — this wins)
    await pushChanges(userA.accessToken, vaultIdA, [
      makeSyncChange({
        tableName: "haex_peer_shares",
        rowPks: JSON.stringify({ id: shareId }),
        columnName: "name",
        deviceId: deviceB,
        hlcTimestamp: `2026-03-21T15:02:00.000Z:00000001:${deviceB}`,
        encryptedValue: btoa("RenamedByB"),
      }),
    ]);

    // Pull — device B's name should win (later HLC)
    const pulled = await pullChanges(userA.accessToken, vaultIdA);
    const nameChange = pulled.changes.find(
      (c: { tableName: string; rowPks: string; columnName: string }) =>
        c.tableName === "haex_peer_shares" &&
        c.rowPks === JSON.stringify({ id: shareId }) &&
        c.columnName === "name",
    );

    expect(nameChange).toBeDefined();
    expect(nameChange!.encryptedValue).toBe(btoa("RenamedByB"));
    expect(nameChange!.deviceId).toBe(deviceB);
  });
});
