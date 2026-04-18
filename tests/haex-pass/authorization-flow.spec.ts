import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
  type KeyPair,
} from "../fixtures";

test.describe("haex-pass: authorization-flow", () => {
  test.describe.configure({ mode: "serial" });

  test("connect transitions to pending_approval or paired", async () => {
    const client = new VaultBridgeClient();
    try {
      const connected = await waitForBridgeConnection(client);
      expect(connected).toBe(true);

      const { state } = client.getState();
      // First connection goes to pending_approval; remembered clients go straight to paired
      expect(["pending_approval", "paired"]).toContain(state);
    } finally {
      client.disconnect();
    }
  });

  test("after authorization state is paired with valid clientId", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      const authorized = await authorizeClient(client, "unused");
      expect(authorized).toBe(true);

      const { state, clientId } = client.getState();
      expect(state).toBe("paired");
      // clientId is a 32-char hex string (16 bytes SHA-256 prefix)
      expect(typeof clientId).toBe("string");
      expect(clientId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      client.disconnect();
    }
  });

  test("authorized client can make GET_ITEMS request", async () => {
    const client = new VaultBridgeClient();
    try {
      await waitForBridgeConnection(client);
      await authorizeClient(client, "unused");

      const response = await sendRequestWithRetry<{
        success: boolean;
        data?: { entries: unknown[] };
        error?: string;
        requestId: string;
      }>(client, HAEX_PASS_METHODS.GET_ITEMS, {
        url: "https://example.com",
      });

      expect(response.success).toBe(true);
      expect(typeof response.requestId).toBe("string");
      expect(response.requestId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      client.disconnect();
    }
  });

  test("unauthorized client sendRequest throws not authorized", async () => {
    const client = new VaultBridgeClient();
    try {
      // Only connect, do NOT authorize. Fresh X25519 keys generated in the
      // VaultBridgeClient constructor guarantee the server has never seen
      // this clientId — handshake must resolve to pending_approval or
      // connected (denied), never paired.
      await waitForBridgeConnection(client);

      const { state } = client.getState();
      expect(state).not.toBe("paired");

      await expect(
        client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
          url: "https://example.com",
        })
      ).rejects.toThrow("Not authorized");
    } finally {
      client.disconnect();
    }
  });

  test("reconnect with same keys auto-authorizes remembered client", async () => {
    // Capture the first client's keyPair + clientId so we can simulate a
    // second connection from the SAME device (same identity).
    let sharedKeyPair: KeyPair | null = null;
    let firstClientId: string | null = null;

    // First connection: fresh keys, go through the approval flow, remember.
    {
      const client = new VaultBridgeClient();
      try {
        await waitForBridgeConnection(client);
        const authorized = await authorizeClient(client, "unused");
        expect(authorized).toBe(true);
        expect(client.getState().state).toBe("paired");

        sharedKeyPair = client.getKeyPair();
        firstClientId = client.getClientId();
        expect(sharedKeyPair).not.toBeNull();
        expect(firstClientId).toMatch(/^[0-9a-f]{32}$/);
      } finally {
        client.disconnect();
      }
    }

    // Second connection: reuse the previous keyPair. The server recognizes
    // the clientId and must auto-pair via the handshake response — no
    // second approval round is required. This is the actual "reconnect
    // with same keys" path the test's name claims to cover.
    {
      const client = new VaultBridgeClient({ keyPair: sharedKeyPair! });
      try {
        await waitForBridgeConnection(client);

        // Same keyPair derives the same clientId
        expect(client.getClientId()).toBe(firstClientId);

        // Auto-pairing must complete without calling authorizeClient again.
        // waitForAuthorization resolves true if state is already paired or
        // transitions to paired via the handshake response.
        const paired = await client.waitForAuthorization(10000);
        expect(paired).toBe(true);
        expect(client.getState().state).toBe("paired");
      } finally {
        client.disconnect();
      }
    }
  });
});
