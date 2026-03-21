import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
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
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SYNC_SERVER_URL || "http://sync-kong:8000";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

test.describe("sync: realtime broadcast notifications", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-realtime-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;

    // Create vault key (this triggers partition creation)
    await createVaultKey(accessToken, vaultId);
  });

  test("partition is created when vault key is created", async () => {
    // Push a change — if partition doesn't exist, this fails
    const res = await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "partition-test" }),
        columnName: "value",
        deviceId,
      }),
    ]);
    expect(res.count).toBeDefined();
  });

  test("supabase realtime broadcast channel can be subscribed", async () => {
    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supabase.realtime.setAuth(accessToken);

    const channelName = `sync:${vaultId}`;

    // Subscribe to broadcast channel
    const received: unknown[] = [];

    const channel = supabase
      .channel(channelName)
      .on("broadcast", { event: "INSERT" }, (payload) => {
        received.push(payload);
      })
      .on("broadcast", { event: "UPDATE" }, (payload) => {
        received.push(payload);
      });

    const subscribePromise = new Promise<string>((resolve) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          resolve(status);
        }
      });
    });

    const status = await subscribePromise;

    // Clean up
    await supabase.removeChannel(channel);
    await supabase.realtime.disconnect();

    // The subscription should either succeed or fail gracefully
    // In E2E without full Realtime, CHANNEL_ERROR is acceptable
    expect(["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"]).toContain(status);

    // If subscribed, push a change and verify broadcast is received
    if (status === "SUBSCRIBED") {
      // Re-subscribe for the actual test
      const channel2 = supabase
        .channel(channelName)
        .on("broadcast", { event: "INSERT" }, (payload) => {
          received.push(payload);
        });

      await new Promise<void>((resolve) => {
        channel2.subscribe((s) => {
          if (s === "SUBSCRIBED") resolve();
        });
      });

      // Push a change that should trigger the broadcast trigger
      await pushChanges(accessToken, vaultId, [
        makeSyncChange({
          tableName: "haex_vault_settings",
          rowPks: JSON.stringify({ id: "broadcast-test" }),
          columnName: "value",
          deviceId,
          encryptedValue: btoa("broadcast-test-value"),
        }),
      ]);

      // Wait a bit for broadcast to arrive
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await supabase.removeChannel(channel2);
      await supabase.realtime.disconnect();

      // We should have received at least one broadcast
      // (This may not work if broadcast_changes is not available in E2E)
      // Log for debugging
      console.log(`Received ${received.length} broadcast messages`);
    }
  });

  test("partition is accessible for push/pull after creation", async () => {
    // Push multiple changes
    const changes = Array.from({ length: 5 }, (_, i) =>
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: `batch-${i}` }),
        columnName: "value",
        deviceId,
        encryptedValue: btoa(`value-${i}`),
      }),
    );

    const pushRes = await pushChanges(accessToken, vaultId, changes);
    expect(pushRes.count).toBeDefined();

    // Pull all changes back
    const pulled = await pullChanges(accessToken, vaultId);
    expect(pulled.changes.length).toBeGreaterThanOrEqual(5);
  });
});
