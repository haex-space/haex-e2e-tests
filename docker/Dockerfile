# E2E Test Environment for haex-vault + haex-pass + Browser Extension
#
# Based on webtop for GUI support (needed for Tauri apps)
# Includes: Rust, Node.js, tauri-driver, Playwright browsers
#
# Supports two modes:
# 1. Build from source: Set HAEX_VAULT_REF to a git ref (default)
# 2. Use pre-built binary: Set USE_PREBUILT_VAULT=true and copy binary to prebuilt/haex-vault/

FROM lscr.io/linuxserver/webtop:ubuntu-xfce

# Build arguments for version control
ARG NODE_VERSION=22
ARG HAEX_VAULT_REF=main
ARG HAEXTENSION_REF=main
ARG VAULT_SDK_REF=main
ARG USE_PREBUILT_VAULT=false

ENV DISPLAY=:1
ENV HAEX_VAULT_REF=${HAEX_VAULT_REF}
ENV HAEXTENSION_REF=${HAEXTENSION_REF}
ENV VAULT_SDK_REF=${VAULT_SDK_REF}
ENV USE_PREBUILT_VAULT=${USE_PREBUILT_VAULT}

# Install system dependencies for Tauri
RUN apt-get update && apt-get install -y \
    # Tauri/WebKit dependencies
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    # Additional deps
    git \
    jq \
    unzip \
    # Playwright browser deps
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    # socat for cross-container communication (dual-vault tests)
    socat \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack
RUN corepack enable pnpm

# Install Rust (force install to /root/.cargo since webtop uses /config as HOME)
ENV CARGO_HOME=/root/.cargo
ENV RUSTUP_HOME=/root/.rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install tauri-cli and tauri-driver for E2E testing
RUN /root/.cargo/bin/cargo install tauri-cli tauri-driver

# Install WebKitWebDriver (required for tauri-driver)
RUN apt-get update && apt-get install -y webkit2gtk-driver && rm -rf /var/lib/apt/lists/*

# Install Playwright (set consistent browser path)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx playwright install chromium --with-deps

# Create directories
RUN mkdir -p /app /app/test-results /repos /prebuilt

WORKDIR /repos

# Copy pre-built artifacts (if any) - these are provided by the build context
COPY prebuilt/ /prebuilt/

# Clone haex-vault repository (always needed for Nuxt source code)
RUN git clone --depth 1 --branch ${HAEX_VAULT_REF} https://github.com/haex-space/haex-vault.git || \
    (git clone https://github.com/haex-space/haex-vault.git && cd haex-vault && git checkout ${HAEX_VAULT_REF})

# Clone other repositories
RUN git clone --depth 1 --branch ${HAEXTENSION_REF} https://github.com/haex-space/haextension.git || \
    (git clone https://github.com/haex-space/haextension.git && cd haextension && git checkout ${HAEXTENSION_REF})

RUN git clone --depth 1 --branch ${VAULT_SDK_REF} https://github.com/haex-space/vault-sdk.git || \
    (git clone https://github.com/haex-space/vault-sdk.git && cd vault-sdk && git checkout ${VAULT_SDK_REF})

# Build haex-vault (Nuxt + Tauri app)
WORKDIR /repos/haex-vault
RUN pnpm install

# For E2E tests: Build Nuxt assets for production but configure Tauri for dev-server mode
# This allows us to start a Nuxt dev server and have the Tauri app connect to it
RUN pnpm build

# Modify tauri.conf.json to use devUrl as frontendDist (dev-server mode)
# This makes the production binary connect to http://localhost:3003 instead of embedded assets
# Also update CSP to allow localhost:3003 connections
RUN jq '.build.frontendDist = "http://localhost:3003" | .app.security.csp["default-src"] += ["http://localhost:3003"] | .app.security.csp["script-src"] += ["http://localhost:3003"] | .app.security.csp["style-src"] += ["http://localhost:3003"] | .app.security.csp["connect-src"] += ["http://localhost:3003", "ws://localhost:3003"]' src-tauri/tauri.conf.json > /tmp/tauri.conf.json && \
    mv /tmp/tauri.conf.json src-tauri/tauri.conf.json && \
    cat src-tauri/tauri.conf.json | head -20 && \
    echo "Modified tauri.conf.json to use dev-server mode"

# Build Tauri binary OR use pre-built one
# If USE_PREBUILT_VAULT=true and pre-built binary exists, skip the cargo build
RUN if [ "$USE_PREBUILT_VAULT" = "true" ] && [ -f "/prebuilt/haex-vault/haex-space" ]; then \
      echo "Using pre-built haex-vault binary"; \
      mkdir -p /repos/haex-vault/src-tauri/target/release; \
      cp /prebuilt/haex-vault/haex-space /repos/haex-vault/src-tauri/target/release/haex-space; \
      chmod +x /repos/haex-vault/src-tauri/target/release/haex-space; \
    else \
      echo "Building haex-vault from source (USE_PREBUILT_VAULT=$USE_PREBUILT_VAULT)"; \
      /root/.cargo/bin/cargo tauri build --no-bundle; \
    fi

# Build vault-sdk
WORKDIR /repos/vault-sdk
RUN pnpm install && pnpm build

# Build haextension (monorepo with all core extensions: haex-pass, haex-files, haex-send)
WORKDIR /repos/haextension
RUN pnpm install

# Generate E2E test keypair BEFORE building extensions
# This ensures migrations use the correct table prefix based on our test public key
# The keypair is shared across all extensions for consistency
RUN mkdir -p /tmp/e2e-keys && \
    cd apps/haex-pass && \
    pnpm exec haex keygen -o /tmp/e2e-keys

# Update all extensions with the new test keypair
# Each extension needs its manifest.json and migrations updated
RUN NEW_KEY=$(cat /tmp/e2e-keys/public.key) && \
    echo "Generated E2E test key: $NEW_KEY" && \
    for EXT in haex-pass haex-files haex-send; do \
      EXT_DIR="/repos/haextension/apps/$EXT"; \
      if [ -d "$EXT_DIR/haextension" ]; then \
        echo "Updating $EXT with new keypair..."; \
        # Get old key from manifest
        OLD_KEY=$(jq -r '.publicKey' "$EXT_DIR/haextension/manifest.json" 2>/dev/null || echo ""); \
        if [ -n "$OLD_KEY" ] && [ "$OLD_KEY" != "null" ]; then \
          # Update public.key file
          cp /tmp/e2e-keys/public.key "$EXT_DIR/haextension/public.key"; \
          # Update publicKey in manifest.json
          jq --arg pk "$NEW_KEY" '.publicKey = $pk' "$EXT_DIR/haextension/manifest.json" > /tmp/manifest.json && \
          mv /tmp/manifest.json "$EXT_DIR/haextension/manifest.json"; \
          # Replace old public key prefix in migration SQL files
          if [ -d "$EXT_DIR/app/database/migrations" ]; then \
            find "$EXT_DIR/app/database/migrations" -name "*.sql" -exec sed -i "s/${OLD_KEY}/${NEW_KEY}/g" {} \; ; \
            echo "  Updated migrations for $EXT"; \
          fi; \
        fi; \
      fi; \
    done

# Nuxt needs prepare step to generate tsconfig files for all packages
WORKDIR /repos/haextension/packages/haex-ui
RUN pnpm exec nuxt prepare || true

# Prepare each extension app
WORKDIR /repos/haextension
RUN for EXT in haex-pass haex-files haex-send; do \
      if [ -d "apps/$EXT" ]; then \
        echo "Preparing $EXT..."; \
        cd "apps/$EXT" && pnpm exec nuxt prepare || true; \
        cd /repos/haextension; \
      fi; \
    done

# Build all extensions
RUN pnpm --filter haex-pass build
RUN pnpm --filter haex-files build || echo "haex-files build skipped (may not exist yet)"
RUN pnpm --filter haex-send build || echo "haex-send build skipped (may not exist yet)"
RUN pnpm --filter haex-pass-browser build

# Package all extensions for E2E tests
# Sign with the previously generated test keypair
RUN for EXT in haex-pass haex-files haex-send; do \
      EXT_DIR="/repos/haextension/apps/$EXT"; \
      if [ -d "$EXT_DIR/.output/public" ]; then \
        echo "Signing $EXT..."; \
        cd "$EXT_DIR" && \
        pnpm exec haex sign .output/public -k /tmp/e2e-keys/private.key -o "/app/$EXT.haex" || \
        echo "Warning: haex sign failed for $EXT"; \
      fi; \
    done

# Copy the extension public key for E2E tests to use in requests
# Named haex-pass-public.key since haex-pass is the primary extension being tested
RUN cp /tmp/e2e-keys/public.key /app/haex-pass-public.key

# Copy test files from build context
WORKDIR /app
COPY tests/ /app/tests/
COPY fixtures/ /app/fixtures/
COPY scripts/ /app/scripts/
COPY package.json /app/
COPY tsconfig.json /app/
COPY playwright.config.ts /app/

# Copy custom init script for auto-starting services
# webtop's s6-overlay will run this on container start
COPY docker/custom-cont-init.d/ /custom-cont-init.d/
RUN chmod +x /custom-cont-init.d/*.sh

# Install test dependencies
RUN pnpm install

# Link vault-sdk for type imports
RUN pnpm link /repos/vault-sdk

EXPOSE 3003 19455 4444

# webtop base image already has ENTRYPOINT ["/init"], no CMD needed
