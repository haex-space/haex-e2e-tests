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
import { TEST_ENTRIES } from "../../fixtures/test-data";

/**
 * E2E Tests for haex-pass get-items API
 *
 * Tests the complete flow:
 * 1. Connect to bridge
 * 2. Authorize client
 * 3. Create test data via set-item
 * 4. Verify get-items returns correct data
 */

const EXTENSION_ID = "haex-pass";

// Generic API response wrapper
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
}

interface LoginEntry {
  id: string;
  title: string;
  hasTotp: boolean;
  fields: {
    username?: string;
    password?: string;
    url?: string;
  };
}

interface GetLoginsResponse {
  entries: LoginEntry[];
}

test.describe("get-items", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;

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

    // Wait for extension to be fully ready before running tests
    const ready = await waitForExtensionReady(client);
    if (!ready) {
      throw new Error("Extension failed to become ready");
    }
  });

  test.afterAll(async () => {
    client?.disconnect();
  });

  test("setup: create test entries via set-item", async () => {
    for (const entry of TEST_ENTRIES) {
      // Use retry logic for set-item requests
      const response = (await sendRequestWithRetry(
        client,
        HAEX_PASS_METHODS.SET_ITEM,
        {
          url: entry.url,
          title: entry.title,
          username: entry.username,
          password: entry.password,
          groupId: entry.groupId,
          // Include TOTP secret if available
          otpSecret: entry.otpSecret,
          otpDigits: entry.otpDigits,
          otpPeriod: entry.otpPeriod,
          otpAlgorithm: entry.otpAlgorithm,
        },
        { maxAttempts: 3, initialDelay: 1000 }
      )) as ApiResponse;

      expect(response.success).toBe(true);
    }
  });

  test("should return empty array when no logins match URL", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://nonexistent-site-12345.com",
    })) as ApiResponse<GetLoginsResponse>;

    expect(response.success).toBe(true);
    expect(response.data?.entries).toHaveLength(0);
  });

  test("should return matching logins for saved URL", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://github.com/login",
    })) as ApiResponse<GetLoginsResponse>;

    expect(response.success).toBe(true);
    expect(response.data?.entries.length).toBeGreaterThan(0);

    const githubEntry = response.data?.entries.find(
      (e) => e.title === "GitHub"
    );
    expect(githubEntry).toBeDefined();
    expect(githubEntry?.fields.username).toBe("testuser");
  });

  test("should match entries by domain regardless of path", async () => {
    // Test that entries match on domain regardless of subpath
    const response = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://github.com/settings/profile",
    })) as ApiResponse<GetLoginsResponse>;

    expect(response.success).toBe(true);
    const githubEntry = response.data?.entries.find(
      (e) => e.title === "GitHub"
    );
    expect(githubEntry).toBeDefined();
  });

  test("should filter by OTP field and indicate TOTP availability", async () => {
    // Test filtering by OTP field - only returns entries with TOTP
    const filteredResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://accounts.google.com",
      fields: ["otp"],
    })) as ApiResponse<GetLoginsResponse>;

    expect(filteredResponse.success).toBe(true);
    expect(filteredResponse.data?.entries.length).toBeGreaterThan(0);
    filteredResponse.data?.entries.forEach((entry) => {
      expect(entry.hasTotp).toBe(true);
    });

    // Also verify hasTotp flag is correctly set on unfiltered response
    const unfilteredResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://accounts.google.com",
    })) as ApiResponse<GetLoginsResponse>;

    expect(unfilteredResponse.success).toBe(true);
    const googleEntry = unfilteredResponse.data?.entries.find(
      (e) => e.title === "Google Account"
    );
    expect(googleEntry).toBeDefined();
    expect(googleEntry?.hasTotp).toBe(true);
  });

  test("should fail without URL", async () => {
    const response = (await client.sendRequest(
      HAEX_PASS_METHODS.GET_ITEMS,
      {}
    )) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("url");
  });
});
