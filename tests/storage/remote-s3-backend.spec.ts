import { test, expect, VaultAutomation } from "../fixtures";

interface StorageBackendInfo {
  id: string;
  name: string;
  backendType: string;
  bucket: string;
  region: string;
  endpoint: string;
}

const MINIO_CONFIG = {
  name: `e2e-test-backend-${Date.now()}`,
  backendType: "s3" as const,
  bucket: "e2e-test-bucket",
  region: "us-east-1",
  endpoint: "http://minio:9000",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
};

test.describe("storage: remote S3 backend", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let minioAvailable = false;
  let addedBackendId: string | null = null;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Probe MinIO availability by attempting a test_backend call
    try {
      await vault.invokeTauriCommand("remote_storage_test_backend", MINIO_CONFIG);
      minioAvailable = true;
    } catch {
      minioAvailable = false;
    }
  });

  test.afterAll(async () => {
    // Clean up: remove test backend if it was added
    if (addedBackendId) {
      try {
        await vault.invokeTauriCommand("remote_storage_remove_backend", {
          id: addedBackendId,
        });
      } catch {
        // Best effort cleanup
      }
    }
    // No close_database here: this suite only drives vault A which is opened
    // by global-setup and shared across suites — closing it would leave every
    // downstream storage spec with "Connection to vault failed".
  });

  test("list_backends returns an array", async () => {
    const backends = await vault.invokeTauriCommand<StorageBackendInfo[]>(
      "remote_storage_list_backends",
      {}
    );

    expect(Array.isArray(backends)).toBe(true);
  });

  test("add backend, verify in list, remove backend (requires MinIO)", async () => {
    test.skip(!minioAvailable, "MinIO is not available in this environment");

    // Add a new backend
    const added = await vault.invokeTauriCommand<StorageBackendInfo>(
      "remote_storage_add_backend",
      MINIO_CONFIG
    );

    expect(typeof added.id).toBe("string");
    expect(added.id.length).toBeGreaterThan(0);
    expect(added.name).toBe(MINIO_CONFIG.name);
    expect(added.backendType).toBe("s3");
    expect(added.bucket).toBe(MINIO_CONFIG.bucket);
    expect(added.region).toBe(MINIO_CONFIG.region);
    expect(added.endpoint).toBe(MINIO_CONFIG.endpoint);

    addedBackendId = added.id;

    // Verify backend appears in list
    const backends = await vault.invokeTauriCommand<StorageBackendInfo[]>(
      "remote_storage_list_backends",
      {}
    );

    const found = backends.find((b) => b.id === added.id);
    expect(found).not.toBeUndefined();
    expect(found!.name).toBe(MINIO_CONFIG.name);
    expect(found!.bucket).toBe(MINIO_CONFIG.bucket);

    // Remove the backend
    await vault.invokeTauriCommand("remote_storage_remove_backend", {
      id: added.id,
    });
    addedBackendId = null;

    // Verify backend is gone from list
    const backendsAfterRemoval = await vault.invokeTauriCommand<StorageBackendInfo[]>(
      "remote_storage_list_backends",
      {}
    );

    const notFound = backendsAfterRemoval.find((b) => b.id === added.id);
    expect(notFound).toBeUndefined();
  });

  test("test_backend with invalid credentials throws error", async () => {
    await expect(
      vault.invokeTauriCommand("remote_storage_test_backend", {
        name: "invalid-backend",
        backendType: "s3",
        bucket: "nonexistent-bucket",
        region: "us-east-1",
        endpoint: "http://invalid-host:9999",
        accessKeyId: "bad-key",
        secretAccessKey: "bad-secret",
      })
    ).rejects.toThrow();
  });
});
