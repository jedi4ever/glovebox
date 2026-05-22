#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"
# shellcheck source=../lib/emit.sh
. "$PLUGIN_ROOT/lib/emit.sh"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;

  Bash)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    COMMAND="$(printf '%s' "$EVENT" | jq -r '.tool_input.command // empty')"
    [[ -z "$SESSION_ID" || -z "$COMMAND" ]] && exit 0

    SANDBOX="$(sandbox_name "$SESSION_ID")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
    mkdir -p "$STATE_DIR"

    sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" || {
      emit_deny "cc-msb: failed to start sandbox (see $STATE_DIR/sandbox.log)"
      exit 0
    }

    emit_allow_rewrite "$(sandbox_wrap_command "$SANDBOX" "$COMMAND")"
    exit 0
    ;;
esac

HANDLER="$PLUGIN_ROOT/handlers/pre-tool-use.js"
[[ -f "$HANDLER" ]] || { echo '{"decision":"block","reason":"cc-msb handler not found"}'; exit 2; }
printf '%s' "$EVENT" | node "$HANDLER"
