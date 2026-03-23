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
  subscribeAndWait,
  waitForMessages,
  waitForConnection,
  cleanupClient,
} from "../helpers";

/**
 * Tests for Realtime reconnection behavior.
 *
 * These tests cover the exact scenarios that were previously undetected:
 * - WebSocket disconnection must be recoverable
 * - CLOSED channel status must allow re-subscription
 * - Subscription after disconnect must succeed
 * - Messages must be receivable after reconnection
 */
test.describe("sync: realtime reconnection", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-reconnect-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, vaultId);
  });

  test("can re-subscribe after explicit disconnect", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // First subscription — must succeed
    const { status: status1, channel: channel1 } = await subscribeAndWait(client, channelName);
    expect(status1).toBe("SUBSCRIBED");

    // Disconnect — simulates network loss or app backgrounding
    await client.removeChannel(channel1);
    client.realtime.disconnect();

    // Verify connection is closed
    expect(client.realtime.connectionState()).toBe("closed");

    // Explicitly reconnect the WebSocket before re-subscribing.
    // The Supabase JS SDK does not auto-reconnect after an explicit disconnect().
    client.realtime.connect();

    // Wait for the WebSocket to actually connect before subscribing
    await waitForConnection(client);

    // Re-subscribe on the same client — this is the scenario that previously failed
    // because the Realtime client's internal state wasn't properly reset
    const { status: status2, channel: channel2 } = await subscribeAndWait(client, channelName);
    expect(status2).toBe("SUBSCRIBED");

    await client.removeChannel(channel2);
    await cleanupClient(client);
  });

  test("receives messages after reconnection", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // Subscribe, then disconnect
    const { channel: channel1 } = await subscribeAndWait(client, channelName);
    await client.removeChannel(channel1);
    client.realtime.disconnect();

    // Explicitly reconnect before re-subscribing
    client.realtime.connect();
    await waitForConnection(client);

    // Reconnect and collect messages
    const collector = await subscribeToBroadcast(client, channelName);

    // Push a change — should arrive via the reconnected subscription
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "after-reconnect" }),
        columnName: "value",
        deviceId,
        encryptedValue: btoa("reconnected-value"),
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("can re-subscribe after removeAllChannels + disconnect", async () => {
    // This simulates the cleanup pattern used in haex-vault's cleanupSupabaseClient()
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // Subscribe
    const collector = await subscribeToBroadcast(client, channelName);
    expect(client.realtime.connectionState()).toBe("open");

    // Full cleanup — matches cleanupSupabaseClient() in haex-vault
    await client.realtime.removeAllChannels();
    client.realtime.disconnect();
    expect(client.realtime.connectionState()).toBe("closed");
    expect(client.realtime.channels.length).toBe(0);

    // Explicitly reconnect before re-subscribing
    client.realtime.connect();

    // Re-subscribe on the same client instance
    const { status, channel } = await subscribeAndWait(client, channelName);
    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });

  test("multiple disconnect/reconnect cycles work reliably", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    for (let cycle = 0; cycle < 3; cycle++) {
      // Subscribe
      const { status, channel } = await subscribeAndWait(client, channelName);
      expect(status).toBe("SUBSCRIBED");

      // Disconnect
      await client.removeChannel(channel);
      client.realtime.disconnect();
      expect(client.realtime.connectionState()).toBe("closed");

      // Explicitly reconnect for next cycle
      if (cycle < 2) {
        client.realtime.connect();
      }
    }

    await cleanupClient(client);
  });

  test("new client works after previous client was cleaned up", async () => {
    // Simulates the haex-vault flow: old client cleaned up, new client created
    const client1 = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    const { channel: ch1 } = await subscribeAndWait(client1, channelName);
    expect(client1.realtime.connectionState()).toBe("open");

    // Clean up client1 completely
    await client1.removeChannel(ch1);
    await cleanupClient(client1);

    // Create a brand new client — should work without interference
    const client2 = createRealtimeClient(accessToken);
    const collector = await subscribeToBroadcast(client2, channelName);

    // Push and verify broadcast arrives on new client
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "new-client-test" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client2.removeChannel(collector.channel);
    await cleanupClient(client2);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
