import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  pushChanges,
  makeSyncChange,
  createRealtimeClient,
  subscribeToBroadcast,
  waitForMessages,
  cleanupClient,
  subscribeAndWait,
} from "../helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

test.describe("sync: realtime broadcast", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceIdA = `e2e-device-a-${Date.now()}`;
  let client: SupabaseClient;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;

    await createVaultKey(accessToken, vaultId);
  });

  test.afterAll(async () => {
    if (client) await cleanupClient(client);
  });

  test("subscription must reach SUBSCRIBED status", async () => {
    client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    const { status, channel } = await subscribeAndWait(client, channelName);

    // Strict: SUBSCRIBED is the only acceptable outcome.
    // CHANNEL_ERROR means the Realtime infrastructure is broken.
    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
  });

  test("push from device A triggers broadcast received by device B", async () => {
    // Device B subscribes and listens
    const clientB = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;
    const collector = await subscribeToBroadcast(clientB, channelName);

    // Device A pushes a change — the DB trigger should broadcast it
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "broadcast-cross-device" }),
        columnName: "value",
        deviceId: deviceIdA,
        encryptedValue: btoa("hello-from-device-a"),
      }),
    ]);

    // Wait for Device B to receive the broadcast
    const messages = await waitForMessages(collector, 1, 5000);

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple rapid pushes result in broadcast messages", async () => {
    const clientB = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;
    const collector = await subscribeToBroadcast(clientB, channelName);

    // Push 5 changes rapidly
    const changes = Array.from({ length: 5 }, (_, i) =>
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: `rapid-${i}` }),
        columnName: "value",
        deviceId: deviceIdA,
        encryptedValue: btoa(`rapid-value-${i}`),
      }),
    );
    await pushChanges(accessToken, vaultId, changes);

    // We should receive at least one broadcast (changes may be batched by the trigger)
    const messages = await waitForMessages(collector, 1, 5000);

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("different vaults do not receive each other's broadcasts", async () => {
    // Create a second vault
    const otherVaultId = crypto.randomUUID();
    await createVaultKey(accessToken, otherVaultId);

    const clientB = createRealtimeClient(accessToken);
    const collector = await subscribeToBroadcast(clientB, `sync:${otherVaultId}`);

    // Push to the FIRST vault — should NOT appear on otherVault's channel
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "isolation-test" }),
        columnName: "value",
        deviceId: deviceIdA,
      }),
    ]);

    // Wait briefly — no message should arrive
    await new Promise((r) => setTimeout(r, 2000));

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(collector.messages.length).toBe(0);
  });
});
