# E2E Test Environment for haex-vault + haex-pass + Browser Extension
#
# Uses pre-built base image with all system deps (webtop, Node.js, Rust,
# tauri-driver, Playwright deps). See Dockerfile.base for the base image.
#
# Supports two modes:
# 1. Build from source: Set HAEX_VAULT_REF to a git ref (default)
# 2. Use pre-built binary: Set USE_PREBUILT_VAULT=true and copy binary to prebuilt/haex-vault/

FROM ghcr.io/haex-space/haex-e2e-base:latest

ARG HAEX_VAULT_REF=main
ARG HAEXTENSION_REF=main
ARG VAULT_SDK_REF=main
ARG USE_PREBUILT_VAULT=false
ARG USE_LOCAL_VAULT=false

ENV DISPLAY=:1
ENV HAEX_VAULT_REF=${HAEX_VAULT_REF}
ENV HAEXTENSION_REF=${HAEXTENSION_REF}
ENV VAULT_SDK_REF=${VAULT_SDK_REF}
ENV USE_PREBUILT_VAULT=${USE_PREBUILT_VAULT}
ENV USE_LOCAL_VAULT=${USE_LOCAL_VAULT}

WORKDIR /repos

# Copy pre-built artifacts (if any) - these are provided by the build context
COPY prebuilt/ /prebuilt/

# Stage local haex-vault sources from named build context `local-vault`.
# When USE_LOCAL_VAULT=false, `local-vault` points at ./docker/dummy-vault/
# (a harmless placeholder), so this COPY is cheap and inert.
# When USE_LOCAL_VAULT=true, the context points at the user's checkout and
# the following RUN block uses it instead of git clone.
COPY --from=local-vault . /tmp/local-vault/

# Obtain haex-vault source: either copy from local mount or clone from GitHub.
# Local copy takes precedence so developers can test in-flight branches
# without pushing to origin.
RUN if [ "$USE_LOCAL_VAULT" = "true" ] && [ -d "/tmp/local-vault/src-tauri" ]; then \
      echo "Using local haex-vault sources from mounted context"; \
      cp -a /tmp/local-vault /repos/haex-vault; \
      # Strip build artefacts that would bloat the image or collide with \
      # in-container builds. node_modules/target are always regenerated. \
      rm -rf /repos/haex-vault/node_modules \
             /repos/haex-vault/src-tauri/target \
             /repos/haex-vault/.nuxt \
             /repos/haex-vault/.output; \
    else \
      echo "Cloning haex-vault @ ${HAEX_VAULT_REF} from GitHub"; \
      git clone --depth 1 --branch ${HAEX_VAULT_REF} https://github.com/haex-space/haex-vault.git /repos/haex-vault || \
        (git clone https://github.com/haex-space/haex-vault.git /repos/haex-vault && cd /repos/haex-vault && git checkout ${HAEX_VAULT_REF}); \
    fi; \
    rm -rf /tmp/local-vault

# Clone other repositories
RUN git clone --depth 1 --branch ${HAEXTENSION_REF} https://github.com/haex-space/haextension.git || \
    (git clone https://github.com/haex-space/haextension.git && cd haextension && git checkout ${HAEXTENSION_REF})

RUN git clone --depth 1 --branch ${VAULT_SDK_REF} https://github.com/haex-space/vault-sdk.git || \
    (git clone https://github.com/haex-space/vault-sdk.git && cd vault-sdk && git checkout ${VAULT_SDK_REF})

# Build haex-vault (Nuxt + Tauri app)
WORKDIR /repos/haex-vault

# Update CSP to allow Docker internal hostnames for E2E testing
# The vault app's CSP blocks requests to non-whitelisted hosts
# We need to allow sync-kong, marketplace-kong, etc. for E2E tests
# Note: CSP wildcards like host:* may not work in WebKit, so we add specific ports
RUN jq '.app.security.csp["connect-src"] += ["http://sync-kong:8000", "http://sync-server:3002", "http://marketplace:3001", "http://marketplace-kong:8000", "ws://sync-kong:8000", "ws://sync-server:3002", "wss://sync-kong:8000", "wss://sync-server:3002"]' \
    src-tauri/tauri.conf.json > /tmp/tauri.conf.json && \
    mv /tmp/tauri.conf.json src-tauri/tauri.conf.json

RUN pnpm install

# Generate static Nuxt assets (SSG) - Tauri embeds these into the binary.
# Note: `cargo tauri build` also runs `pnpm generate` via beforeBuildCommand,
# but we run it here first so the prebuilt-binary path has assets available too.
RUN pnpm generate

# Build Tauri binary OR use pre-built one
# If USE_PREBUILT_VAULT=true and pre-built binary exists, skip the cargo build
RUN if [ "$USE_PREBUILT_VAULT" = "true" ] && [ -f "/prebuilt/haex-vault/haex-vault" ]; then \
      echo "Using pre-built haex-vault binary"; \
      mkdir -p /repos/haex-vault/src-tauri/target/release; \
      cp /prebuilt/haex-vault/haex-vault /repos/haex-vault/src-tauri/target/release/haex-vault; \
      chmod +x /repos/haex-vault/src-tauri/target/release/haex-vault; \
      if [ -d "/prebuilt/haex-vault/database" ]; then \
        echo "Using pre-built database migrations resources"; \
        cp -r /prebuilt/haex-vault/database /repos/haex-vault/src-tauri/target/release/; \
      else \
        echo "WARNING: no database/ in /prebuilt/haex-vault/ — migrations may fail"; \
      fi; \
      # Tauri's resource_dir() checks for .cargo-lock next to the exe to detect \
      # cargo output directories and returns exe_dir instead of /usr/lib/<name>/. \
      # Without this marker, BaseDirectory::Resource resolves to /usr/lib/haex-vault/ \
      # and migrations fail to load. \
      touch /repos/haex-vault/src-tauri/target/release/.cargo-lock; \
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

# Install Playwright browsers AFTER pnpm install (avoids "install dependencies first" warning)
# This ensures @playwright/test is installed before downloading browsers
RUN pnpm exec playwright install chromium --with-deps

# Link vault-sdk for type imports
RUN pnpm link /repos/vault-sdk

EXPOSE 3003 19455 4444

# webtop base image already has ENTRYPOINT ["/init"], no CMD needed
