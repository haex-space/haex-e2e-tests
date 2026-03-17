import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  sendRequestWithRetry,
  HAEX_PASS_METHODS,
} from "../fixtures";

test.describe("haex-pass: create-update-item", () => {
  test.describe.configure({ mode: "serial" });

  let client: VaultBridgeClient;
  let createdEntryId: string;
  const TEST_URL_CREATE = `https://create-test-${Date.now()}.example.com`;
  const TEST_URL_AUTO_TITLE = `https://auto-title-${Date.now()}.example.com`;
  const TEST_URL_SPECIAL = `https://special-chars-${Date.now()}.example.com`;

  test.beforeAll(async () => {
    client = new VaultBridgeClient();
    await waitForBridgeConnection(client);
    await authorizeClient(client, "unused");
  });

  test.afterAll(() => {
    client?.disconnect();
  });

  test("CREATE_ITEM with all fields returns entryId in UUID format", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.CREATE_ITEM, {
      url: TEST_URL_CREATE,
      title: "Create Test Entry",
      username: "createuser",
      password: "createpass!@#$",
      otpSecret: "JBSWY3DPEHPK3PXP",
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.entryId).toBe("string");
    // UUID format: 8-4-4-4-12 hex chars
    expect(response.data.entryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    createdEntryId = response.data.entryId;
  });

  test("created entry appears in GET_ITEMS with all field values matching", async () => {
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
    }>(client, HAEX_PASS_METHODS.GET_ITEMS, {
      url: TEST_URL_CREATE,
    });

    expect(response.success).toBe(true);
    expect(response.data.entries).toHaveLength(1);

    const entry = response.data.entries[0];
    expect(entry.id).toBe(createdEntryId);
    expect(entry.title).toBe("Create Test Entry");
    expect(entry.fields.username).toBe("createuser");
    expect(entry.fields.password).toBe("createpass!@#$");
    expect(entry.url).toBe(TEST_URL_CREATE);
    expect(entry.hasTotp).toBe(true);
  });

  test("CREATE_ITEM with only URL auto-generates title from domain", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.CREATE_ITEM, {
      url: TEST_URL_AUTO_TITLE,
    });

    expect(response.success).toBe(true);
    expect(typeof response.data.entryId).toBe("string");

    // Verify the auto-generated title
    const getResponse = await sendRequestWithRetry<{
      success: boolean;
      data: {
        entries: Array<{ title: string }>;
      };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_ITEMS, {
      url: TEST_URL_AUTO_TITLE,
    });

    expect(getResponse.success).toBe(true);
    expect(getResponse.data.entries).toHaveLength(1);
    // Title should be derived from the domain
    expect(typeof getResponse.data.entries[0].title).toBe("string");
    expect(getResponse.data.entries[0].title.length).toBeGreaterThan(0);
  });

  test("CREATE_ITEM with special characters in password stores correctly", async () => {
    const specialPassword = "p@$$w0rd!<>&\"'\\{}[]|`~";
    const response = await sendRequestWithRetry<{
      success: boolean;
      data: { entryId: string };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.CREATE_ITEM, {
      url: TEST_URL_SPECIAL,
      title: "Special Chars Entry",
      username: "specialuser",
      password: specialPassword,
    });

    expect(response.success).toBe(true);

    // Verify the password was stored and retrieved correctly
    const getResponse = await sendRequestWithRetry<{
      success: boolean;
      data: {
        entries: Array<{
          fields: { password: string };
        }>;
      };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_ITEMS, {
      url: TEST_URL_SPECIAL,
    });

    expect(getResponse.success).toBe(true);
    expect(getResponse.data.entries).toHaveLength(1);
    expect(getResponse.data.entries[0].fields.password).toBe(specialPassword);
  });

  test("UPDATE_ITEM changes specific field and GET_ITEMS returns updated value", async () => {
    const updateResponse = await sendRequestWithRetry<{
      success: boolean;
      requestId: string;
    }>(client, HAEX_PASS_METHODS.UPDATE_ITEM, {
      id: createdEntryId,
      username: "updateduser",
      password: "updatedpass999",
    });

    expect(updateResponse.success).toBe(true);

    // Verify the update
    const getResponse = await sendRequestWithRetry<{
      success: boolean;
      data: {
        entries: Array<{
          id: string;
          title: string;
          fields: {
            username: string;
            password: string;
          };
        }>;
      };
      requestId: string;
    }>(client, HAEX_PASS_METHODS.GET_ITEMS, {
      url: TEST_URL_CREATE,
    });

    expect(getResponse.success).toBe(true);
    expect(getResponse.data.entries).toHaveLength(1);

    const entry = getResponse.data.entries[0];
    expect(entry.id).toBe(createdEntryId);
    // Title should remain unchanged
    expect(entry.title).toBe("Create Test Entry");
    // Updated fields should reflect new values
    expect(entry.fields.username).toBe("updateduser");
    expect(entry.fields.password).toBe("updatedpass999");
  });

  test("UPDATE_ITEM with non-existent ID returns error", async () => {
    const response = await sendRequestWithRetry<{
      success: boolean;
      error?: string;
      requestId: string;
    }>(client, HAEX_PASS_METHODS.UPDATE_ITEM, {
      id: "00000000-0000-0000-0000-000000000000",
      username: "nonexistent",
    });

    expect(response.success).toBe(false);
    expect(typeof response.error).toBe("string");
  });
});
