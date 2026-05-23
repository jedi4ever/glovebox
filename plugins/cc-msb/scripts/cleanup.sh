# DEPRECATED: replaced by cleanup.mjs — kept for reference only, not sourced by any hook.
#!/usr/bin/env bash
# SessionEnd hook — stops and removes all MSB sandboxes created for this session.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"

EVENT="$(cat)"
SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"

[[ -z "$SESSION_ID" ]] && exit 0

STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
SANDBOX_LIST="$STATE_DIR/sandboxes"

remove_sandbox() {
  local name="$1"
  [[ -z "$name" ]] && return
  if [[ -n "$(sandbox_status "$name")" ]]; then
    msb stop "$name" --quiet 2>/dev/null || true
    msb remove "$name" --quiet 2>/dev/null || true
  fi
}

if [[ -f "$SANDBOX_LIST" ]]; then
  sort -u "$SANDBOX_LIST" | while IFS= read -r name; do
    remove_sandbox "$name"
  done
else
  # Fallback for sessions that predate sandbox tracking
  remove_sandbox "$(sandbox_name "$SESSION_ID")"
fi

rm -rf "$STATE_DIR" 2>/dev/null || true
