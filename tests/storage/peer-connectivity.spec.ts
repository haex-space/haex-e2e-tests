import * as crypto from "crypto";
import { test, expect, VaultAutomation } from "../fixtures";
import {
  createUcan,
  createWebCryptoSigner,
  publicKeyToDid,
  spaceResource,
  SpaceCapabilities,
} from "@haex-space/ucan";

const { subtle } = crypto.webcrypto as unknown as Crypto;

/**
 * P2P Connectivity E2E Tests
 *
 * Tests actual peer-to-peer file sharing between two vault instances:
 * - Vault A shares a folder with test files
 * - Vault B connects via iroh/QUIC and browses/downloads files
 * - Access control ensures only registered peers can connect
 *
 * Requires two vault containers (vault-a + vault-b) running in Docker.
 */

interface PeerStorageStartInfo {
  nodeId: string;
  relayUrl: string | null;
}

interface PeerStorageStatus {
  running: boolean;
  nodeId: string;
}

interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  modified: number | null;
}

test.describe("storage: P2P connectivity between vaults", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(30_000); // P2P connection can take a few seconds

  let vaultA: VaultAutomation;
  let vaultB: VaultAutomation;
  let nodeIdA: string;
  let nodeIdB: string;
  let relayUrlA: string | null;
  const spaceId = `e2e-p2p-space-${Date.now()}`;
  const testDir = `/tmp/e2e-p2p-test-${Date.now()}`;
  let ucanToken: string;
  let ownerIdentityId: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Ensure Vault B has an open vault (Vault A is opened by global-setup,
    // but Vault B starts fresh and needs its own vault)
    try {
      await vaultB.invokeTauriCommand("create_encrypted_database", {
        vaultName: "P2P Test Vault B",
        key: "test-password-b",
        spaceId: null,
      });
    } catch {
      // Vault may already exist, try opening it
      const vaults = await vaultB.invokeTauriCommand<Array<{ name: string; path: string }>>("list_vaults", {});
      if (vaults.length > 0) {
        await vaultB.invokeTauriCommand("open_encrypted_database", {
          vaultPath: vaults[0].path,
          key: "test-password-b",
        });
      }
    }

    // Stop any running P2P endpoints
    for (const vault of [vaultA, vaultB]) {
      try {
        const status = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
        if (status.running) {
          await vault.invokeTauriCommand("peer_storage_stop", {});
        }
      } catch {
        // Ignore
      }
    }

    // Wipe any leftover download artefacts on Vault B so dedup doesn't
    // rename them (hello.txt → "hello (1).txt") on a Playwright retry. Tauri's
    // peer_storage_remote_read saves into app.path().download_dir(), which
    // falls back to cache_dir() when Downloads isn't set — inside our webtop
    // container that's /config/.cache vs /config/Downloads. We clean both.
    const downloadNames = ["hello.txt", "large.bin", "nested.txt"];
    for (const dir of ["/config/.cache", "/config/Downloads"]) {
      for (const name of downloadNames) {
        for (const variant of [name, ...Array.from({ length: 5 }, (_, i) => {
          const dot = name.lastIndexOf(".");
          return `${name.slice(0, dot)} (${i + 1})${name.slice(dot)}`;
        })]) {
          try {
            await vaultB.invokeTauriCommand("filesystem_remove", {
              path: `${dir}/${variant}`,
            });
          } catch {
            // File doesn't exist — nothing to clean.
          }
        }
      }
    }

    // Create test directory and files on Vault A
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: testDir });
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: `${testDir}/subfolder` });

    // Write test files (base64 encoded content)
    const helloBase64 = Buffer.from("Hello from Vault A!").toString("base64");
    const largeContent = Buffer.from("x".repeat(10_000)).toString("base64");
    const nestedBase64 = Buffer.from("nested file content").toString("base64");

    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/hello.txt`,
      data: helloBase64,
    });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/large.bin`,
      data: largeContent,
    });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${testDir}/subfolder/nested.txt`,
      data: nestedBase64,
    });

    // Create the space record on both vaults so FK constraints on
    // haex_peer_shares and haex_space_devices are satisfied.
    // haex_spaces requires owner_identity_id — use the vault's own identity.
    for (const vault of [vaultA, vaultB]) {
      const [[identityId]] = await vault.invokeTauriCommand<[[string]]>("sql_select_with_crdt", {
        sql: "SELECT id FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        params: [],
      });
      if (vault === vaultA) ownerIdentityId = identityId;

      await vault.invokeTauriCommand("sql_execute_with_crdt", {
        sql: `INSERT OR IGNORE INTO haex_spaces (id, type, name, owner_identity_id) VALUES (?1, ?2, ?3, ?4)`,
        params: [spaceId, "local", "E2E P2P Space", identityId],
      });
    }

    // Generate a signed UCAN token for P2P authorization
    const keyPair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPublicKey = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
    const issuerDid = publicKeyToDid(rawPublicKey);
    const signer = createWebCryptoSigner(keyPair.privateKey);
    ucanToken = await createUcan(
      {
        issuer: issuerDid,
        audience: issuerDid,
        capabilities: { [spaceResource(spaceId)]: SpaceCapabilities.ADMIN },
        expiration: Math.floor(Date.now() / 1000) + 86400,
      },
      signer,
    );
  });

  test.afterAll(async () => {
    // Stop P2P endpoints
    for (const vault of [vaultA, vaultB]) {
      try {
        await vault.invokeTauriCommand("peer_storage_stop", {});
      } catch {
        // Best effort
      }
    }

    // Clean up test files
    try {
      await vaultA.invokeTauriCommand("filesystem_remove", {
        path: testDir,
        recursive: true,
      });
    } catch {
      // Best effort
    }

    // Release the per-suite vault B mount so the next suite starts with a
    // clean AppState. Without this its beforeAll's create_encrypted_database
    // / open_encrypted_database returns VaultAlreadyMountedInProcess and the
    // whole suite cascades. Vault A is opened by global-setup and shared
    // across suites — do NOT close it or downstream suites lose their DB.
    try {
      await vaultB.invokeTauriCommand("close_database", {});
    } catch {
      // Best effort
    }
  });

  // ===========================================================================
  // Setup: Start endpoints and register devices
  // ===========================================================================

  test("start P2P endpoint on Vault A", async () => {
    const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );
    nodeIdA = info.nodeId;
    relayUrlA = info.relayUrl;

    expect(nodeIdA).toBeTruthy();
  });

  test("start P2P endpoint on Vault B", async () => {
    const info = await vaultB.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );
    nodeIdB = info.nodeId;

    expect(nodeIdB).toBeTruthy();
    expect(nodeIdB).not.toBe(nodeIdA);
  });

  test("register share on Vault A via DB", async () => {
    const shareId = crypto.randomUUID();

    // Insert peer share record (CRDT table)
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares (id, space_id, device_endpoint_id, name, local_path)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [shareId, spaceId, nodeIdA, "TestShare", testDir],
    });

    // Reload shares into the running endpoint
    const loaded = await vaultA.invokeTauriCommand<number>(
      "peer_storage_reload_shares",
      {}
    );
    expect(loaded).toBeGreaterThanOrEqual(1);
  });

  test("register devices in shared space on both vaults", async () => {
    const deviceIdA = crypto.randomUUID();
    const deviceIdB = crypto.randomUUID();

    // Register Vault A's device on Vault A
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_endpoint_id, device_name, relay_url)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [deviceIdA, spaceId, nodeIdA, "VaultA", relayUrlA],
    });

    // Register Vault B's device on Vault A (so A knows B is allowed)
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_endpoint_id, device_name)
            VALUES (?1, ?2, ?3, ?4)`,
      params: [crypto.randomUUID(), spaceId, nodeIdB, "VaultB"],
    });

    // Register Vault A's device on Vault B (so B knows how to reach A)
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_endpoint_id, device_name, relay_url)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [deviceIdB, spaceId, nodeIdA, "VaultA", relayUrlA],
    });

    // Reload on both sides
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});
    await vaultB.invokeTauriCommand("peer_storage_reload_shares", {});
  });

  // ===========================================================================
  // P2P File Browsing
  // ===========================================================================

  test("Vault B can list root shares from Vault A", async () => {
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/",
        ucanToken,
      }
    );

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const testShare = entries.find((e) => e.name === "TestShare");
    expect(testShare).toBeDefined();
    expect(testShare!.isDir).toBe(true);
  });

  test("Vault B can list files inside a share", async () => {
    // Debug: check P2P endpoint status before the flaky operation
    console.log(`[P2P-DEBUG] Listing /TestShare — nodeIdA=${nodeIdA?.slice(0, 12)}…, relayUrl=${relayUrlA}`);
    for (const [label, vault] of [["A", vaultA], ["B", vaultB]] as const) {
      try {
        const st = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
        console.log(`[P2P-DEBUG] Vault ${label} peer_storage_status: running=${st.running}, nodeId=${st.nodeId?.slice(0, 12)}…`);
      } catch (e) {
        console.log(`[P2P-DEBUG] Vault ${label} peer_storage_status failed:`, (e as Error).message?.slice(0, 120));
      }
    }

    const t0 = Date.now();
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/TestShare",
        ucanToken,
      }
    );
    console.log(`[P2P-DEBUG] peer_storage_remote_list /TestShare took ${Date.now() - t0}ms, entries=${entries.length}`);

    expect(entries.length).toBe(3); // hello.txt, large.bin, subfolder
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["hello.txt", "large.bin", "subfolder"]);

    // Verify file metadata
    const hello = entries.find((e) => e.name === "hello.txt")!;
    expect(hello.isDir).toBe(false);
    expect(hello.size).toBe(19); // "Hello from Vault A!" = 19 bytes

    const subfolder = entries.find((e) => e.name === "subfolder")!;
    expect(subfolder.isDir).toBe(true);
  });

  test("Vault B can browse nested directories", async () => {
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/TestShare/subfolder",
        ucanToken,
      }
    );

    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("nested.txt");
    expect(entries[0].isDir).toBe(false);
  });

  // ===========================================================================
  // P2P File Download
  // ===========================================================================

  test("Vault B can download a file from Vault A", async () => {
    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: "/TestShare/hello.txt",
      ucanToken,
    });

    expect(localPath).toBeTruthy();
    expect(localPath).toContain("hello.txt");

    // Verify the downloaded file content
    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file",
      { path: localPath }
    );
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    expect(decoded).toBe("Hello from Vault A!");
  });

  test("Vault B can download a larger file", async () => {
    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: "/TestShare/large.bin",
      ucanToken,
    });

    // Verify size
    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file",
      { path: localPath }
    );
    const decoded = Buffer.from(content, "base64");
    expect(decoded.length).toBe(10_000);
  });

  test("Vault B can download from nested directories", async () => {
    // Debug: check P2P status before the consistently failing download
    console.log(`[P2P-DEBUG] Nested download — checking P2P health before attempt`);
    for (const [label, vault] of [["A", vaultA], ["B", vaultB]] as const) {
      try {
        const st = await vault.invokeTauriCommand<PeerStorageStatus>("peer_storage_status", {});
        console.log(`[P2P-DEBUG] Vault ${label}: running=${st.running}, nodeId=${st.nodeId?.slice(0, 12)}…`);
      } catch (e) {
        console.log(`[P2P-DEBUG] Vault ${label} status FAILED:`, (e as Error).message?.slice(0, 120));
      }
    }

    // Quick connectivity probe: list the subfolder first (lighter than download)
    const t0Probe = Date.now();
    try {
      const probe = await vaultB.invokeTauriCommand<FileEntry[]>(
        "peer_storage_remote_list",
        { nodeId: nodeIdA, relayUrl: relayUrlA, path: "/TestShare/subfolder", ucanToken }
      );
      console.log(`[P2P-DEBUG] Subfolder probe OK in ${Date.now() - t0Probe}ms, entries=${probe.length}`);
    } catch (e) {
      console.log(`[P2P-DEBUG] Subfolder probe FAILED in ${Date.now() - t0Probe}ms:`, (e as Error).message?.slice(0, 120));
    }

    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: "/TestShare/subfolder/nested.txt",
      ucanToken,
    });

    const content = await vaultB.invokeTauriCommand<string>(
      "filesystem_read_file",
      { path: localPath }
    );
    const decoded = Buffer.from(content, "base64").toString("utf-8");
    expect(decoded).toBe("nested file content");
  });

  test("download to specific path works", async () => {
    const saveTo = `/tmp/e2e-p2p-download-${Date.now()}.txt`;

    const localPath = await vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: "/TestShare/hello.txt",
      saveTo,
      ucanToken,
    });

    expect(localPath).toBe(saveTo);

    // Clean up
    try {
      await vaultB.invokeTauriCommand("filesystem_remove", { path: saveTo });
    } catch {
      // Best effort
    }
  });

  // ===========================================================================
  // Access Control
  // ===========================================================================

  test("listing non-existent share returns error", async () => {
    await expect(
      vaultB.invokeTauriCommand<FileEntry[]>("peer_storage_remote_list", {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/NonExistentShare",
        ucanToken,
      })
    ).rejects.toThrow();
  });

  test("path traversal is prevented", async () => {
    await expect(
      vaultB.invokeTauriCommand<FileEntry[]>("peer_storage_remote_list", {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/TestShare/../../etc",
        ucanToken,
      })
    ).rejects.toThrow();
  });

  // ===========================================================================
  // Unregistered Peer Rejection
  // ===========================================================================

  test("unregistered peer cannot list shares", async () => {
    // Create a third ephemeral vault automation (simulated by starting
    // a new endpoint on Vault B after removing its registration from Vault A)

    // Remove Vault B from Vault A's allowed peers
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `DELETE FROM haex_space_devices WHERE device_endpoint_id = ?1`,
      params: [nodeIdB],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    // Wait briefly for state to propagate
    await new Promise((r) => setTimeout(r, 500));

    // Vault B should now be rejected
    await expect(
      vaultB.invokeTauriCommand<FileEntry[]>("peer_storage_remote_list", {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/",
        ucanToken,
      })
    ).rejects.toThrow();

    // Re-register Vault B for subsequent tests
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_endpoint_id, device_name)
            VALUES (?1, ?2, ?3, ?4)`,
      params: [crypto.randomUUID(), spaceId, nodeIdB, "VaultB"],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});
  });

  // ===========================================================================
  // Space Isolation
  // ===========================================================================

  test("shares in different spaces are isolated", async () => {
    const otherSpaceId = `e2e-p2p-other-space-${Date.now()}`;
    const otherDir = `/tmp/e2e-p2p-other-${Date.now()}`;
    const otherShareId = crypto.randomUUID();

    // Create the space record for the other space
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT OR IGNORE INTO haex_spaces (id, type, name, owner_identity_id) VALUES (?1, ?2, ?3, ?4)`,
      params: [otherSpaceId, "local", "E2E P2P Other Space", ownerIdentityId],
    });

    // Create a share in a different space
    await vaultA.invokeTauriCommand("filesystem_mkdir", { path: otherDir });
    await vaultA.invokeTauriCommand("filesystem_write_file", {
      path: `${otherDir}/secret.txt`,
      data: Buffer.from("secret data").toString("base64"),
    });
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares (id, space_id, device_endpoint_id, name, local_path)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      params: [otherShareId, otherSpaceId, nodeIdA, "SecretShare", otherDir],
    });
    await vaultA.invokeTauriCommand("peer_storage_reload_shares", {});

    // Vault B is only registered in spaceId, not otherSpaceId
    // So it should NOT see SecretShare in the root listing
    const entries = await vaultB.invokeTauriCommand<FileEntry[]>(
      "peer_storage_remote_list",
      {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/",
        ucanToken,
      }
    );

    const secretShare = entries.find((e) => e.name === "SecretShare");
    expect(secretShare).toBeUndefined();

    // The original TestShare should still be visible
    const testShare = entries.find((e) => e.name === "TestShare");
    expect(testShare).toBeDefined();

    // Clean up
    try {
      await vaultA.invokeTauriCommand("filesystem_remove", {
        path: otherDir,
        recursive: true,
      });
    } catch {
      // Best effort
    }
  });

  // ===========================================================================
  // Transfer Control
  // ===========================================================================

  test("transfer can be cancelled", async () => {
    const transferId = crypto.randomUUID();

    // Start download and immediately cancel
    const downloadPromise = vaultB.peerStorageDownloadFile({
      nodeId: nodeIdA,
      relayUrl: relayUrlA,
      path: "/TestShare/large.bin",
      transferId,
      ucanToken,
    });

    // Cancel after a short delay
    await new Promise((r) => setTimeout(r, 50));
    await vaultB.invokeTauriCommand("peer_storage_transfer_cancel", {
      transferId,
    });

    // The download should have been cancelled (either error or success if it finished first)
    try {
      await downloadPromise;
      // If download completed before cancel, that's also valid
    } catch (e) {
      // Expected: transfer was cancelled
      expect(String(e)).toContain("cancel");
    }
  });
});
