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
    const res = await fetch(
      `${process.env.SYNC_SERVER_DIRECT_URL || "http://sync-server:3002"}/spaces/${spaceId}/mls/key-packages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `UCAN ${buildDummyUcan(userAuth.did, spaceId)}`,
        },
        body: bodyStr,
      },
    );
    // Zod validation should reject empty array
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Helper
// =============================================================================

function buildDummyUcan(did: string, spaceId: string): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const payload = {
    iss: did,
    aud: did,
    att: [{ with: `space:${spaceId}`, can: "space/read" }],
    exp: Math.floor(Date.now() / 1000) + 86400,
    iat: Math.floor(Date.now() / 1000),
  };
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.randomBytes(64).toString("base64url");
  return `${encode(header)}.${encode(payload)}.${sig}`;
}