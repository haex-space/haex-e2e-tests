import * as crypto from "crypto";
import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * Decode an RFC 4648 base32 string (optionally padded, case-insensitive).
 * Throws if the input contains characters outside the alphabet.
 */
function decodeBase32(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/, "").toUpperCase();
  const bits: number[] = [];
  for (const ch of cleaned) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new Error(`Invalid base32 character: ${ch}`);
    for (let i = 4; i >= 0; i--) bits.push((value >> i) & 1);
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Compute a TOTP code per RFC 6238 / RFC 4226. Mirrors the algorithm any
 * spec-compliant implementation must follow, so we can cross-check the
 * vault's output without needing to mock its clock.
 */
function computeTotpReference(
  secretBase32: string,
  atSeconds: number,
  digits = 6,
  period = 30,
): string {
  const secret = decodeBase32(secretBase32);
  const counter = Math.floor(atSeconds / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;

  const code = truncated % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

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

  test("GET_TOTP matches RFC 6238 reference implementation for the current period", async () => {
    // Capture the local time as close to the vault call as possible so we
    // compute the reference for the same 30-second window the vault used.
    const atSeconds = Math.floor(Date.now() / 1000);
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { code: string; validFor: number };
    }>(client, HAEX_PASS_METHODS.GET_TOTP, {
      entryId: totpEntryId,
    });

    expect(response.success).toBe(true);

    // If the period is about to roll over the vault may have crossed into
    // the next window between our sample and its computation — skip the
    // cross-check in that case. The deterministic tests above still cover
    // format and stability; the reference match only fires when we have
    // enough slack.
    if (response.data.validFor < 5) {
      test.skip(true, "Not enough slack in TOTP window for reference check");
      return;
    }

    const expected = computeTotpReference("JBSWY3DPEHPK3PXP", atSeconds);
    expect(response.data.code).toBe(expected);
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
