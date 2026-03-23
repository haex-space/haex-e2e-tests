import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  checkSyncServerHealth,
  createAdminUser,
  createAdminUserWithIdentity,
  createVaultKey,
  deleteVault,
  createSpace,
  addSpaceMember,
  removeSpaceMember,
  deleteSpace,
  pushChanges,
  makeSyncChange,
  insertBroadcastMessage,
  createRealtimeClient,
  subscribeToBroadcast,
  waitForMessages,
  cleanupClient,
  subscribeAndWait,
  getSyncServerUrl,
} from "../helpers";
import { createClient } from "@supabase/supabase-js";

// =============================================================================
// Broadcast Delivery Tests
// =============================================================================

test.describe("sync: realtime broadcast delivery", () => {
  test.describe.configure({ mode: "serial" });

  let accessToken: string;
  const vaultId = crypto.randomUUID();
  const deviceIdA = `e2e-device-a-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
    await createVaultKey(accessToken, vaultId);
  });

  test("subscription must reach SUBSCRIBED status", async () => {
    const client = createRealtimeClient(accessToken);
    const { status, channel } = await subscribeAndWait(client, `sync:${vaultId}`);

    expect(status).toBe("SUBSCRIBED");

    await client.removeChannel(channel);
    await cleanupClient(client);
  });

  test("push from device A triggers broadcast received by device B", async () => {
    const clientB = createRealtimeClient(accessToken);
    const collector = await subscribeToBroadcast(clientB, `sync:${vaultId}`);

    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "haex_vault_settings",
        rowPks: JSON.stringify({ id: "broadcast-cross-device" }),
        columnName: "value",
        deviceId: deviceIdA,
        encryptedValue: btoa("hello-from-device-a"),
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple rapid pushes result in broadcast messages", async () => {
    const clientB = createRealtimeClient(accessToken);
    const collector = await subscribeToBroadcast(clientB, `sync:${vaultId}`);

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

    const messages = await waitForMessages(collector, 1, 5000);

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("different vaults do not receive each other's broadcasts", async () => {
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

    await new Promise((r) => setTimeout(r, 2000));

    await clientB.removeChannel(collector.channel);
    await cleanupClient(clientB);

    expect(collector.messages.length).toBe(0);
  });

  test("broadcast payload contains only operation type, no record data", async () => {
    const client = createRealtimeClient(accessToken);
    const collector = await subscribeToBroadcast(client, `sync:${vaultId}`);

    await pushChanges(accessToken, vaultId, [
      makeSyncChange({
        tableName: "secret_table",
        rowPks: JSON.stringify({ id: "payload-check" }),
        columnName: "secret_column",
        deviceId: deviceIdA,
        encryptedValue: btoa("super-secret-value"),
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Verify the payload does NOT contain sensitive data
    const payload = JSON.stringify(messages[0]);
    expect(payload).not.toContain("secret_table");
    expect(payload).not.toContain("secret_column");
    expect(payload).not.toContain("super-secret-value");
    expect(payload).not.toContain("payload-check");
    expect(payload).not.toContain(deviceIdA);
  });
});

// =============================================================================
// Personal Vault Authorization Tests
// =============================================================================

test.describe("sync: broadcast authorization for personal vaults", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  let strangerToken: string;
  const vaultId = crypto.randomUUID();
  const deviceId = `e2e-auth-${Date.now()}`;

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, stranger] = await Promise.all([
      createAdminUser(),
      createAdminUser(),
    ]);
    ownerToken = owner.accessToken;
    strangerToken = stranger.accessToken;

    await createVaultKey(ownerToken, vaultId);
  });

  test("vault owner can subscribe and receive broadcasts", async () => {
    const client = createRealtimeClient(ownerToken);
    const collector = await subscribeToBroadcast(client, `sync:${vaultId}`);

    await pushChanges(ownerToken, vaultId, [
      makeSyncChange({
        tableName: "test",
        rowPks: JSON.stringify({ id: "owner-auth" }),
        columnName: "value",
        deviceId,
      }),
    ]);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("stranger cannot subscribe to another user's vault channel", async () => {
    const client = createRealtimeClient(strangerToken);
    const { status } = await subscribeAndWait(client, `sync:${vaultId}`);

    await cleanupClient(client);

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("user with a different vault cannot subscribe to this vault", async () => {
    // Stranger has their own vault, but that doesn't grant access to owner's vault
    const strangerVaultId = crypto.randomUUID();
    await createVaultKey(strangerToken, strangerVaultId);

    const client = createRealtimeClient(strangerToken);
    const { status } = await subscribeAndWait(client, `sync:${vaultId}`);

    await cleanupClient(client);

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("unauthenticated client cannot subscribe to private channel", async () => {
    const SUPABASE_URL = getSyncServerUrl();
    const ANON_KEY =
      process.env.SUPABASE_ANON_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

    // Create client WITHOUT setting auth token
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
    });

    const channel = client
      .channel(`sync:${vaultId}`, { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, () => {});

    const status = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMED_OUT"), 10000);
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
          clearTimeout(timer);
          resolve(s);
        }
      });
    });

    await client.removeChannel(channel);
    client.realtime.disconnect();

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("deleted vault channel rejects subscription", async () => {
    // Create a temporary vault, then delete it
    const tempVaultId = crypto.randomUUID();
    await createVaultKey(ownerToken, tempVaultId);

    // Verify subscription works before deletion
    const client1 = createRealtimeClient(ownerToken);
    const { status: before } = await subscribeAndWait(client1, `sync:${tempVaultId}`);
    await cleanupClient(client1);
    expect(before).toBe("SUBSCRIBED");

    // Delete the vault
    await deleteVault(ownerToken, tempVaultId);

    // Subscription should now be rejected
    const client2 = createRealtimeClient(ownerToken);
    const { status: after } = await subscribeAndWait(client2, `sync:${tempVaultId}`);
    await cleanupClient(client2);

    expect(after).not.toBe("SUBSCRIBED");
  });
});

// =============================================================================
// Shared Space Authorization Tests
// =============================================================================

test.describe("sync: broadcast authorization for shared spaces", () => {
  test.describe.configure({ mode: "serial" });

  let ownerToken: string;
  let memberToken: string;
  let memberPublicKey: string;
  let readerToken: string;
  let readerPublicKey: string;
  let outsiderToken: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const [owner, member, reader, outsider] = await Promise.all([
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
      createAdminUserWithIdentity(),
    ]);

    ownerToken = owner.accessToken;
    memberToken = member.accessToken;
    memberPublicKey = member.publicKey;
    readerToken = reader.accessToken;
    readerPublicKey = reader.publicKey;
    outsiderToken = outsider.accessToken;

    // Owner creates a space
    const createRes = await createSpace(ownerToken, spaceId, "Broadcast Auth Space");
    expect(createRes.status).toBe(201);

    // Owner invites member (write access) and reader (read-only)
    const [inviteMember, inviteReader] = await Promise.all([
      addSpaceMember(ownerToken, spaceId, memberPublicKey, "Member", "member"),
      addSpaceMember(ownerToken, spaceId, readerPublicKey, "Reader", "reader"),
    ]);
    expect(inviteMember.status).toBe(201);
    expect(inviteReader.status).toBe(201);
  });

  test.afterAll(async () => {
    await deleteSpace(ownerToken, spaceId).catch(() => {});
  });

  test("space owner can subscribe", async () => {
    const client = createRealtimeClient(ownerToken);
    const { status } = await subscribeAndWait(client, `sync:${spaceId}`);
    await cleanupClient(client);

    expect(status).toBe("SUBSCRIBED");
  });

  test("space member can subscribe", async () => {
    const client = createRealtimeClient(memberToken);
    const { status } = await subscribeAndWait(client, `sync:${spaceId}`);
    await cleanupClient(client);

    expect(status).toBe("SUBSCRIBED");
  });

  test("space reader can subscribe (read-only still receives broadcasts)", async () => {
    const client = createRealtimeClient(readerToken);
    const { status } = await subscribeAndWait(client, `sync:${spaceId}`);
    await cleanupClient(client);

    expect(status).toBe("SUBSCRIBED");
  });

  test("outsider cannot subscribe to space channel", async () => {
    const client = createRealtimeClient(outsiderToken);
    const { status } = await subscribeAndWait(client, `sync:${spaceId}`);
    await cleanupClient(client);

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("space member receives broadcast when changes occur", async () => {
    const client = createRealtimeClient(memberToken);
    const collector = await subscribeToBroadcast(client, `sync:${spaceId}`);

    // Insert broadcast directly (space pushes require ECDSA signatures)
    await insertBroadcastMessage(`sync:${spaceId}`);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("reader receives broadcast when changes occur", async () => {
    const client = createRealtimeClient(readerToken);
    const collector = await subscribeToBroadcast(client, `sync:${spaceId}`);

    await insertBroadcastMessage(`sync:${spaceId}`);

    const messages = await waitForMessages(collector, 1, 5000);

    await client.removeChannel(collector.channel);
    await cleanupClient(client);

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("vault-key holder for different vault cannot subscribe to space", async () => {
    // Outsider creates their own personal vault — that should NOT grant space access
    const outsiderVaultId = crypto.randomUUID();
    await createVaultKey(outsiderToken, outsiderVaultId);

    const client = createRealtimeClient(outsiderToken);
    const { status } = await subscribeAndWait(client, `sync:${spaceId}`);
    await cleanupClient(client);

    expect(status).not.toBe("SUBSCRIBED");
  });

  test("removed member can no longer subscribe to space channel", async () => {
    // Create a temporary member, verify access, remove, verify no access
    const tempMember = await createAdminUserWithIdentity();
    const inviteRes = await addSpaceMember(
      ownerToken, spaceId, tempMember.publicKey, "Temp Member", "member",
    );
    expect(inviteRes.status).toBe(201);

    // Verify access before removal
    const client1 = createRealtimeClient(tempMember.accessToken);
    const { status: before } = await subscribeAndWait(client1, `sync:${spaceId}`);
    await cleanupClient(client1);
    expect(before).toBe("SUBSCRIBED");

    // Remove the member
    const removeRes = await removeSpaceMember(ownerToken, spaceId, tempMember.publicKey);
    expect(removeRes.status).toBe(200);

    // Verify access is revoked after removal
    const client2 = createRealtimeClient(tempMember.accessToken);
    const { status: after } = await subscribeAndWait(client2, `sync:${spaceId}`);
    await cleanupClient(client2);

    expect(after).not.toBe("SUBSCRIBED");
  });

  test("outsider cannot receive broadcasts even with public channel config", async () => {
    // Malicious client tries to bypass private channel by subscribing as public
    const SUPABASE_URL = getSyncServerUrl();
    const ANON_KEY =
      process.env.SUPABASE_ANON_KEY ||
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
    });
    client.realtime.setAuth(outsiderToken);

    // Subscribe WITHOUT private:true — trying to bypass authorization
    const messages: unknown[] = [];
    const channel = client
      .channel(`sync:${spaceId}`)
      .on("broadcast", { event: "INSERT" }, (payload) => {
        messages.push(payload);
      });

    await new Promise<void>((resolve) => {
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") resolve();
      });
    });

    // Insert a broadcast that should NOT reach the outsider
    await insertBroadcastMessage(`sync:${spaceId}`);

    // Wait to see if anything leaks
    await new Promise((r) => setTimeout(r, 3000));

    await client.removeChannel(channel);
    client.realtime.disconnect();

    // No messages should have been received
    expect(messages.length).toBe(0);
  });
});
