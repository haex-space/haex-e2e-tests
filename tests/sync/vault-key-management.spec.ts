import crypto from "crypto";
import { test, expect } from "@playwright/test";
import {
  getSyncServerUrl,
  checkSyncServerHealth,
  createAdminUser,
  createVaultKey,
  deleteVault,
} from "../helpers";

test.describe("sync: vault-key-management", () => {
  test.describe.configure({ mode: "serial" });

  const baseUrl = getSyncServerUrl();
  let accessToken: string;
  const spaceId = crypto.randomUUID();

  test.beforeAll(async () => {
    const healthy = await checkSyncServerHealth();
    expect(healthy).toBe(true);

    const admin = await createAdminUser();
    accessToken = admin.accessToken;
  });

  test.afterAll(async () => {
    try {
      await deleteVault(accessToken, spaceId);
    } catch {
      // Best effort cleanup
    }
  });

  test("store vault key returns 201 with matching spaceId", async () => {
    const body = {
      spaceId,
      encryptedVaultKey: crypto.randomBytes(32).toString("base64"),
      encryptedVaultName: Buffer.from("E2E Vault Key Test").toString("base64"),
      vaultKeySalt: crypto.randomBytes(16).toString("base64"),
      ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
      vaultKeyNonce: crypto.randomBytes(12).toString("base64"),
      vaultNameNonce: crypto.randomBytes(12).toString("base64"),
    };

    const res = await fetch(`${baseUrl}/sync/vault-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.vaultKey.spaceId).toBe(spaceId);
    expect(typeof data.vaultKey.id).toBe("string");
    expect(typeof data.vaultKey.createdAt).toBe("string");
  });

  test("retrieve vault key returns all fields with matching spaceId", async () => {
    const res = await fetch(`${baseUrl}/sync/vault-key/${spaceId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.vaultKey.spaceId).toBe(spaceId);
    expect(typeof data.vaultKey.encryptedVaultKey).toBe("string");
    expect(typeof data.vaultKey.encryptedVaultName).toBe("string");
    expect(typeof data.vaultKey.vaultKeySalt).toBe("string");
    expect(typeof data.vaultKey.ephemeralPublicKey).toBe("string");
    expect(typeof data.vaultKey.vaultKeyNonce).toBe("string");
    expect(typeof data.vaultKey.vaultNameNonce).toBe("string");
  });

  test("list vaults includes the created vault", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.vaults)).toBe(true);

    const found = data.vaults.find(
      (v: { spaceId: string }) => v.spaceId === spaceId,
    );
    expect(found).not.toBeNull();
    expect(found.spaceId).toBe(spaceId);
  });

  test("update vault name returns 200", async () => {
    const newEncryptedName = Buffer.from("E2E Vault Renamed").toString("base64");
    const newNonce = crypto.randomBytes(12).toString("base64");

    const res = await fetch(`${baseUrl}/sync/vault-key/${spaceId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        encryptedVaultName: newEncryptedName,
        vaultNameNonce: newNonce,
        ephemeralPublicKey: crypto.randomBytes(65).toString("base64"),
      }),
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.spaceId).toBe(spaceId);
    expect(typeof data.message).toBe("string");
  });

  test("delete vault returns 200", async () => {
    const res = await fetch(`${baseUrl}/sync/vault/${spaceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.spaceId).toBe(spaceId);
    expect(typeof data.message).toBe("string");
  });

  test("deleted vault no longer appears in vault list", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    const found = data.vaults.find(
      (v: { spaceId: string }) => v.spaceId === spaceId,
    );
    expect(found).toBeUndefined();
  });

  test("unauthorized request without token returns 401", async () => {
    const res = await fetch(`${baseUrl}/sync/vaults`);

    expect(res.status).toBe(401);
  });
});
