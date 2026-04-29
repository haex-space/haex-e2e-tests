import * as crypto from "crypto";
import { test, expect } from "../fixtures";
import {
  createAdminUser,
  createAdminUserWithIdentity,
  toAuthContext,
  createSpace,
  addSpaceMember,
  generateSpaceId,
  type AuthContext,
} from "../helpers";
import {
  uploadKeyPackages,
  sendMlsMessage,
  fetchMlsMessages,
  requestRejoin,
  submitExternalCommit,
  buildSignedUcan,
} from "../helpers/mls-helpers";

/**
 * MLS Rejoin E2E Tests — Server Path
 *
 * Tests the External Commit rejoin flow via the sync server API:
 * 1. GroupInfo storage when commits are sent
 * 2. Rejoin endpoint returns stored GroupInfo
 * 3. External Commit submission and distribution
 * 4. KeyPackage upload and management
 * 5. Access control (non-members rejected)
 *
 * These are API-level tests (no UI). They verify the server endpoints
 * work correctly for the rejoin flow.
 */

test.describe("MLS: External Commit rejoin via server", () => {
  test.describe.configure({ mode: "serial" });

  let admin: Awaited<ReturnType<typeof createAdminUserWithIdentity>>;
  let adminAuth: AuthContext;
  let member: Awaited<ReturnType<typeof createAdminUser>>;
  let memberAuth: AuthContext;
  let spaceId: string;

  test.beforeAll(async () => {
    // Create two users: admin (space owner) and member
    admin = await createAdminUserWithIdentity();
    adminAuth = toAuthContext(admin);

    member = await createAdminUser();
    memberAuth = toAuthContext(member);

    // Create a shared space and add member
    spaceId = generateSpaceId();
    const createRes = await createSpace(adminAuth, spaceId, "MLS Rejoin Test");
    expect(createRes.status).toBe(201);

    const addRes = await addSpaceMember(adminAuth, spaceId, member.did, "Test Member", "space/write");
    expect(addRes.status).toBe(201);
  });

  test("upload key packages for member", async () => {
    const res = await uploadKeyPackages(memberAuth, spaceId, 10);
    expect(res.status).toBe(201);
  });

  test("send commit with GroupInfo stores it for rejoin", async () => {
    const commitPayload = crypto.randomBytes(128).toString("base64");
    const groupInfoPayload = crypto.randomBytes(256).toString("base64");

    const res = await sendMlsMessage(adminAuth, spaceId, commitPayload, "commit", {
      epoch: 1,
      groupInfo: groupInfoPayload,
    });
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.messageId).toBeDefined();
  });

  test("rejoin returns stored GroupInfo", async () => {
    const res = await requestRejoin(memberAuth, spaceId);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.groupInfo).toBeDefined();
    expect(typeof data.groupInfo).toBe("string");
    expect(data.epoch).toBe(1);
  });

  test("rejoin returns 404 for space without GroupInfo", async () => {
    const emptySpaceId = generateSpaceId();
    const createRes = await createSpace(adminAuth, emptySpaceId, "Empty Space");
    expect(createRes.status).toBe(201);

    const addRes = await addSpaceMember(adminAuth, emptySpaceId, member.did, "Member", "space/write");
    expect(addRes.status).toBe(201);

    const res = await requestRejoin(memberAuth, emptySpaceId);
    expect(res.status).toBe(404);
  });

  test("submit external commit stores message and returns messageId", async () => {
    const commitPayload = crypto.randomBytes(128).toString("base64");

    const res = await submitExternalCommit(memberAuth, spaceId, commitPayload);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.messageId).toBeDefined();
    expect(typeof data.messageId).toBe("number");
  });

  test("external commit appears in message list", async () => {
    const res = await fetchMlsMessages(adminAuth, spaceId);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.messages.length).toBeGreaterThanOrEqual(2); // original commit + external commit

    const lastMessage = data.messages[data.messages.length - 1];
    expect(lastMessage.messageType).toBe("commit");
  });

  test("updated GroupInfo replaces old one on subsequent commit", async () => {
    const newGroupInfo = crypto.randomBytes(300).toString("base64");

    const res = await sendMlsMessage(adminAuth, spaceId, crypto.randomBytes(64).toString("base64"), "commit", {
      epoch: 2,
      groupInfo: newGroupInfo,
    });
    expect(res.status).toBe(201);

    // Rejoin should now return the updated GroupInfo with epoch 2
    const rejoinRes = await requestRejoin(memberAuth, spaceId);
    expect(rejoinRes.status).toBe(200);

    const data = await rejoinRes.json();
    expect(data.epoch).toBe(2);
    expect(data.groupInfo).toBe(newGroupInfo);
  });

  test("application messages do not update GroupInfo", async () => {
    const appPayload = crypto.randomBytes(64).toString("base64");

    const res = await sendMlsMessage(adminAuth, spaceId, appPayload, "application", {
      epoch: 3,
      groupInfo: crypto.randomBytes(100).toString("base64"),
    });
    expect(res.status).toBe(201);

    // GroupInfo should still be from epoch 2 (commits only)
    const rejoinRes = await requestRejoin(memberAuth, spaceId);
    const data = await rejoinRes.json();
    expect(data.epoch).toBe(2); // unchanged
  });
});

test.describe("MLS: KeyPackage management via server", () => {
  let user: Awaited<ReturnType<typeof createAdminUser>>;
  let userAuth: AuthContext;
  let spaceId: string;

  test.beforeAll(async () => {
    user = await createAdminUser();
    userAuth = toAuthContext(user);

    spaceId = generateSpaceId();
    const createRes = await createSpace(userAuth, spaceId, "KeyPackage Test");
    expect(createRes.status).toBe(201);
  });

  test("upload key packages succeeds", async () => {
    const res = await uploadKeyPackages(userAuth, spaceId, 5);
    expect(res.status).toBe(201);
  });

  test("upload additional key packages succeeds", async () => {
    const res = await uploadKeyPackages(userAuth, spaceId, 5);
    expect(res.status).toBe(201);
  });

  test("empty key package array is rejected", async () => {
    const bodyStr = JSON.stringify({ keyPackages: [] });
    const token = await buildSignedUcan(userAuth, spaceId, "space/read");
    const res = await fetch(
      `${process.env.SYNC_SERVER_DIRECT_URL || "http://sync-server:3002"}/spaces/${spaceId}/mls/key-packages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `UCAN ${token}`,
        },
        body: bodyStr,
      },
    );
    // Zod validation should reject empty array
    expect(res.status).toBe(400);
  });
});

/**
 * MLS External Commit cursor invariant — regression for the infinite epoch loop.
 *
 * Root cause: after an External Commit (EC) is submitted, the sync loop must
 * advance its message cursor to AT LEAST the EC's own message ID so the EC is
 * not re-fetched on the next cycle. Without this, every cycle re-processes the
 * stale-epoch EC, triggers another rejoin, stores another EC, and loops forever.
 *
 * These tests verify the server-side half of the invariant:
 *   1. submitExternalCommit returns the assigned messageId.
 *   2. Fetching messages with after_id = messageId returns nothing (EC skipped).
 *   3. Fetching with after_id = messageId - 1 returns the EC (it IS there).
 */
test.describe("MLS: External Commit cursor invariant (epoch-loop regression)", () => {
  test.describe.configure({ mode: "serial" });

  let admin: Awaited<ReturnType<typeof createAdminUserWithIdentity>>;
  let adminAuth: AuthContext;
  let member: Awaited<ReturnType<typeof createAdminUser>>;
  let memberAuth: AuthContext;
  let spaceId: string;
  let ecMessageId: number;

  test.beforeAll(async () => {
    admin = await createAdminUserWithIdentity();
    adminAuth = toAuthContext(admin);
    member = await createAdminUser();
    memberAuth = toAuthContext(member);

    spaceId = generateSpaceId();
    const createRes = await createSpace(adminAuth, spaceId, "Cursor Regression Test");
    expect(createRes.status).toBe(201);

    const addRes = await addSpaceMember(adminAuth, spaceId, member.did, "Member", "space/write");
    expect(addRes.status).toBe(201);

    // Seed a commit so the space has a GroupInfo for rejoin
    const commitPayload = Buffer.from("fake-commit").toString("base64");
    const groupInfoPayload = Buffer.from("fake-group-info").toString("base64");
    const seedRes = await sendMlsMessage(adminAuth, spaceId, commitPayload, "commit", {
      epoch: 1,
      groupInfo: groupInfoPayload,
    });
    expect(seedRes.status).toBe(201);
  });

  test("submit external commit returns a numeric messageId", async () => {
    const commitPayload = Buffer.from("external-commit-blob").toString("base64");
    const res = await submitExternalCommit(memberAuth, spaceId, commitPayload);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(typeof data.messageId).toBe("number");
    expect(data.messageId).toBeGreaterThan(0);
    ecMessageId = data.messageId;
  });

  // Regression: the peer advances its cursor to ec_msg_id after submitting the
  // EC. The next fetch (after_id = ec_msg_id) must return nothing — if the EC
  // itself were returned, the "Wrong Epoch" error would trigger another rejoin,
  // storing yet another EC, causing the infinite loop.
  test("fetch after ec_msg_id cursor returns empty — EC is not re-fetched", async () => {
    expect(ecMessageId).toBeGreaterThan(0);

    const res = await fetchMlsMessages(memberAuth, spaceId, ecMessageId);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.messages).toHaveLength(0);
  });

  // Confirm the EC is present at the expected position (before the cursor).
  // If this test fails, the EC was never stored — a different bug entirely.
  test("fetch with cursor one below ec_msg_id does include the EC", async () => {
    expect(ecMessageId).toBeGreaterThan(0);

    const res = await fetchMlsMessages(memberAuth, spaceId, ecMessageId - 1);
    expect(res.status).toBe(200);

    const data = await res.json();
    const ecMessages = data.messages.filter((m: { id: number }) => m.id === ecMessageId);
    expect(ecMessages).toHaveLength(1);
  });

  // Two consecutive EC submissions must each get their own unique messageId.
  // If they shared an ID, the second EC would overwrite the cursor position and
  // the first EC would be re-fetched — equivalent to the loop regression.
  test("two external commits receive distinct increasing messageIds", async () => {
    expect(ecMessageId).toBeGreaterThan(0);

    const payload = Buffer.from("second-ec").toString("base64");
    const res = await submitExternalCommit(memberAuth, spaceId, payload);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.messageId).toBeGreaterThan(ecMessageId);
  });
});

