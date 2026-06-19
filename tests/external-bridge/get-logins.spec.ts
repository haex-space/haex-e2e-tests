import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  BRIDGE_METHODS,
} from "../fixtures";

test.describe("external-bridge: get-logins", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  const TEST_URL_GITHUB = `https://github-${Date.now()}.example`;
  const TEST_URL_GITLAB = `https://gitlab-${Date.now()}.example`;

  test.beforeAll(async () => {
    client = new VaultBridgeClient();
    await waitForBridgeConnection(client);
    await authorizeClient(client, "unused");

    // Create test entries with unique URLs to avoid interference from retries
    await sendRequestWithRetry(client, BRIDGE_METHODS.CREATE_ITEM, {
      url: TEST_URL_GITHUB,
      title: "GitHub",
      username: "ghuser",
      password: "ghpass123",
    });

    await sendRequestWithRetry(client, BRIDGE_METHODS.CREATE_ITEM, {
      url: TEST_URL_GITHUB,
      title: "GitHub Work",
      username: "ghworkuser",
      password: "ghworkpass456",
    });

    await sendRequestWithRetry(client, BRIDGE_METHODS.CREATE_ITEM, {
      url: TEST_URL_GITLAB,
      title: "GitLab",
      username: "gluser",
      password: "glpass789",
    });
  });

  test.afterAll(() => {
    client?.disconnect();
  });

  test("GET_ITEMS with matching URL returns correct entries", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { entries: Array<{ fields: { username: string; password: string }; title: string }> };
      requestId: string;
    }>(client, BRIDGE_METHODS.GET_ITEMS, {
      url: TEST_URL_GITHUB,
    });

    expect(response.success).toBe(true);
    expect(response.data.entries).toHaveLength(2);

    const usernames = response.data.entries.map((e) => e.fields.username);
    expect(usernames).toContain("ghuser");
    expect(usernames).toContain("ghworkuser");

    const passwords = response.data.entries.map((e) => e.fields.password);
    expect(passwords).toContain("ghpass123");
    expect(passwords).toContain("ghworkpass456");
  });

  test("GET_ITEMS with non-matching URL returns empty entries array", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { entries: unknown[] };
      requestId: string;
    }>(client, BRIDGE_METHODS.GET_ITEMS, {
      url: "https://nonexistent-site-e2e.example.org",
    });

    expect(response.success).toBe(true);
    expect(response.data.entries).toHaveLength(0);
  });

  test("GET_ITEMS entries have all expected fields", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: {
        entries: Array<{
          id: string;
          title: string;
          url: string | null;
          hasTotp: boolean;
          fields: Record<string, string>;
        }>;
      };
      requestId: string;
    }>(client, BRIDGE_METHODS.GET_ITEMS, {
      url: TEST_URL_GITLAB,
    });

    expect(response.success).toBe(true);
    expect(response.data.entries).toHaveLength(1);

    const entry = response.data.entries[0];
    // Verify all expected fields exist and have correct types/values
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.title).toBe("GitLab");
    expect(typeof entry.hasTotp).toBe("boolean");
    expect(entry.hasTotp).toBe(false);
    expect(entry.fields.username).toBe("gluser");
    expect(entry.fields.password).toBe("glpass789");
    // url is a top-level attribute on the entry, not inside fields
    expect(entry.url).toBe(TEST_URL_GITLAB);
  });

  test("GET_ITEMS without url parameter returns error", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
      requestId: string;
    }>(client, BRIDGE_METHODS.GET_ITEMS, {});

    expect(response.success).toBe(false);
    expect(typeof response.error).toBe("string");
  });
});
