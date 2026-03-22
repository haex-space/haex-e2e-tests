import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  cleanupClient,
} from "../helpers";

/**
 * Tests for Realtime channel lifecycle management.
 *
 * These cover the channel create/subscribe/unsubscribe/dispose patterns
 * used in haex-vault, ensuring no resource leaks or stale state.
 */
test.describe("sync: realtime channel lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-lifecycle-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, vaultId);
  });

  test("unsubscribe removes channel from client", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    const { channel } = await subscribeAndWait(client, channelName);
    expect(client.realtime.channels.length).toBe(1);

    await client.removeChannel(channel);
    expect(client.realtime.channels.length).toBe(0);

    await cleanupClient(client);
  });

  test("re-subscribe after unsubscribe works", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // Subscribe
    const { status: s1, channel: ch1 } = await subscribeAndWait(client, channelName);
    expect(s1).toBe("SUBSCRIBED");

    // Unsubscribe
    await client.removeChannel(ch1);

    // Re-subscribe on the same channel name
    const { status: s2, channel: ch2 } = await subscribeAndWait(client, channelName);
    expect(s2).toBe("SUBSCRIBED");

    await client.removeChannel(ch2);
    await cleanupClient(client);
  });

  test("messages only arrive on active subscription", async () => {
    const client = createRealtimeClient(accessToken);
    const channelName = `sync:${vaultId}`;

    // Subscribe and collect
    const collector = await subscribeToBroadcast(client, channelName);

    // Unsubscribe
    await client.removeChannel(collector.channel);

    // Push while unsubscribed — should NOT be received
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "while-unsubscribed" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    await new Promise((r) => setTimeout(r, 1500));

    // No messages should have arrived after unsubscribe
    const messagesWhileUnsubscribed = collector.messages.length;

    // Re-subscribe with fresh collector
    const collector2 = await subscribeToBroadcast(client, channelName);

    // Push while subscribed — SHOULD be received
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "while-subscribed" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    const messages = await waitForMessages(collector2, 1, 5000);

    await client.removeChannel(collector2.channel);
    await cleanupClient(client);

    expect(messagesWhileUnsubscribed).toBe(0);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple channels on same client work independently", async () => {
    // Create two vaults with separate channels
    const vaultId2 = crypto.randomUUID();
    await createVaultKey(accessToken, vaultId2);

    const client = createRealtimeClient(accessToken);

    const collector1 = await subscribeToBroadcast(client, `sync:${vaultId}`);
    const collector2 = await subscribeToBroadcast(client, `sync:${vaultId2}`);

    expect(client.realtime.channels.length).toBe(2);

    // Push to vault1 only
    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "multi-channel-v1" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    // Push to vault2 only
    await pushChanges(accessToken, vaultId2, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "multi-channel-v2" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    await waitForMessages(collector1, 1, 5000);
    await waitForMessages(collector2, 1, 5000);

    await client.removeChannel(collector1.channel);
    await client.removeChannel(collector2.channel);
    await cleanupClient(client);

    // Each channel should have received its own vault's messages
    expect(collector1.messages.length).toBeGreaterThanOrEqual(1);
    expect(collector2.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("removeAllChannels cleans up all subscriptions", async () => {
    const client = createRealtimeClient(accessToken);

    // Create multiple channels
    const { channel: ch1 } = await subscribeAndWait(client, `sync:${vaultId}`);
    const vaultId2 = crypto.randomUUID();
    await createVaultKey(accessToken, vaultId2);
    const { channel: ch2 } = await subscribeAndWait(client, `sync:${vaultId2}`);

    expect(client.realtime.channels.length).toBe(2);

    // Remove all at once
    await client.realtime.removeAllChannels();
    expect(client.realtime.channels.length).toBe(0);

    // Should still be able to subscribe after removeAllChannels
    const { status, channel } = await subscribeAndWait(client, `sync:${vaultId}`);
    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });
});
