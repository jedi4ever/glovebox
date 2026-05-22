#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"
# shellcheck source=../lib/config.sh
. "$PLUGIN_ROOT/lib/config.sh"
# shellcheck source=../lib/emit.sh
. "$PLUGIN_ROOT/lib/emit.sh"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
config_load "$PROJECT_DIR"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"
AGENT_TYPE="$(printf '%s' "$EVENT" | jq -r '.agent_type // empty')"
EFFECTIVE_IMAGE="$(config_agent_image "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;

  Bash)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    COMMAND="$(printf '%s' "$EVENT" | jq -r '.tool_input.command // empty')"
    [[ -z "$SESSION_ID" || -z "$COMMAND" ]] && exit 0

    SANDBOX="$(sandbox_name_for "$SESSION_ID" "$AGENT_TYPE")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" "$EFFECTIVE_IMAGE" || {
      emit_deny "cc-msb: failed to start sandbox (see $STATE_DIR/sandbox.log)"
      exit 0
    }
    sandbox_track "$SESSION_ID" "$SANDBOX"

    if [[ "${CC_MSB_SCOPE:-session}" == "ephemeral" && -n "$AGENT_TYPE" ]]; then
      emit_allow_rewrite "$(sandbox_wrap_command_ephemeral "$SANDBOX" "$COMMAND")"
    else
      emit_allow_rewrite "$(sandbox_wrap_command "$SANDBOX" "$COMMAND")"
    fi
    exit 0
    ;;

  Read)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    FILE_PATH="$(printf '%s' "$EVENT" | jq -r '.tool_input.file_path // empty')"
    [[ -z "$SESSION_ID" || -z "$FILE_PATH" ]] && exit 0

    SANDBOX="$(sandbox_name_for_file_op "$SESSION_ID" "$AGENT_TYPE")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"

    if [[ "$SANDBOX_NEEDS_SYNC" == "yes" ]]; then
      sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" "$EFFECTIVE_IMAGE" || {
        emit_deny "cc-msb: failed to start sandbox for read of $FILE_PATH"
        exit 0
      }
      sandbox_track "$SESSION_ID" "$SANDBOX"
      sandbox_read_into_shadow "$SANDBOX" "$FILE_PATH" "$SANDBOX_HOST_PATH" || {
        emit_deny "cc-msb: cannot read $FILE_PATH from sandbox"
        exit 0
      }
    fi

    emit_allow_file_path "$SANDBOX_HOST_PATH" "$EVENT"
    exit 0
    ;;

  Write)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    FILE_PATH="$(printf '%s' "$EVENT" | jq -r '.tool_input.file_path // empty')"
    [[ -z "$SESSION_ID" || -z "$FILE_PATH" ]] && exit 0

    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"
    emit_allow_file_path "$SANDBOX_HOST_PATH" "$EVENT"
    exit 0
    ;;
esac

HANDLER="$PLUGIN_ROOT/handlers/pre-tool-use.js"
[[ -f "$HANDLER" ]] || { echo '{"decision":"block","reason":"cc-msb handler not found"}'; exit 2; }
printf '%s' "$EVENT" | node "$HANDLER"
