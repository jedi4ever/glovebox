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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

EVENT="$(cat 2>/dev/null || true)"
SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty' 2>/dev/null || true)"
[[ -z "$SESSION_ID" ]] && exit 0

command -v msb >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

# Resolve main session config (no agent_type) in one Node.js call.
CFG="$(node "$PLUGIN_ROOT/lib/config.mjs" "$PROJECT_DIR" "")"
EFFECTIVE_SCOPE="$(printf '%s' "$CFG"        | jq -r '.scope')"
EFFECTIVE_SANDBOX_NAME="$(printf '%s' "$CFG" | jq -r '.sandboxName // empty')"

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
CREATE_PAYLOAD="$(printf '%s' "$CFG" | jq -c --arg pd "$PROJECT_DIR" --arg n "$SANDBOX" '. + {projectDir: $pd, sandboxName: $n}')"
sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" \
  "$CREATE_PAYLOAD" >/dev/null 2>&1 || exit 0

# Track for cleanup unless persistent (named-with-name / directory).
if [[ "$EFFECTIVE_SCOPE" != "directory" ]] && \
   [[ "$EFFECTIVE_SCOPE" != "named" || -z "$EFFECTIVE_SANDBOX_NAME" ]]; then
  sandbox_track "$SESSION_ID" "$SANDBOX"
fi

# Introspect the sandbox. Seven lines: pwd, uname -s, uname -m, $SHELL,
# $HOME, $USER (whoami), and /etc/os-release PRETTY_NAME.
INFO="$(msb exec "$SANDBOX" -- bash -c \
  'printf "%s\n%s\n%s\n%s\n%s\n%s\n%s\n" "$(pwd)" "$(uname -s)" "$(uname -m)" "$SHELL" "$HOME" "$(whoami 2>/dev/null || printf %s "$USER")" "$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"' \
  2>/dev/null)" || exit 0

SB_PWD="$(printf '%s\n' "$INFO" | sed -n '1p')"
SB_KERNEL="$(printf '%s\n' "$INFO" | sed -n '2p')"
SB_ARCH="$(printf '%s\n' "$INFO" | sed -n '3p')"
SB_SHELL="$(printf '%s\n' "$INFO" | sed -n '4p')"
SB_HOME="$(printf '%s\n' "$INFO" | sed -n '5p')"
SB_USER="$(printf '%s\n' "$INFO" | sed -n '6p')"
SB_OS="$(printf '%s\n' "$INFO" | sed -n '7p')"
[[ -z "$SB_OS" ]] && SB_OS="${SB_KERNEL} (MSB sandbox)"

CTX="# cc-msb Sandbox Environment (OVERRIDES host \`# Environment\` block)

Every Bash, Read, Write, and Edit tool call is routed through an MSB sandbox. The host \`# Environment\` block above describes the machine Claude Code itself runs on — it is **not** where your tool calls execute. Do not reference the host's user name, home directory, working directory, OS, shell, or any \`/Users/*\` paths when answering questions about the environment you are working in.

Sandbox environment:
- Operating system: ${SB_OS}
- Kernel: ${SB_KERNEL}
- Architecture: ${SB_ARCH}
- User: ${SB_USER}
- Home directory: ${SB_HOME}
- Shell: ${SB_SHELL}
- Working directory: ${SB_PWD}
- Sandbox name: ${SANDBOX}
- Scope: ${EFFECTIVE_SCOPE}

When asked about your user / name / home directory / working directory / OS / shell / platform — answer with these sandbox values."

jq -nc --arg ctx "$CTX" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
