#!/usr/bin/env bash
# SessionStart hook: pre-create/boot the main session sandbox so the first
# Bash call isn't cold, then introspect the sandbox environment and emit it
# as `additionalContext` so Claude knows it's working inside a Linux MSB
# sandbox — not on the host macOS/Linux box that Claude Code itself runs on.
#
# This is the cc-msb equivalent of the gondolin-sandbox `boot.sh` hook.
set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"
# shellcheck source=../lib/config.sh
. "$PLUGIN_ROOT/lib/config.sh"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
config_load "$PROJECT_DIR"

EVENT="$(cat 2>/dev/null || true)"
SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "$SESSION_ID" ]] && exit 0

command -v msb >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

# Resolve main session config (no agent_type)
EFFECTIVE_IMAGE="$(config_agent_image "" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SANDBOX_NAME="$(config_agent_sandbox_name "" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SCOPE="$(config_agent_scope "" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_MOUNT_WORKDIR="$(config_agent_mount_workdir "" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_NETWORK="$(config_agent_network "" "$PROJECT_DIR/.cc-msb.yml")"

# scope=host: nothing to boot. Just tell Claude that tools run on the host.
if [[ "$EFFECTIVE_SCOPE" == "host" ]]; then
  jq -nc --arg ctx "cc-msb: main scope is \`host\` — Bash/Read/Write/Edit run directly on the host, not in a sandbox. The system \`# Environment\` block above is authoritative." \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  exit 0
fi

SANDBOX="$(sandbox_name_for "$SESSION_ID" "" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
mkdir -p "$STATE_DIR"

# Pre-create / start the sandbox. Silently bail on any failure — the per-call
# hooks will recover or surface the error at that point.
sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" \
  "$EFFECTIVE_IMAGE" "$EFFECTIVE_MOUNT_WORKDIR" "$EFFECTIVE_NETWORK" >/dev/null 2>&1 || exit 0

# Track for cleanup unless persistent (named-with-name / directory).
if [[ "$EFFECTIVE_SCOPE" != "directory" ]] && \
   [[ "$EFFECTIVE_SCOPE" != "named" || -z "$EFFECTIVE_SANDBOX_NAME" ]]; then
  sandbox_track "$SESSION_ID" "$SANDBOX"
fi

# Introspect the sandbox. Five lines: pwd, uname -s, uname -m, $SHELL, PRETTY_NAME.
INFO="$(msb exec "$SANDBOX" -- bash -c \
  'printf "%s\n%s\n%s\n%s\n%s\n" "$(pwd)" "$(uname -s)" "$(uname -m)" "$SHELL" "$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"' \
  2>/dev/null)" || exit 0

SB_PWD="$(printf '%s\n' "$INFO" | sed -n '1p')"
SB_KERNEL="$(printf '%s\n' "$INFO" | sed -n '2p')"
SB_ARCH="$(printf '%s\n' "$INFO" | sed -n '3p')"
SB_SHELL="$(printf '%s\n' "$INFO" | sed -n '4p')"
SB_OS="$(printf '%s\n' "$INFO" | sed -n '5p')"
[[ -z "$SB_OS" ]] && SB_OS="${SB_KERNEL} (MSB sandbox)"

CTX="# cc-msb Sandbox Environment (OVERRIDES host \`# Environment\` block)

Every Bash, Read, Write, and Edit tool call is routed through an MSB sandbox. The host \`# Environment\` block above describes the machine that Claude Code itself runs on — it is **not** where your tool calls execute, and you must not reference it when answering questions about the OS, shell, cwd, or platform you are working in.

Sandbox environment:
- Operating system: ${SB_OS}
- Kernel: ${SB_KERNEL}
- Architecture: ${SB_ARCH}
- Shell: ${SB_SHELL}
- Working directory: ${SB_PWD}
- Sandbox name: ${SANDBOX}
- Scope: ${EFFECTIVE_SCOPE}

When asked \"what OS / platform / shell / cwd am I on?\", answer with the sandbox values above."

jq -nc --arg ctx "$CTX" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
