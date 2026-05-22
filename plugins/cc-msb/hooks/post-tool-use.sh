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

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;

  Write)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    FILE_PATH="$(printf '%s' "$EVENT" | jq -r '.tool_input.file_path // empty')"
    [[ -z "$SESSION_ID" || -z "$FILE_PATH" ]] && exit 0

    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    SHADOW_ROOT="$STATE_DIR/shadow"

    # Only sync if the file was written to a shadow path (VM-only file)
    if [[ "$FILE_PATH" == "$SHADOW_ROOT"/* ]]; then
      VM_PATH="${FILE_PATH#"$SHADOW_ROOT"}"
      SANDBOX="$(sandbox_name_for_file_op "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME")"
      sandbox_write_from_shadow "$SANDBOX" "$FILE_PATH" "$VM_PATH" || true
    fi
    exit 0
    ;;
esac

exit 0
