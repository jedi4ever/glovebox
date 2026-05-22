#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"
# shellcheck source=../lib/config.sh
. "$PLUGIN_ROOT/lib/config.sh"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
config_load "$PROJECT_DIR"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"
AGENT_TYPE="$(printf '%s' "$EVENT" | jq -r '.agent_type // empty')"
EFFECTIVE_SANDBOX_NAME="$(config_agent_sandbox_name "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SCOPE="$(config_agent_scope "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"

# scope=host: nothing to sync — tools ran directly on the host.
if [[ "$EFFECTIVE_SCOPE" == "host" ]]; then
  exit 0
fi

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;

  Write|Edit|MultiEdit)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    FILE_PATH="$(printf '%s' "$EVENT" | jq -r '.tool_input.file_path // empty')"
    [[ -z "$SESSION_ID" || -z "$FILE_PATH" ]] && exit 0

    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    SHADOW_ROOT="$STATE_DIR/shadow"

    SANDBOX="$(sandbox_name_for_file_op "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"

    if [[ "$FILE_PATH" == "$SHADOW_ROOT"/* ]]; then
      # Shadow fallback: file was redirected to shadow (e.g. non-writable host path); sync shadow → sandbox
      VM_PATH="${FILE_PATH#"$SHADOW_ROOT"}"
      sandbox_write_from_shadow "$SANDBOX" "$FILE_PATH" "$VM_PATH" || true
    elif [[ "$FILE_PATH" == /* && "$FILE_PATH" != "$PROJECT_DIR"/* && "$FILE_PATH" != /workspace/* ]]; then
      # Transparent path: file was written/edited at original host path; sync host → sandbox
      sandbox_write_from_shadow "$SANDBOX" "$FILE_PATH" "$FILE_PATH" || true
    fi
    exit 0
    ;;
esac

exit 0
