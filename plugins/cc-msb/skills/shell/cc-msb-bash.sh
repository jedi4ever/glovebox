#!/usr/bin/env bash
# cc-msb-bash.sh — drop-in shim for /bin/bash.
#
# When invoked as `cc-msb-bash -c <cmd>`, forwards <cmd> into the
# current Claude Code session's cc-msb MSB sandbox via `msb exec`.
# Intended use is via CLAUDE_CODE_SHELL so the input-box `!` prefix
# executes inside the same sandbox as Claude's Bash tool calls.
#
# Falls back to real bash when:
#   - invoked in any mode other than `-c <cmd>` (interactive, login,
#     script file, etc.)
#   - <cmd> already looks like a sandbox-rewritten command from cc-msb's
#     PreToolUse:Bash hook (avoids double-wrapping)
#   - no live cc-msb sandbox is running
#
# Activate by adding to your project's `.claude/settings.json`:
#
#   {
#     "env": {
#       "CLAUDE_CODE_SHELL": "<absolute path to this file>"
#     }
#   }
#
# Note: ${CLAUDE_PLUGIN_ROOT} only expands inside MCP/LSP/hook `command`
# fields, NOT inside `env` values. You have to hard-code the path.
# Discover it with: find "$HOME/.claude/plugins" -name cc-msb-bash.sh

set -uo pipefail

HOST_BASH="${CC_MSB_HOST_BASH:-/bin/bash}"

# Opt-in invocation log. When CC_MSB_SHELL_TRACE_LOG is set, append a single
# line per invocation: `<iso-timestamp>\t<argc>\t<first-arg-or-->`. Used by
# the integration test to prove CC honored CLAUDE_CODE_SHELL; harmless in
# production unless the var is set.
if [ -n "${CC_MSB_SHELL_TRACE_LOG:-}" ]; then
  printf '%s\t%s\t%s\n' "$(date -Iseconds 2>/dev/null || date)" "$#" "${1:--}" \
    >>"$CC_MSB_SHELL_TRACE_LOG" 2>/dev/null || true
fi

# Normalise the invocation into "CMD = a single command string we should
# run" or hand the whole thing off to real bash and exit.
case "$#" in
  0)
    exec "$HOST_BASH"
    ;;
  1)
    case "$1" in
      -*)
        # bash flag (-l, -i, --version, ...): defer
        exec "$HOST_BASH" "$@"
        ;;
    esac
    if [ -e "$1" ]; then
      # Real path on disk: defer (it's a script file)
      exec "$HOST_BASH" "$@"
    fi
    # Otherwise: a command string passed without -c. Rewrite to -c form.
    CMD="$1"
    shift 1
    ;;
  *)
    if [ "$1" = "-c" ]; then
      CMD="$2"
      shift 2
      case "$CMD" in
        -*)
          # `bash -c -l ...` — defer the whole invocation to real bash.
          exec "$HOST_BASH" -c "$CMD" "$@"
          ;;
      esac
    else
      exec "$HOST_BASH" "$@"
    fi
    ;;
esac

# Pass through if this is already a cc-msb sandbox rewrite from the
# Bash PreToolUse hook (`printf '%s' '<b64>' | base64 -d | msb exec '<name>' -- bash`).
# Without this guard, a Bash-tool call would be wrapped twice.
case "$CMD" in
  *"| msb exec "*"-- bash"*)
    exec "$HOST_BASH" -c "$CMD" "$@"
    ;;
esac

# Find the newest running cc-msb-* sandbox. If multiple Claude sessions
# are alive this picks the most recently created one — the same heuristic
# gondolin-sandbox uses for its daemon-socket selection.
SANDBOX=""
if command -v msb >/dev/null 2>&1; then
  SANDBOX="$(msb list 2>/dev/null | awk '/^cc-msb-/ && /running/ {print $1; exit}')"
fi

if [ -z "$SANDBOX" ]; then
  exec "$HOST_BASH" -c "$CMD" "$@"
fi

# Redirect stdin from /dev/null. `msb exec` inherits stdin from the shim,
# which CC connects to its pty — without closing it, msb's session holds
# stdin open after the inner bash command has produced its output, so msb
# exec never returns and CC's TUI shows the command "Running…" forever.
exec msb exec "$SANDBOX" -- bash -c "$CMD" < /dev/null
