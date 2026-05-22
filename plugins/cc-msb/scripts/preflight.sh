#!/usr/bin/env bash
set -euo pipefail

MISSING=()

check_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    MISSING+=("$cmd")
  fi
}

check_cmd node
check_cmd jq
check_cmd msb

if [[ ${#MISSING[@]} -gt 0 ]]; then
  LIST=""
  for cmd in "${MISSING[@]}"; do
    LIST="$LIST\n  - $cmd"
  done

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "WARNING: cc-msb plugin is missing required tools:${LIST}\n\nPlease install the missing tools before using this plugin. Sandbox enforcement is DISABLED for this session."
  }
}
EOF
  exit 0
fi

VERSIONS="node=$(node --version), jq=$(jq --version), msb=$(msb --version 2>&1 | head -1)"
EDIT_HINT="Edit is not available for files inside the sandbox — use Bash to edit them."

jq -nc --arg ctx "cc-msb sandbox is active ($VERSIONS). $EDIT_HINT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
