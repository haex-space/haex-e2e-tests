#!/bin/bash
# =============================================================================
# Fetch E2E version configuration from a project's .e2e-versions.json
#
# Usage:
#   source scripts/fetch-project-versions.sh <project> [ref] [profile]
#
# Arguments:
#   project  - Project name (haex-vault, haextension, vault-sdk, haex-sync-server)
#   ref      - Git reference to fetch config from (default: main)
#   profile  - Version profile to use (default: use 'dependencies')
#
# After sourcing, these environment variables are set:
#   HAEX_VAULT_VERSION
#   HAEXTENSION_VERSION
#   VAULT_SDK_VERSION
#   HAEX_SYNC_SERVER_VERSION
#
# The special value "self" is replaced with the provided ref.
#
# Examples:
#   source scripts/fetch-project-versions.sh haex-vault
#   source scripts/fetch-project-versions.sh haex-vault feat/new-ui
#   source scripts/fetch-project-versions.sh haex-vault main release
# =============================================================================

set -e

# Map project names to GitHub repos
declare -A PROJECT_REPOS=(
    ["haex-vault"]="haex-space/haex-vault"
    ["haextension"]="haex-space/haextension"
    ["vault-sdk"]="haex-space/vault-sdk"
    ["haex-sync-server"]="haex-space/haex-sync-server"
)

# Map JSON keys to environment variable names
declare -A VERSION_VARS=(
    ["haex-vault"]="HAEX_VAULT_VERSION"
    ["haextension"]="HAEXTENSION_VERSION"
    ["vault-sdk"]="VAULT_SDK_VERSION"
    ["haex-sync-server"]="HAEX_SYNC_SERVER_VERSION"
)

# Arguments
PROJECT="${1:-}"
REF="${2:-main}"
PROFILE="${3:-}"

# Validation
if [ -z "$PROJECT" ]; then
    echo "Error: Project name required"
    echo "Usage: source scripts/fetch-project-versions.sh <project> [ref] [profile]"
    echo "Projects: haex-vault, haextension, vault-sdk, haex-sync-server"
    return 1 2>/dev/null || exit 1
fi

REPO="${PROJECT_REPOS[$PROJECT]:-}"
if [ -z "$REPO" ]; then
    echo "Error: Unknown project '$PROJECT'"
    echo "Valid projects: ${!PROJECT_REPOS[*]}"
    return 1 2>/dev/null || exit 1
fi

# Fetch .e2e-versions.json from GitHub
CONFIG_URL="https://raw.githubusercontent.com/${REPO}/${REF}/.e2e-versions.json"
echo "Fetching E2E config from: $CONFIG_URL"

# Temporarily disable exit on error for curl
set +e
CONFIG=$(curl -sfL "$CONFIG_URL" 2>/dev/null)
CURL_EXIT=$?
set -e

if [ $CURL_EXIT -ne 0 ] || [ -z "$CONFIG" ]; then
    echo "Warning: No .e2e-versions.json found in $PROJECT at ref '$REF'"
    echo "Falling back to default versions (main for all)"

    export HAEX_VAULT_VERSION="${HAEX_VAULT_VERSION:-main}"
    export HAEXTENSION_VERSION="${HAEXTENSION_VERSION:-main}"
    export VAULT_SDK_VERSION="${VAULT_SDK_VERSION:-main}"
    export HAEX_SYNC_SERVER_VERSION="${HAEX_SYNC_SERVER_VERSION:-main}"

    # Replace self with the project's ref
    VAR_NAME="${VERSION_VARS[$PROJECT]}"
    export "$VAR_NAME"="$REF"

    echo ""
    echo "Using default versions (self=$REF for $PROJECT):"
    echo "  HAEX_VAULT_VERSION=$HAEX_VAULT_VERSION"
    echo "  HAEXTENSION_VERSION=$HAEXTENSION_VERSION"
    echo "  VAULT_SDK_VERSION=$VAULT_SDK_VERSION"
    echo "  HAEX_SYNC_SERVER_VERSION=$HAEX_SYNC_SERVER_VERSION"
    return 0 2>/dev/null || exit 0
fi

echo "Config loaded successfully"

# Parse JSON - use jq if available, otherwise use basic parsing
if command -v jq &> /dev/null; then
    # Determine which object to read from (profile or dependencies)
    if [ -n "$PROFILE" ]; then
        echo "Using profile: $PROFILE"
        JSON_PATH=".profiles[\"$PROFILE\"]"

        # Check if profile exists
        PROFILE_EXISTS=$(echo "$CONFIG" | jq -r "$JSON_PATH // empty")
        if [ -z "$PROFILE_EXISTS" ]; then
            echo "Warning: Profile '$PROFILE' not found, using default dependencies"
            JSON_PATH=".dependencies"
        fi
    else
        JSON_PATH=".dependencies"
    fi

    # Extract versions
    VAULT_VER=$(echo "$CONFIG" | jq -r "${JSON_PATH}[\"haex-vault\"] // empty")
    EXT_VER=$(echo "$CONFIG" | jq -r "${JSON_PATH}[\"haextension\"] // empty")
    SDK_VER=$(echo "$CONFIG" | jq -r "${JSON_PATH}[\"vault-sdk\"] // empty")
    SYNC_VER=$(echo "$CONFIG" | jq -r "${JSON_PATH}[\"haex-sync-server\"] // empty")
else
    echo "Warning: jq not found, using basic JSON parsing"
    echo "Install jq for better JSON parsing: apt-get install jq"

    # Basic grep-based parsing (not profile-aware)
    extract_version() {
        local key="$1"
        echo "$CONFIG" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | \
            head -1 | sed 's/.*: *"\([^"]*\)".*/\1/'
    }

    VAULT_VER=$(extract_version "haex-vault")
    EXT_VER=$(extract_version "haextension")
    SDK_VER=$(extract_version "vault-sdk")
    SYNC_VER=$(extract_version "haex-sync-server")
fi

# Helper function to resolve version (handles "self")
resolve_version() {
    local version="$1"
    local default="$2"

    if [ "$version" = "self" ]; then
        echo "$REF"
    elif [ -n "$version" ]; then
        echo "$version"
    else
        echo "$default"
    fi
}

# Set environment variables
export HAEX_VAULT_VERSION=$(resolve_version "$VAULT_VER" "main")
export HAEXTENSION_VERSION=$(resolve_version "$EXT_VER" "main")
export VAULT_SDK_VERSION=$(resolve_version "$SDK_VER" "main")
export HAEX_SYNC_SERVER_VERSION=$(resolve_version "$SYNC_VER" "main")

echo ""
echo "Resolved versions from $PROJECT ($REF):"
echo "  HAEX_VAULT_VERSION=$HAEX_VAULT_VERSION"
echo "  HAEXTENSION_VERSION=$HAEXTENSION_VERSION"
echo "  VAULT_SDK_VERSION=$VAULT_SDK_VERSION"
echo "  HAEX_SYNC_SERVER_VERSION=$HAEX_SYNC_SERVER_VERSION"
echo ""
