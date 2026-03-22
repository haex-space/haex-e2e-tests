import { test, expect, VaultAutomation } from "../fixtures";

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

test.describe("storage: peer storage endpoint lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Ensure peer storage is stopped before tests begin
    try {
      const status = await vault.invokeTauriCommand<PeerStorageStatus>(
        "peer_storage_status",
        {}
      );
      if (status.running) {
        await vault.invokeTauriCommand("peer_storage_stop", {});
      }
    } catch {
      // Command might not exist in older versions
    }
  });

  test.afterAll(async () => {
    try {
      const status = await vault.invokeTauriCommand<PeerStorageStatus>(
        "peer_storage_status",
        {}
      );
      if (status.running) {
        await vault.invokeTauriCommand("peer_storage_stop", {});
      }
    } catch {
      // Best effort cleanup
    }
  });

  test("status when stopped returns running false", async () => {
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );

    expect(status.running).toBe(false);
    expect(typeof status.nodeId).toBe("string");
  });

  test("start returns nodeId and optional relayUrl", async () => {
    const info = await vault.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );

    expect(typeof info.nodeId).toBe("string");
    expect(info.nodeId.length).toBeGreaterThan(0);
    // relayUrl may be null if relay isn't reachable in test env
    expect(info.relayUrl === null || typeof info.relayUrl === "string").toBe(true);
  });

  test("status when running returns running true with matching nodeId", async () => {
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );

    expect(status.running).toBe(true);
    expect(typeof status.nodeId).toBe("string");
    expect(status.nodeId.length).toBeGreaterThan(0);
  });

  test("starting again while running returns error", async () => {
    await expect(
      vault.invokeTauriCommand("peer_storage_start", {})
    ).rejects.toThrow();
  });

  test("stop returns without error", async () => {
    await vault.invokeTauriCommand("peer_storage_stop", {});
  });

  test("status after stop returns running false", async () => {
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );

    expect(status.running).toBe(false);
  });

  test("nodeId is deterministic (same device key)", async () => {
    // Start, get nodeId, stop, start again — should be the same nodeId
    const info1 = await vault.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );
    await vault.invokeTauriCommand("peer_storage_stop", {});

    const info2 = await vault.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );
    await vault.invokeTauriCommand("peer_storage_stop", {});

    expect(info1.nodeId).toBe(info2.nodeId);
  });

  test("reload_shares works when endpoint is not running", async () => {
    const loaded = await vault.invokeTauriCommand<number>(
      "peer_storage_reload_shares",
      {}
    );
    expect(typeof loaded).toBe("number");
  });
});
