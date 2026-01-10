#!/bin/bash
# Resolve version presets to actual git refs
#
# Usage:
#   source scripts/resolve-versions.sh [preset]
#
# Presets:
#   release  - Latest release tags from GitHub
#   nightly  - Nightly branch (or main if not available)
#   main     - Main branch (default)
#
# After sourcing, these environment variables are set:
#   HAEX_VAULT_VERSION
#   HAEXTENSION_VERSION
#   VAULT_SDK_VERSION
#   HAEX_SYNC_SERVER_VERSION

set -e

# GitHub API helper to get latest release tag
get_latest_release() {
    local repo="$1"
    local tag

    tag=$(curl -s "https://api.github.com/repos/${repo}/releases/latest" | \
          grep '"tag_name":' | \
          sed -E 's/.*"([^"]+)".*/\1/')

    if [ -z "$tag" ] || [ "$tag" = "null" ]; then
        echo "main"  # Fallback to main if no release found
    else
        echo "$tag"
    fi
}

# GitHub API helper to check if branch exists
branch_exists() {
    local repo="$1"
    local branch="$2"

    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" \
             "https://api.github.com/repos/${repo}/branches/${branch}")

    [ "$status" = "200" ]
}

# Resolve preset
PRESET="${1:-${VERSION_PRESET:-main}}"

echo "Resolving versions for preset: $PRESET"

case "$PRESET" in
    release)
        echo "Fetching latest release tags from GitHub..."

        export HAEX_VAULT_VERSION=$(get_latest_release "haex-space/haex-vault")
        export HAEXTENSION_VERSION=$(get_latest_release "haex-space/haextension")
        export VAULT_SDK_VERSION=$(get_latest_release "haex-space/vault-sdk")
        export HAEX_SYNC_SERVER_VERSION=$(get_latest_release "haex-space/haex-sync-server")
        ;;

    nightly)
        echo "Using nightly branches (fallback to main)..."

        # Check if nightly branch exists, otherwise use main
        if branch_exists "haex-space/haex-vault" "nightly"; then
            export HAEX_VAULT_VERSION="nightly"
        else
            export HAEX_VAULT_VERSION="main"
        fi

        if branch_exists "haex-space/haextension" "nightly"; then
            export HAEXTENSION_VERSION="nightly"
        else
            export HAEXTENSION_VERSION="main"
        fi

        if branch_exists "haex-space/vault-sdk" "nightly"; then
            export VAULT_SDK_VERSION="nightly"
        else
            export VAULT_SDK_VERSION="main"
        fi

        if branch_exists "haex-space/haex-sync-server" "nightly"; then
            export HAEX_SYNC_SERVER_VERSION="nightly"
        else
            export HAEX_SYNC_SERVER_VERSION="main"
        fi
        ;;

    main|*)
        # Use main or keep existing values
        export HAEX_VAULT_VERSION="${HAEX_VAULT_VERSION:-main}"
        export HAEXTENSION_VERSION="${HAEXTENSION_VERSION:-main}"
        export VAULT_SDK_VERSION="${VAULT_SDK_VERSION:-main}"
        export HAEX_SYNC_SERVER_VERSION="${HAEX_SYNC_SERVER_VERSION:-main}"
        ;;
esac

echo ""
echo "Resolved versions:"
echo "  HAEX_VAULT_VERSION=$HAEX_VAULT_VERSION"
echo "  HAEXTENSION_VERSION=$HAEXTENSION_VERSION"
echo "  VAULT_SDK_VERSION=$VAULT_SDK_VERSION"
echo "  HAEX_SYNC_SERVER_VERSION=$HAEX_SYNC_SERVER_VERSION"
echo ""
