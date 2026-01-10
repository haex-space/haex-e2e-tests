import {
  test,
  expect,
  VaultBridgeClient,
  waitForBridgeConnection,
  authorizeClient,
  HAEX_PASS_METHODS,
} from "../fixtures";

/**
 * E2E Tests for haex-pass set-item API
 *
 * Tests creating new password entries via the browser bridge
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

test.describe("set-item", () => {
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
  });

  test.afterAll(async () => {
    client?.disconnect();
  });

  test("should create entry with URL and credentials", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://test-create.example.com",
      title: "Test Create Entry",
      username: "testcreate",
      password: "testcreatepass",
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
    expect(response.data!.entryId).toBeDefined();
    expect(response.data!.title).toBe("Test Create Entry");

    // Verify entry appears in get-items
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://test-create.example.com",
    })) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);
    const entry = getResponse.data!.entries.find(
      (e) => e.id === response.data!.entryId
    );
    expect(entry).toBeDefined();
    expect(entry!.fields.username).toBe("testcreate");
  });

  test("should auto-generate title from URL domain", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://auto-title-test.example.com/login",
      username: "autotitle",
      password: "autotitlepass",
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);
    expect(response.data!.title).toBe("auto-title-test.example.com");
  });

  test("should create entry with title only", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      title: "Title Only Entry",
      username: "titleonly",
      password: "titleonlypass",
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);
    expect(response.data!.entryId).toBeDefined();
    expect(response.data!.title).toBe("Title Only Entry");
  });

  test("should fail without URL or title", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      username: "nourl",
      password: "nourlpass",
    })) as ApiResponse;

    expect(response.success).toBe(false);
    expect(response.error).toContain("url or title");
  });

  test("should create entry in root when groupId is null", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://root-entry.example.com",
      title: "Root Entry",
      username: "rootuser",
      password: "rootpass",
      groupId: null,
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);
    expect(response.data!.entryId).toBeDefined();
  });

  test("should return valid UUID as entry ID", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://uuid-test.example.com",
      title: "UUID Test",
      username: "uuidtest",
      password: "uuidtestpass",
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);

    // Verify UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(response.data!.entryId).toMatch(uuidRegex);
  });

  test("should handle special characters in credentials", async () => {
    const response = (await client.sendRequest(HAEX_PASS_METHODS.SET_ITEM, {
      url: "https://special-chars.example.com",
      title: "Special <>&\"' Characters",
      username: "user@example.com",
      password: "p@$$w0rd!#%&*(){}[]",
    })) as ApiResponse<SetLoginResponse>;

    expect(response.success).toBe(true);

    // Verify the entry was created correctly
    const getResponse = (await client.sendRequest(HAEX_PASS_METHODS.GET_ITEMS, {
      url: "https://special-chars.example.com",
    })) as ApiResponse<GetLoginsResponse>;

    expect(getResponse.success).toBe(true);
    const entry = getResponse.data!.entries.find(
      (e) => e.id === response.data!.entryId
    );
    expect(entry).toBeDefined();
    expect(entry!.fields.username).toBe("user@example.com");
    expect(entry!.fields.password).toBe("p@$$w0rd!#%&*(){}[]");
  });
});
