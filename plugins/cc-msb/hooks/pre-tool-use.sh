#!/usr/bin/env bash
# Claude Code PreToolUse hook — fast bash entry point.
# Delegates to JS handler for MSB SDK calls.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;
esac

HANDLER="$PLUGIN_ROOT/handlers/pre-tool-use.js"

if [[ ! -f "$HANDLER" ]]; then
  echo '{"decision":"block","reason":"cc-msb handler not found — check plugin installation"}'
  exit 2
fi

printf '%s' "$EVENT" | node "$HANDLER"
