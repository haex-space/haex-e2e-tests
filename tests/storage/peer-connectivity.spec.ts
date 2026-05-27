import * as crypto from "crypto";
import { test, expect, VaultAutomation, waitFor } from "../fixtures";
import {
  createUcan,
  createWebCryptoSigner,
  publicKeyToDid,
  spaceResource,
  SpaceCapabilities,
} from "@haex-space/ucan";
import { initializeVaultViaUI } from "../helpers/ui/ui-vault";

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

/**
 * Load this device's persistent ed25519 key into the peer endpoint before
 * starting it. Both vaults are opened through the UI (Vault A by global-setup,
 * Vault B in beforeAll), so initVaultAsync has registered the own haex_devices
 * row — device_resolve_for_vault returns its id. Loading that key makes
 * peer_storage_start advertise the device's persistent endpoint id, so the
 * haex_devices row (endpoint_id == nodeId) the later tests read is guaranteed
 * to match instead of racing the frontend's P2P autostart (which otherwise left
 * the endpoint on an ephemeral key and the own-device-row poll flaky in CI).
 */
async function ensureDeviceKeyLoaded(vault: VaultAutomation): Promise<void> {
  const matchedId = await waitFor(
    () =>
      vault
        .invokeTauriCommand<{ matchedId?: string | null }>(
          "device_resolve_for_vault",
          {},
        )
        .then((r) => r.matchedId ?? null),
    {
      timeout: 30000,
      interval: 500,
      message:
        "device_resolve_for_vault never returned a matchedId — own device row not registered",
    },
  );
  await vault.invokeTauriCommand("endpoint_load_for_device", {
    deviceRowId: matchedId,
  });
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
  let ownDidA: string;
  let ownDidB: string;

  test.beforeAll(async () => {
    vaultA = new VaultAutomation("A");
    vaultB = new VaultAutomation("B");
    await vaultA.createSession();
    await vaultB.createSession();

    // Vault A is opened by global-setup; Vault B starts fresh and needs its own
    // vault. Open it through the UI (not a raw create/open_encrypted_database)
    // so the frontend initVaultAsync lifecycle runs and registers the own
    // haex_devices row. Without it device_resolve_for_vault finds no match and
    // peer_storage_start comes up on an ephemeral key that no device row carries.
    await initializeVaultViaUI(vaultB, "P2P Test Vault B", "test-password-b");

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
    // We also capture each vault's own DID so subsequent INSERTs into the
    // CRDT-synced device tables can carry authored_by_did. The Phase 2
    // haex_space_devices_ensure_refs / haex_peer_shares_ensure_refs triggers
    // need that DID to auto-create the haex_devices stub the FK points at.
    for (const vault of [vaultA, vaultB]) {
      const rows = await vault.invokeTauriCommand<[string, string][]>("sql_select_with_crdt", {
        sql: "SELECT id, did FROM haex_identities WHERE private_key IS NOT NULL LIMIT 1",
        params: [],
      });
      const [identityId, identityDid] = rows[0];
      if (vault === vaultA) {
        ownerIdentityId = identityId;
        ownDidA = identityDid;
      } else {
        ownDidB = identityDid;
      }

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

    // Release the per-suite vault B mount and reset the UI to root so the
    // next suite's beforeAll starts with a clean AppState. Without close_database
    // it gets VaultAlreadyMountedInProcess; without the navigate the WebView
    // stays on /vault/... and initializeVaultViaUI early-returns thinking
    // vault B is open while the DB is actually unmounted. Vault A is opened
    // by global-setup and shared across suites — do NOT close it.
    try {
      await vaultB.invokeTauriCommand("close_database", {});
    } catch {
      // Best effort
    }
    try {
      await vaultB.navigateTo("/");
    } catch {
      // Best effort
    }
  });

  // ===========================================================================
  // Setup: Start endpoints and register devices
  // ===========================================================================

  test("start P2P endpoint on Vault A", async () => {
    await ensureDeviceKeyLoaded(vaultA);
    const info = await vaultA.invokeTauriCommand<PeerStorageStartInfo>(
      "peer_storage_start",
      {}
    );
    nodeIdA = info.nodeId;
    relayUrlA = info.relayUrl;

    expect(nodeIdA).toBeTruthy();
  });

  test("start P2P endpoint on Vault B", async () => {
    await ensureDeviceKeyLoaded(vaultB);
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
    // device_id must be the real haex_devices.id for this vault (Phase 2 FK +
    // UNIQUE(endpoint_id) — a random UUID would make the ensure-refs trigger
    // collide on the existing own row's endpoint_id and fail the FK).
    const ownDeviceA = await vaultA.invokeTauriCommand<[[string]]>("sql_select_with_crdt", {
      sql: "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      params: [nodeIdA],
    });
    expect(ownDeviceA.length).toBe(1);
    const localDeviceIdA = ownDeviceA[0][0];

    // Insert peer share record (CRDT table)
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [shareId, spaceId, localDeviceIdA, nodeIdA, "TestShare", testDir, ownDidA],
    });

    // Reload shares into the running endpoint
    const loaded = await vaultA.invokeTauriCommand<number>(
      "peer_storage_reload_shares",
      {}
    );
    expect(loaded).toBeGreaterThanOrEqual(1);
  });

  test("register devices in shared space on both vaults", async () => {
    const rowAA = crypto.randomUUID();
    const rowAB = crypto.randomUUID();
    const rowBB = crypto.randomUUID();
    // haex_space_devices.device_id is a SQL FK on haex_devices.id (Phase 2).
    // For cross-vault stability the row each vault publishes must keep using
    // the SAME device_id every time: that's the publisher vault's actual
    // haex_devices.id. UNIQUE(endpoint_id) on haex_devices means the
    // ensure-refs trigger would otherwise leave a stale stub from a previous
    // test run (random id, same endpoint_id) blocking the new stub, and the
    // new random device_id would have no FK parent.
    // The own device row is written to haex_devices via CRDT during device
    // registration, which runs before peer_storage_start. The local CRDT
    // materialization is not guaranteed to be readable the instant the
    // endpoint reports its nodeId, so reading it immediately raced and failed
    // the first attempt (only passing on a Playwright retry once the write had
    // landed). Poll until the row is visible instead of asserting once.
    const selectOwnDevice = (vault: VaultAutomation, nodeId: string) => () =>
      vault
        .invokeTauriCommand<[[string]]>("sql_select_with_crdt", {
          sql: "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
          params: [nodeId],
        })
        .then((rows) => rows[0]?.[0] ?? null);

    const ownDeviceIdA = await waitFor(selectOwnDevice(vaultA, nodeIdA), {
      timeout: 10000,
      interval: 200,
      message: "Vault A own device row (haex_devices.endpoint_id == nodeIdA) not visible",
    });
    const ownDeviceIdB = await waitFor(selectOwnDevice(vaultB, nodeIdB), {
      timeout: 10000,
      interval: 200,
      message: "Vault B own device row (haex_devices.endpoint_id == nodeIdB) not visible",
    });

    // Register Vault A's device on Vault A
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, relay_url, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      params: [rowAA, spaceId, ownDeviceIdA, nodeIdA, "VaultA", "desktop", relayUrlA, ownDidA],
    });

    // Register Vault B's device on Vault A (so A knows B is allowed). Use
    // Vault B's REAL haex_devices.id so the row is stable across runs and
    // matches what Vault B itself would publish via CRDT in production.
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [rowAB, spaceId, ownDeviceIdB, nodeIdB, "VaultB", "desktop", ownDidB],
    });

    // Register Vault A's device on Vault B — same stability argument: use
    // Vault A's real haex_devices.id as device_id on Vault B's side.
    await vaultB.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, relay_url, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      params: [rowBB, spaceId, ownDeviceIdA, nodeIdA, "VaultA", "desktop", relayUrlA, ownDidA],
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
    // Drive the canonical "remove member" flow on Vault A via the Pinia
    // store — same code path the Settings → Space → Members → Remove UI
    // button takes. The action drops Vault B's haex_space_devices rows for
    // this space (matched on authored_by_did), revokes their UCAN tokens,
    // and calls peer_storage_reload_shares so Vault A's QUIC endpoint stops
    // recognising Vault B's UCAN against this space. The handle_request
    // gate then rejects the listing since the UCAN's claimed space is no
    // longer in Vault B's allowed_spaces for this connection.
    const removalResult = await vaultA.executeScript<string | null>(`
      return (async () => {
        const app = document.getElementById('__nuxt')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const spacesStore = pinia?._s?.get('spacesStore');
        if (!spacesStore?.removeSpaceMemberAsync) {
          return 'spacesStore.removeSpaceMemberAsync unavailable';
        }
        try {
          await spacesStore.removeSpaceMemberAsync(${JSON.stringify(spaceId)}, ${JSON.stringify(ownDidB)});
          return null;
        } catch (e) {
          return e?.message || String(e);
        }
      })();
    `);
    expect(removalResult).toBeNull();

    // The reload happens inside removeSpaceMemberAsync, but give the iroh
    // accept loop a tick to observe the new allowed_peers map.
    await new Promise((r) => setTimeout(r, 500));

    // Vault B's UCAN claims spaceId but Vault B is no longer registered
    // there → handle_request's per-UCAN-space gate rejects.
    await expect(
      vaultB.invokeTauriCommand<FileEntry[]>("peer_storage_remote_list", {
        nodeId: nodeIdA,
        relayUrl: relayUrlA,
        path: "/",
        ucanToken,
      })
    ).rejects.toThrow();

    // Re-register Vault B for subsequent tests. Reuse the existing
    // haex_devices stub so the FK + UNIQUE(endpoint_id) constraints pass.
    const existingStubB = await vaultA.invokeTauriCommand<[[string]]>("sql_select_with_crdt", {
      sql: "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      params: [nodeIdB],
    });
    const deviceIdB = existingStubB.length > 0 ? existingStubB[0][0] : crypto.randomUUID();
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_space_devices (id, space_id, device_id, endpoint_id, name, platform, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [crypto.randomUUID(), spaceId, deviceIdB, nodeIdB, "VaultB", "desktop", ownDidB],
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
    const ownDeviceForShare = await vaultA.invokeTauriCommand<[[string]]>("sql_select_with_crdt", {
      sql: "SELECT id FROM haex_devices WHERE endpoint_id = ?1 LIMIT 1",
      params: [nodeIdA],
    });
    expect(ownDeviceForShare.length).toBe(1);
    await vaultA.invokeTauriCommand("sql_execute_with_crdt", {
      sql: `INSERT INTO haex_peer_shares (id, space_id, device_id, endpoint_id, name, local_path, authored_by_did)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      params: [otherShareId, otherSpaceId, ownDeviceForShare[0][0], nodeIdA, "SecretShare", otherDir, ownDidA],
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
