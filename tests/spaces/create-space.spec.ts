import * as crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  toAuthContext,
  createSpace,
  deleteSpace,
  createDidAuthHeader,
  DidAuthAction,
} from "../helpers";
import { SpaceCapabilities } from "@haex-space/ucan";

const SYNC_SERVER_URL = getSyncServerUrl();

function randomBase64(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64");
}

test.describe("spaces: create-space", () => {
  test.describe.configure({ mode: "serial" });

  let auth: ReturnType<typeof toAuthContext> extends infer T ? T : never;
  const spaceId = crypto.randomUUID();
  const spaceLabel = "E2E Test Space";

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    auth = toAuthContext(admin);
  });

  test.afterAll(async () => {
    try {
      await deleteSpace(auth, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("create space returns 201 with success", async () => {
    const res = await createSpace(auth, spaceId, spaceLabel);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("list spaces includes the created space with admin role", async () => {
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const spaces = await res.json();

    expect(Array.isArray(spaces)).toBe(true);
    const found = spaces.find((s: { id: string }) => s.id === spaceId);
    expect(found).toBeDefined();
    expect(found.capability).toBe(SpaceCapabilities.ADMIN);
    expect(typeof found.ownerId).toBe("string");
    expect(typeof found.encryptedName).toBe("string");
    expect(typeof found.nameNonce).toBe("string");
    expect(typeof found.createdAt).toBe("string");
    expect(typeof found.updatedAt).toBe("string");
    expect(typeof found.joinedAt).toBe("string");
  });

  test("get space details returns members array with creator", async () => {
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.ListSpaces);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    const space = await res.json();

    expect(space.id).toBe(spaceId);
    expect(typeof space.ownerId).toBe("string");
    expect(typeof space.encryptedName).toBe("string");
    expect(Array.isArray(space.members)).toBe(true);
    expect(space.members.length).toBeGreaterThanOrEqual(1);

    const creator = space.members.find(
      (m: { capability: string }) => m.capability === SpaceCapabilities.ADMIN,
    );
    expect(creator).toBeDefined();
    expect(typeof creator.publicKey).toBe("string");
    expect(typeof creator.label).toBe("string");
    expect(typeof creator.joinedAt).toBe("string");
  });

  test("update space name returns 200 with success", async () => {
    const body = JSON.stringify({
      encryptedName: randomBase64(32),
      nameNonce: randomBase64(12),
    });
    const authHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.CreateSpace, body);
    const res = await fetch(`${SYNC_SERVER_URL}/spaces/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
    });

    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody.success).toBe(true);
  });

  test("delete space returns 200 and space no longer in list", async () => {
    const deleteRes = await deleteSpace(auth, spaceId);

    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);

    // Verify space is no longer in list
    const listAuthHeader = await createDidAuthHeader(auth.privateKeyBase64, auth.did, DidAuthAction.ListSpaces);
    const listRes = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      headers: { Authorization: listAuthHeader },
    });

    expect(listRes.status).toBe(200);
    const spaces = await listRes.json();
    const found = spaces.find((s: { id: string }) => s.id === spaceId);
    expect(found).toBeUndefined();
  });

  test("creating a space without auth returns 401", async () => {
    const res = await fetch(`${SYNC_SERVER_URL}/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        encryptedName: randomBase64(32),
        nameNonce: randomBase64(12),
        label: "Unauthorized Space",
      }),
    });

    expect(res.status).toBe(401);
  });
});
