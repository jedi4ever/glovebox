#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"

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
      SANDBOX="$(sandbox_name "$SESSION_ID")"
      sandbox_write_from_shadow "$SANDBOX" "$FILE_PATH" "$VM_PATH" || true
    fi
    exit 0
    ;;
esac

exit 0
