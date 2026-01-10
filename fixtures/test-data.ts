/**
 * Test fixtures for haex-pass E2E tests
 *
 * These entries will be created before tests run
 */

export interface TestEntry {
  id: string;
  title: string;
  url: string | null;
  username: string | null;
  password: string | null;
  otpSecret: string | null;
  otpDigits?: number;
  otpPeriod?: number;
  otpAlgorithm?: string;
  groupId: string | null;
  keyValues?: { key: string; value: string }[];
}

export const TEST_ENTRIES: TestEntry[] = [
  // Basic entry with username/password
  {
    id: "test-entry-github",
    title: "GitHub",
    url: "https://github.com",
    username: "testuser",
    password: "testpass123",
    otpSecret: null,
    groupId: null,
  },

  // Entry with TOTP (default settings: 6 digits, 30s, SHA1)
  {
    id: "test-entry-google",
    title: "Google Account",
    url: "https://accounts.google.com",
    username: "testuser@gmail.com",
    password: "googlepass456",
    otpSecret: "JBSWY3DPEHPK3PXP", // Test secret
    groupId: null,
  },

  // Entry with custom TOTP settings (8 digits, SHA256)
  {
    id: "test-entry-aws",
    title: "AWS Console",
    url: "https://console.aws.amazon.com",
    username: "aws-admin",
    password: "awspass789",
    otpSecret: "GEZDGNBVGY3TQOJQ",
    otpDigits: 8,
    otpPeriod: 30,
    otpAlgorithm: "SHA256",
    groupId: null,
  },

  // Entry with custom key-value fields
  {
    id: "test-entry-server",
    title: "Production Server",
    url: "https://server.example.com",
    username: "admin",
    password: "serverpass",
    otpSecret: null,
    groupId: null,
    keyValues: [
      { key: "ssh-key", value: "~/.ssh/id_rsa" },
      { key: "port", value: "2222" },
    ],
  },

  // Entry without URL (manual entry)
  {
    id: "test-entry-wifi",
    title: "Office WiFi",
    url: null,
    username: null,
    password: "wifi-password-123",
    otpSecret: null,
    groupId: null,
  },

  // Entry for subdomain matching test
  {
    id: "test-entry-gitlab",
    title: "GitLab Work",
    url: "https://gitlab.company.com",
    username: "workuser",
    password: "workpass",
    otpSecret: null,
    groupId: null,
  },
];

export const TEST_GROUPS = [
  {
    id: "test-group-work",
    name: "Work",
    parentId: null,
  },
  {
    id: "test-group-personal",
    name: "Personal",
    parentId: null,
  },
];
