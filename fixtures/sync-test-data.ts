/**
 * Test fixtures for sync E2E tests
 *
 * Provides test data for multi-device sync scenarios,
 * conflict resolution tests, and extension filtering tests
 */

/**
 * Test entry for sync scenarios
 */
export interface SyncTestEntry {
  id: string;
  title: string;
  url: string;
  username: string;
  password: string;
  groupId?: string | null;
}

/**
 * Entries for multi-device sync tests
 * Device A and Device B simulate two separate haex-vault instances
 */
export const MULTI_DEVICE_ENTRIES = {
  /**
   * Entry created on Device A
   */
  deviceA: {
    id: "sync-test-device-a",
    title: "Device A Entry",
    url: "https://device-a-test.example.com",
    username: "deviceA_user",
    password: "deviceA_pass_123",
    groupId: null,
  } as SyncTestEntry,

  /**
   * Entry created on Device B
   */
  deviceB: {
    id: "sync-test-device-b",
    title: "Device B Entry",
    url: "https://device-b-test.example.com",
    username: "deviceB_user",
    password: "deviceB_pass_456",
    groupId: null,
  } as SyncTestEntry,

  /**
   * Entry that both devices will modify (for conflict testing)
   */
  shared: {
    id: "sync-test-shared",
    title: "Shared Entry",
    url: "https://shared-test.example.com",
    username: "shared_user",
    password: "shared_pass_original",
    groupId: null,
  } as SyncTestEntry,
};

/**
 * Entries for conflict resolution tests
 */
export const CONFLICT_TEST_ENTRIES = {
  /**
   * Base entry before any modifications
   */
  base: {
    id: "conflict-test-base",
    title: "Conflict Test Entry",
    url: "https://conflict-test.example.com",
    username: "conflict_user",
    password: "original_password",
    groupId: null,
  } as SyncTestEntry,

  /**
   * Modification from Device A - changes password
   */
  modifiedByA: {
    id: "conflict-test-base",
    title: "Conflict Test Entry",
    url: "https://conflict-test.example.com",
    username: "conflict_user",
    password: "password_from_device_A",
    groupId: null,
  } as SyncTestEntry,

  /**
   * Modification from Device B - changes username
   * Both modifications should merge (different columns)
   */
  modifiedByB: {
    id: "conflict-test-base",
    title: "Conflict Test Entry",
    url: "https://conflict-test.example.com",
    username: "username_from_device_B",
    password: "original_password",
    groupId: null,
  } as SyncTestEntry,

  /**
   * Conflicting modification from Device B - also changes password
   * Should be resolved by HLC (newer wins)
   */
  conflictingModification: {
    id: "conflict-test-base",
    title: "Conflict Test Entry",
    url: "https://conflict-test.example.com",
    username: "conflict_user",
    password: "password_from_device_B_conflicting",
    groupId: null,
  } as SyncTestEntry,
};

/**
 * Extension permission configurations for filtering tests
 */
export const EXTENSION_PERMISSIONS = {
  /**
   * Extension with full database access (wildcard)
   */
  fullAccess: {
    extensionId: "test-extension-full",
    permissions: {
      database: ["*"],
    },
  },

  /**
   * Extension with prefix-based access (only haex_passwords_* tables)
   */
  passwordsOnly: {
    extensionId: "test-extension-passwords",
    permissions: {
      database: ["haex_passwords_*"],
    },
  },

  /**
   * Extension with specific table access
   */
  specificTables: {
    extensionId: "test-extension-specific",
    permissions: {
      database: [
        "haex_passwords_item_details",
        "haex_passwords_groups",
      ],
    },
  },

  /**
   * Extension without database access
   */
  noAccess: {
    extensionId: "test-extension-no-db",
    permissions: {
      database: [],
    },
  },
};

/**
 * Tables that should be synced for password manager
 */
export const PASSWORD_TABLES = [
  "haex_passwords_item_details",
  "haex_passwords_item_key_values",
  "haex_passwords_item_history",
  "haex_passwords_groups",
  "haex_passwords_group_items",
];

/**
 * Generate a unique test entry with timestamp
 */
export function generateUniqueTestEntry(prefix: string = "sync-test"): SyncTestEntry {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(7);

  return {
    id: `${prefix}-${timestamp}-${randomSuffix}`,
    title: `Test Entry ${timestamp}`,
    url: `https://${prefix}-${timestamp}.example.com`,
    username: `user_${randomSuffix}`,
    password: `pass_${timestamp}_${randomSuffix}`,
    groupId: null,
  };
}

/**
 * Generate multiple unique test entries
 */
export function generateTestEntries(count: number, prefix: string = "sync-test"): SyncTestEntry[] {
  return Array.from({ length: count }, (_, i) =>
    generateUniqueTestEntry(`${prefix}-${i}`)
  );
}
