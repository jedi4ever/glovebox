#!/usr/bin/env bash
# Claude Code PostToolUse hook — fast bash entry point.
# Delegates to JS handler for MSB SDK cleanup/audit.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"

case "$TOOL_NAME" in
  mcp__*|WebSearch|WebFetch)
    exit 0
    ;;
esac

HANDLER="$PLUGIN_ROOT/handlers/post-tool-use.js"

if [[ ! -f "$HANDLER" ]]; then
  echo "cc-msb: post-tool-use handler not found, skipping" >&2
  exit 0
fi

printf '%s' "$EVENT" | node "$HANDLER"
