import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
} from "../fixtures";

test.describe("haex-pass: totp-generation", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let totpEntryId: string;
  let noTotpEntryId: string;
  const TEST_URL_TOTP = `https://totp-test-${Date.now()}.example.com`;
  const TEST_URL_NO_TOTP = `https://no-totp-test-${Date.now()}.example.com`;

  test.beforeAll(async () => {
    client = new VaultBridgeClient();
    await waitForBridgeConnection(client);
    await authorizeClient(client, "unused");

    // Create entry WITH TOTP secret (standard test vector)
    const totpResponse = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
    }>(client, HAEX_PASS_METHODS.CREATE_ITEM, {
      url: TEST_URL_TOTP,
      title: "TOTP Test Entry",
      username: "totpuser",
      password: "totppass",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(totpResponse.success).toBe(true);
    totpEntryId = totpResponse.data.entryId;

    // Create entry WITHOUT TOTP secret
    const noTotpResponse = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
    }>(client, HAEX_PASS_METHODS.CREATE_ITEM, {
      url: TEST_URL_NO_TOTP,
      title: "No TOTP Entry",
      username: "nototpuser",
      password: "nototppass",
    });
    expect(noTotpResponse.success).toBe(true);
    noTotpEntryId = noTotpResponse.data.entryId;
  });

  test.afterAll(() => {
    client?.disconnect();
  });

  test("GET_TOTP returns 6-digit code", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { code: string; validFor: number };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: totpEntryId,
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.code).toBe("string");
    expect(response.data.code).toMatch(/^\d{6}$/);
  });

  test("GET_TOTP returns validFor between 1 and 30", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { code: string; validFor: number };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: totpEntryId,
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.validFor).toBe("number");
    expect(response.data.validFor).toBeGreaterThanOrEqual(1);
    expect(response.data.validFor).toBeLessThanOrEqual(30);
  });

  test("two sequential GET_TOTP calls within same period return same code", async () => {
    const response1 = await sendRequestWithRetry<{
      success: boolean;
      data: { code: string; validFor: number };
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: totpEntryId,
    });

    // Only compare if there's enough time left in the period to avoid boundary crossings
    if (response1.data.validFor >= 3) {
      const response2 = await sendRequestWithRetry<{
        success: boolean;
        data: { code: string; validFor: number };
      }>(client, HAEX_PASS_METHODS.GET_TOTP, {
        entryId: totpEntryId,
      });

      expect(response1.data.code).toBe(response2.data.code);
    }
    // If validFor < 3, we're too close to the period boundary, so skip comparison
    // The first two tests already validate the TOTP format and range independently
  });

  test("GET_TOTP for entry without TOTP returns error", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: noTotpEntryId,
    });

    expect(response.success).toBe(false);
    expect(typeof response.error).toBe("string");
    // Error message should indicate no TOTP is configured
    expect(response.error!.toLowerCase()).toMatch(/totp|otp|secret/);
  });

  test("GET_TOTP for non-existent entry returns error", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: "00000000-0000-0000-0000-000000000000",
    });

    expect(response.success).toBe(false);
    expect(typeof response.error).toBe("string");
    // Error message should indicate entry was not found
    expect(response.error!.toLowerCase()).toMatch(/not found|not exist|unknown/);
  });
});
