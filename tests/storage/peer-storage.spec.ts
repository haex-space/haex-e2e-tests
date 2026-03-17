import { test, expect, VaultAutomation } from "../fixtures";

interface PeerStorageStatus {
  running: boolean;
  nodeId?: string;
}

// Skip: peer_storage_status command does not exist in this vault version
test.describe.skip("storage: peer storage", () => {
  test.describe.configure({ mode: "serial" });

  let vault: VaultAutomation;
  let startedNodeId: string | null = null;

  test.beforeAll(async () => {
    vault = new VaultAutomation("A");
    await vault.createSession();

    // Ensure peer storage is stopped before tests begin
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );
    if (status.running) {
      await vault.invokeTauriCommand("peer_storage_stop", {});
    }
  });

  test.afterAll(async () => {
    // Clean up: stop peer storage if it was started
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
  });

  test("start returns a node ID string", async () => {
    const nodeId = await vault.invokeTauriCommand<string>(
      "peer_storage_start",
      {}
    );

    expect(typeof nodeId).toBe("string");
    expect(nodeId.length).toBeGreaterThan(0);
    startedNodeId = nodeId;
  });

  test("status when running returns running true with matching nodeId", async () => {
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );

    expect(status.running).toBe(true);
    expect(typeof status.nodeId).toBe("string");
    expect(status.nodeId).toBe(startedNodeId);
  });

  test("stop returns without error", async () => {
    await vault.invokeTauriCommand("peer_storage_stop", {});
    startedNodeId = null;
  });

  test("status after stop returns running false", async () => {
    const status = await vault.invokeTauriCommand<PeerStorageStatus>(
      "peer_storage_status",
      {}
    );

    expect(status.running).toBe(false);
  });
});
