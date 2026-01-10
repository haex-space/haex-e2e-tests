import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * E2E Tests for haex-pass get-totp API
 *
 * Tests TOTP code generation with various configurations.
 */

const EXTENSION_ID = "haex-pass";

// Generic API response wrapper
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

  // Store entry IDs from setup
  let entryWithTotp6: string;
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
  });

  test.afterAll(async () => {
    client?.disconnect();
  });

  test("setup: create test entries for TOTP tests", async () => {
    // Entry with default TOTP (6 digits, SHA1, 30s)
    const resp1 = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      title: "TOTP Test 6-digit",
      url: "https://totp-test-6.example.com",
      username: "user6",
      password: "pass6",
    })) as ApiResponse<SetLoginResponse>;
    expect(resp1.success).toBe(true);
    entryWithTotp6 = resp1.data!.entryId;

    // Entry without TOTP
    const resp2 = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      title: "No TOTP Entry",
      url: "https://no-totp.example.com",
      username: "nototp",
      password: "nototp",
    })) as ApiResponse<SetLoginResponse>;
    expect(resp2.success).toBe(true);
    entryWithoutTotp = resp2.data!.entryId;
  });

  test("should return valid 6-digit TOTP code", async () => {
    // Note: This test requires the entry to have TOTP configured
    // which set-item doesn't support yet
    test.skip(true, "set-item does not support TOTP configuration");

    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {
      entryId: entryWithTotp6,
    })) as ApiResponse<GetTotpResponse>;

    expect(response.success).toBe(true);
    expect(response.data!.code).toMatch(/^\d{6}$/);
    expect(response.data!.validFor).toBeGreaterThan(0);
    expect(response.data!.validFor).toBeLessThanOrEqual(30);
  });

  test("should return correct validFor countdown", async () => {
    test.skip(true, "set-item does not support TOTP configuration");

    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {
      entryId: entryWithTotp6,
    })) as ApiResponse<GetTotpResponse>;

    expect(response.success).toBe(true);
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
      entryId: "non-existent-entry-id-12345",
    })) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("not found");
  });

  test("should fail without entryId", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_TOTP, {})) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("entryId");
  });
});
