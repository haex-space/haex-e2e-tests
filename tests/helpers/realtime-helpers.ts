// tests/helpers/realtime-helpers.ts
//
// Shared helpers for Supabase Realtime E2E tests.
// Provides typed client creation, subscription management, and broadcast utilities.

import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.SYNC_SERVER_URL || "http://sync-kong:8000";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

export function getSupabaseUrl(): string {
  return SUPABASE_URL;
}

export function getSupabaseAnonKey(): string {
  return SUPABASE_ANON_KEY;
}

/**
 * Channel status types from Supabase Realtime
 */
export type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

/**
 * Collected broadcast messages for assertions.
 */
export interface BroadcastCollector {
  messages: unknown[];
  channel: RealtimeChannel;
}

/**
 * Creates an authenticated Supabase client for Realtime testing.
 * Uses persistSession: false to match the haex-vault client configuration.
 */
export function createRealtimeClient(accessToken: string): SupabaseClient {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
    },
    realtime: {
      timeout: 15000,
      heartbeatIntervalMs: 5000,
    },
  });
  client.realtime.setAuth(accessToken);
  return client;
}

/**
 * Subscribes to a broadcast channel and waits for the subscription to settle.
 * Returns the final status — does NOT accept CHANNEL_ERROR as success.
 *
 * @param timeoutMs - How long to wait for SUBSCRIBED before failing (default 10s)
 */
export async function subscribeAndWait(
  client: SupabaseClient,
  channelName: string,
  onBroadcast?: (event: string, payload: unknown) => void,
  timeoutMs = 10000,
  isPrivate = true,
): Promise<{ status: ChannelStatus; channel: RealtimeChannel }> {
  const channel = client
    .channel(channelName, { config: { private: isPrivate } })
    .on("broadcast", { event: "INSERT" }, (payload) => {
      onBroadcast?.("INSERT", payload);
    })
    .on("broadcast", { event: "UPDATE" }, (payload) => {
      onBroadcast?.("UPDATE", payload);
    });

  const status = await new Promise<ChannelStatus>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve("TIMED_OUT");
    }, timeoutMs);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        resolve(status as ChannelStatus);
      }
    });
  });

  return { status, channel };
}

/**
 * Subscribes to a broadcast channel and collects all received messages.
 * Strict: throws if subscription does not reach SUBSCRIBED status.
 */
export async function subscribeToBroadcast(
  client: SupabaseClient,
  channelName: string,
  timeoutMs = 10000,
): Promise<BroadcastCollector> {
  const messages: unknown[] = [];

  const { status, channel } = await subscribeAndWait(
    client,
    channelName,
    (_event, payload) => {
      messages.push(payload);
    },
    timeoutMs,
  );

  if (status !== "SUBSCRIBED") {
    // Clean up before throwing
    await client.removeChannel(channel).catch(() => {});
    throw new Error(
      `Realtime subscription failed with status "${status}" on channel "${channelName}". ` +
      `Connection state: ${client.realtime.connectionState()}`,
    );
  }

  return { messages, channel };
}

/**
 * Waits until at least `count` messages have been collected, or times out.
 */
export async function waitForMessages(
  collector: BroadcastCollector,
  count: number,
  timeoutMs = 5000,
): Promise<unknown[]> {
  const start = Date.now();
  while (collector.messages.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return collector.messages;
}

/**
 * Cleanly disposes a Supabase client's Realtime resources.
 */
export async function cleanupClient(client: SupabaseClient): Promise<void> {
  try {
    await client.realtime.removeAllChannels();
    client.realtime.disconnect();
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Waits for the Realtime WebSocket to reach a closed/disconnected state.
 * Use after client.realtime.disconnect() since disconnect is asynchronous.
 */
export async function waitForDisconnect(
  client: SupabaseClient,
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = client.realtime.connectionState();
    if (state === "closed") {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Waits for the Realtime WebSocket to reach a connected state.
 * Use after client.realtime.connect() to ensure the socket is ready before subscribing.
 */
export async function waitForConnection(
  client: SupabaseClient,
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = client.realtime.connectionState();
    if (state === "open") {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Waits for a channel status change (e.g., waiting for CLOSED after disconnect).
 */
export function waitForChannelStatus(
  channel: RealtimeChannel,
  targetStatus: string,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);

    // Poll channel state since there's no event listener for post-subscribe status changes
    const interval = setInterval(() => {
      if (channel.state === targetStatus) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(true);
      }
    }, 100);
  });
}
