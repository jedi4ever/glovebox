#!/usr/bin/env bash
# SessionEnd hook — stops and removes the MSB sandbox for this session.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"

EVENT="$(cat)"
SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"

[[ -z "$SESSION_ID" ]] && exit 0

SANDBOX="$(sandbox_name "$SESSION_ID")"
STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"

if [[ -n "$(sandbox_status "$SANDBOX")" ]]; then
  msb stop "$SANDBOX" --quiet 2>/dev/null || true
  msb remove "$SANDBOX" --quiet 2>/dev/null || true
fi

rm -rf "$STATE_DIR" 2>/dev/null || true
