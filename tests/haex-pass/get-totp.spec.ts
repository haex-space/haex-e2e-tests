import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  waitForExtensionReady,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * E2E Tests for haex-pass get-totp API
 *
 * Tests TOTP code generation via the browser bridge.
 */

const EXTENSION_ID = "haex-pass";

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

interface SetLoginResponse {
  entryId: string;
  title: string;
}

interface GetTotpResponse {
  code: string;
  validFor: number;
}

test.describe("get-totp", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let entryWithTotp: string;
  let entryWithoutTotp: string;

  test.beforeAll(async () => {
    client = new VaultBridgeClient();
    const connected = await waitForBridgeConnection(client);
    if (!connected) {
      throw new Error("Failed to connect to bridge");
    }

    const authorized = await authorizeClient(client, EXTENSION_ID);
    if (!authorized) {
      throw new Error("Failed to authorize client");
    }

    const ready = await waitForExtensionReady(client);
    if (!ready) {
      throw new Error("Extension failed to become ready");
    }
  });

  test.afterAll(async () => {
    client?.disconnect();
  });

  test("setup: create test entries", async () => {
    // Entry WITH TOTP (6 digits, SHA1, 30s period)
    const resp1 = (await sendRequestWithRetry(
      client,
      HAEX_PASS_METHODS.SET_ITEM,
      {
        title: "TOTP Test Entry",
        url: "https://totp-test.example.com",
        username: "totpuser",
        password: "totppass",
        otpSecret: "JBSWY3DPEHPK3PXP", // Test secret
        otpDigits: 6,
        otpPeriod: 30,
        otpAlgorithm: "SHA1",
      },
      { maxAttempts: 3, initialDelay: 1000 }
    )) as ApiResponse<SetLoginResponse>;

    expect(resp1.success).toBe(true);
    entryWithTotp = resp1.data!.entryId;

    // Entry WITHOUT TOTP
    const resp2 = (await sendRequestWithRetry(
      client,
      HAEX_PASS_METHODS.SET_ITEM,
      {
        title: "No TOTP Entry",
        url: "https://no-totp.example.com",
        username: "nototp",
        password: "notoppass",
      },
      { maxAttempts: 3, initialDelay: 1000 }
    )) as ApiResponse<SetLoginResponse>;

    expect(resp2.success).toBe(true);
    entryWithoutTotp = resp2.data!.entryId;
  });

  test("should return valid 6-digit TOTP code with countdown", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {
      entryId: entryWithTotp,
    })) as ApiResponse<GetTotpResponse>;

    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();

    // Verify 6-digit code format
    expect(response.data!.code).toMatch(/^\d{6}$/);

    // Verify countdown is within valid range (1-30 seconds for 30s period)
    expect(response.data!.validFor).toBeGreaterThanOrEqual(1);
    expect(response.data!.validFor).toBeLessThanOrEqual(30);
  });

  test("should fail for entry without TOTP", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {
      entryId: entryWithoutTotp,
    })) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("no TOTP");
  });

  test("should fail for non-existent entry", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {
      entryId: "00000000-0000-0000-0000-000000000000",
    })) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("not found");
  });

  test("should fail without entryId", async () => {
    const response = (await client.sendRequest(
      HAEX_PASS_METHODS.GET_TOTP,
      {}
    )) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("entryId");
  });
});
