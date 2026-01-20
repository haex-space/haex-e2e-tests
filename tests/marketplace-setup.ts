/**
 * Marketplace Setup for E2E Tests
 *
 * This script publishes the haex-pass extension to the marketplace
 * so it can be installed via the UI during tests.
 */

import * as fs from "node:fs";

// Marketplace API URLs
// When running inside Docker containers, use container names; otherwise use localhost
const isDocker = process.env.CI === "true" || process.env.VAULT_INSTANCE !== undefined;

const EFFECTIVE_MARKETPLACE_URL = isDocker
  ? (process.env.MARKETPLACE_URL || "http://marketplace:3001")
  : (process.env.MARKETPLACE_URL || "http://localhost:3001");

const EFFECTIVE_MARKETPLACE_SUPABASE_URL = isDocker
  ? (process.env.MARKETPLACE_SUPABASE_URL || "http://marketplace-kong:8000")
  : (process.env.MARKETPLACE_SUPABASE_URL || "http://localhost:8001");

const MARKETPLACE_ANON_KEY = process.env.MARKETPLACE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImUyZS1tYXJrZXRwbGFjZSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzY4MDI5NDU5LCJleHAiOjIwODMzODk0NTl9.VvC8RSjadUOn9Jy_QHn-eJ0FPQNjkigglfNPuvGLzI8";

// Test user credentials
const TEST_EMAIL = "e2e-publisher@haex.space";
const TEST_PASSWORD = "e2e-test-password-12345";

// Extension bundle path (created by Dockerfile)
const HAEX_PASS_BUNDLE = "/app/haex-pass.haex";
const HAEX_PASS_PUBLIC_KEY_FILE = "/app/haex-pass-public.key";

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Sign up or sign in test publisher user
 */
async function authenticatePublisher(): Promise<AuthTokens> {
  console.log("[Marketplace Setup] Authenticating publisher user...");

  // Try to sign up first
  let response = await fetch(`${EFFECTIVE_MARKETPLACE_SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": MARKETPLACE_ANON_KEY,
    },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }),
  });

  let data = await response.json();

  // If signup fails (user exists), try signin
  if (!response.ok || !data.access_token) {
    console.log("[Marketplace Setup] User may exist, trying sign in...");

    response = await fetch(`${EFFECTIVE_MARKETPLACE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": MARKETPLACE_ANON_KEY,
      },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    });

    data = await response.json();

    if (!response.ok) {
      throw new Error(`Authentication failed: ${JSON.stringify(data)}`);
    }
  }

  console.log("[Marketplace Setup] Publisher authenticated successfully");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

/**
 * Create publisher profile
 */
async function createPublisherProfile(accessToken: string): Promise<void> {
  console.log("[Marketplace Setup] Creating publisher profile...");

  const response = await fetch(`${EFFECTIVE_MARKETPLACE_URL}/publishers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      displayName: "E2E Test Publisher",
      slug: "e2e-test",
      description: "Publisher for E2E testing",
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    // Check if profile already exists
    if (response.status === 409 && data.error?.includes("already exists")) {
      console.log("[Marketplace Setup] Publisher profile already exists");
      return;
    }
    throw new Error(`Failed to create publisher: ${JSON.stringify(data)}`);
  }

  console.log("[Marketplace Setup] Publisher profile created:", data.publisher?.slug);
}

/**
 * Get haex-pass manifest
 */
function getHaexPassManifest(): Record<string, unknown> {
  const publicKey = fs.readFileSync(HAEX_PASS_PUBLIC_KEY_FILE, "utf-8").trim();

  return {
    name: "haex-pass",
    version: "1.4.31",
    author: "haex",
    entry: "index.html",
    icon: "haextension/haex-pass-logo.png",
    publicKey: publicKey,
    signature: "",
    permissions: {
      database: [],
      filesystem: [],
      http: [{ target: "https://icons.duckduckgo.com/*" }],
      shell: [],
    },
    homepage: null,
    description: "A password manager for HaexSpace",
    singleInstance: true,
    displayMode: "auto",
    migrationsDir: "database/migrations",
  };
}

/**
 * Create extension in marketplace
 */
async function createExtension(accessToken: string): Promise<void> {
  console.log("[Marketplace Setup] Creating extension...");

  const publicKey = fs.readFileSync(HAEX_PASS_PUBLIC_KEY_FILE, "utf-8").trim();

  const response = await fetch(`${EFFECTIVE_MARKETPLACE_URL}/publish/extensions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      publicKey: publicKey,
      name: "haex-pass",
      slug: "haex-pass",
      shortDescription: "A password manager for HaexSpace",
      description: "haex-pass is a secure password manager extension for haex-vault.",
      tags: ["password", "security", "manager"],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    // Check if extension already exists
    if (response.status === 409) {
      console.log("[Marketplace Setup] Extension already exists");
      return;
    }
    throw new Error(`Failed to create extension: ${JSON.stringify(data)}`);
  }

  console.log("[Marketplace Setup] Extension created:", data.extension?.slug);
}

/**
 * Upload extension bundle
 */
async function uploadExtensionBundle(accessToken: string): Promise<void> {
  console.log("[Marketplace Setup] Uploading extension bundle...");

  if (!fs.existsSync(HAEX_PASS_BUNDLE)) {
    throw new Error(`Extension bundle not found at ${HAEX_PASS_BUNDLE}`);
  }

  const bundleData = fs.readFileSync(HAEX_PASS_BUNDLE);
  const manifest = getHaexPassManifest();

  // Create form data
  const formData = new FormData();
  formData.append("bundle", new Blob([bundleData]), "haex-pass.haex");
  formData.append("version", manifest.version as string);
  formData.append("manifest", JSON.stringify(manifest));

  const response = await fetch(`${EFFECTIVE_MARKETPLACE_URL}/publish/extensions/haex-pass/bundle`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
    body: formData,
  });

  const data = await response.json();

  if (!response.ok) {
    // Check if version already exists
    if (response.status === 409 && data.error?.includes("already exists")) {
      console.log("[Marketplace Setup] Version already exists");
      return;
    }
    throw new Error(`Failed to upload bundle: ${JSON.stringify(data)}`);
  }

  console.log("[Marketplace Setup] Bundle uploaded, version:", data.version?.version);
}

/**
 * Wait for marketplace to be healthy
 */
async function waitForMarketplace(timeout = 60000): Promise<void> {
  console.log("[Marketplace Setup] Waiting for marketplace to be ready...");
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${EFFECTIVE_MARKETPLACE_URL}/health`);
      if (response.ok) {
        console.log("[Marketplace Setup] Marketplace is healthy");
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Marketplace did not become healthy within timeout");
}

/**
 * Main setup function
 */
export async function setupMarketplace(): Promise<void> {
  console.log("=== Setting up Marketplace for E2E Tests ===");

  // Wait for marketplace to be ready
  await waitForMarketplace();

  // Authenticate publisher
  const tokens = await authenticatePublisher();

  // Create publisher profile
  await createPublisherProfile(tokens.accessToken);

  // Create extension
  await createExtension(tokens.accessToken);

  // Upload bundle
  await uploadExtensionBundle(tokens.accessToken);

  console.log("=== Marketplace Setup Complete ===");
}

// Run setup if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupMarketplace().catch((error) => {
    console.error("Marketplace setup failed:", error);
    process.exit(1);
  });
}
