# DEPRECATED: replaced by pre-tool-use.mjs — kept for reference only, not sourced by any hook.
#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=../lib/sandbox.sh
. "$PLUGIN_ROOT/lib/sandbox.sh"
# shellcheck source=../lib/emit.sh
. "$PLUGIN_ROOT/lib/emit.sh"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

EVENT="$(cat)"
TOOL_NAME="$(printf '%s' "$EVENT" | jq -r '.tool_name')"
AGENT_TYPE="$(printf '%s' "$EVENT" | jq -r '.agent_type // empty')"

# Resolve all config in one Node.js call (replaces ~20 individual config_agent_* calls).
CFG="$(node "$PLUGIN_ROOT/lib/config.mjs" "$PROJECT_DIR" "${AGENT_TYPE:-}")"
EFFECTIVE_SCOPE="$(printf '%s' "$CFG"        | jq -r '.scope')"
EFFECTIVE_SANDBOX_NAME="$(printf '%s' "$CFG" | jq -r '.sandboxName // empty')"
EFFECTIVE_PASS_ENV="$(printf '%s' "$CFG"     | jq -r '.passEnv')"
EFFECTIVE_AUTO_RECREATE="$(printf '%s' "$CFG"| jq -r '.autoRecreate | tostring')"
# Base payload for create-sandbox.mjs: config JSON + projectDir.
# sandboxName is injected per-handler (it requires SESSION_ID + scope + agent).
CFG_BASE="$(printf '%s' "$CFG" | jq -c --arg pd "$PROJECT_DIR" '. + {projectDir: $pd}')"

# Handle a drift signal from sandbox_ensure_running. Either:
#   (a) auto_recreate=true → run the SDK-backed recreate script in place;
#       on success, rewrite the fingerprint and return so the caller can
#       continue. Image changes can't go through this path (snapshot pins
#       the base image), so fall through to deny in that case.
#   (b) otherwise → emit deny with the standard recreate instructions.
# Called from each tool-handler branch right after sandbox_ensure_running.
handle_drift_if_any() {
  [[ -z "${SANDBOX_CONFIG_DRIFT:-}" ]] && return 0
  local name="$SANDBOX_CONFIG_DRIFT"

  if [[ "$EFFECTIVE_AUTO_RECREATE" == "true" ]]; then
    local recreate_out
    recreate_out="$(printf '%s' "$CREATE_PAYLOAD" \
      | node "$PLUGIN_ROOT/scripts/recreate-sandbox.mjs" 2>>"$STATE_DIR/recreate.log")" || true
    local ok image_changed recreate_err
    ok="$(printf '%s' "$recreate_out" | jq -r '.ok // false' 2>/dev/null || echo "false")"
    image_changed="$(printf '%s' "$recreate_out" | jq -r '.imageChanged // false' 2>/dev/null || echo "false")"
    recreate_err="$(printf '%s' "$recreate_out" | jq -r '.error // ""' 2>/dev/null || echo "")"
    if [[ "$ok" == "true" ]]; then
      # Recreate succeeded — rewrite the fingerprint from the current payload.
      # config.mjs already applied github expansion, so CREATE_PAYLOAD has
      # post-expansion network/secrets — matches what sandbox_ensure_running sees.
      local new_fp fp_path
      new_fp="$(sandbox_config_fingerprint \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.image // "ubuntu"')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r 'if .mountWorkdir then "true" else "false" end')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.network // "enabled"')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.ports // ""')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.secrets // ""')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.onSecretViolation // ""')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r 'if .tlsIntercept then "true" else "false" end')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.tlsInterceptPort // "" | tostring | sub("^null$";"") ')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.tlsBypass // ""')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r 'if .trustHostCas then "true" else "false" end')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.gitUserName // ""')" \
        "$(printf '%s' "$CREATE_PAYLOAD" | jq -r '.gitUserEmail // ""')")"
      fp_path="$(sandbox_fingerprint_path "$name")"
      mkdir -p "$(dirname "$fp_path")"
      printf '%s\n' "$new_fp" > "$fp_path"
      SANDBOX_CONFIG_DRIFT=""
      return 0
    fi
    # Recreate failed. If because of image change, fall through to deny;
    # otherwise still deny but mention the script log.
    if [[ "$image_changed" == "true" ]]; then
      emit_deny "cc-msb: settings changed AND image changed for sandbox '$name'. Image swaps require a full recreate (state outside /workspace will be lost). Run: \`msb stop '$name' && msb remove '$name'\` — your next tool call will recreate it from scratch."
    else
      emit_deny "cc-msb: auto_recreate failed for sandbox '$name': $recreate_err. Manual recreate: \`msb stop '$name' && msb remove '$name'\`."
    fi
    exit 0
  fi

  emit_deny "cc-msb: settings in .cc-msb.yml changed since sandbox '$name' was created. msb applies most flags (image, network, ports, secrets, tls_*) only at create time, so the running sandbox still uses the old config. To apply: \`msb stop '$name' && msb remove '$name'\` — your next tool call will recreate it. Files in /workspace are bind-mounted and unaffected; other in-sandbox state (apt installs, /etc edits) will be lost. (Set \`auto_recreate: true\` to do this automatically while preserving state.)"
  exit 0
}

# scope=host: pass through every tool call unmodified — no sandbox, no shadow,
# no rewrites. The agent runs directly on the host.
if [[ "$EFFECTIVE_SCOPE" == "host" ]]; then
  exit 0
fi

case "$TOOL_NAME" in
  mcp__*|WebSearch|Agent)
    exit 0
    ;;

  Bash)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    COMMAND="$(printf '%s' "$EVENT" | jq -r '.tool_input.command // empty')"
    [[ -z "$SESSION_ID" || -z "$COMMAND" ]] && exit 0
    [[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || exit 0

    SANDBOX="$(sandbox_name_for "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    CREATE_PAYLOAD="$(printf '%s' "$CFG_BASE" | jq -c --arg n "$SANDBOX" '.sandboxName = $n')"
    sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" "$CREATE_PAYLOAD" || {
      emit_deny "cc-msb: failed to start sandbox (see $STATE_DIR/sandbox.log)"
      exit 0
    }
    handle_drift_if_any
    # named and directory sandboxes persist across sessions — don't add to cleanup list
    if [[ "$EFFECTIVE_SCOPE" != "directory" ]] && [[ "$EFFECTIVE_SCOPE" != "named" || -z "$EFFECTIVE_SANDBOX_NAME" ]]; then
      sandbox_track "$SESSION_ID" "$SANDBOX"
    fi

    SANDBOX_BASH_ENV_ARGS=()
    while IFS= read -r line; do
      [[ -n "$line" ]] && SANDBOX_BASH_ENV_ARGS+=("$line")
    done < <(sandbox_env_args "$EFFECTIVE_PASS_ENV")

    if [[ "$EFFECTIVE_SCOPE" == "per-run" ]]; then
      emit_allow_rewrite "$(sandbox_wrap_command_ephemeral "$SANDBOX" "$COMMAND" ${SANDBOX_BASH_ENV_ARGS[@]+"${SANDBOX_BASH_ENV_ARGS[@]}"})"
    else
      emit_allow_rewrite "$(sandbox_wrap_command "$SANDBOX" "$COMMAND" ${SANDBOX_BASH_ENV_ARGS[@]+"${SANDBOX_BASH_ENV_ARGS[@]}"})"
    fi
    exit 0
    ;;

  Read)
    SESSION_ID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty')"
    FILE_PATH="$(printf '%s' "$EVENT" | jq -r '.tool_input.file_path // empty')"
    [[ -z "$SESSION_ID" || -z "$FILE_PATH" ]] && exit 0
    [[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || exit 0

    SANDBOX="$(sandbox_name_for_file_op "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"

    if [[ "$SANDBOX_NEEDS_SYNC" == "yes" ]]; then
      CREATE_PAYLOAD="$(printf '%s' "$CFG_BASE" | jq -c --arg n "$SANDBOX" '.sandboxName = $n')"
      sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" "$CREATE_PAYLOAD" || {
        emit_deny "cc-msb: failed to start sandbox for read of $FILE_PATH"
        exit 0
      }
      handle_drift_if_any
      if [[ "$EFFECTIVE_SCOPE" != "directory" ]] && [[ "$EFFECTIVE_SCOPE" != "named" || -z "$EFFECTIVE_SANDBOX_NAME" ]]; then
        sandbox_track "$SESSION_ID" "$SANDBOX"
      fi
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
    [[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || exit 0

    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"

    if [[ "$SANDBOX_NEEDS_SYNC" == "yes" ]]; then
      # Ensure the sandbox exists so post-tool-use can sync the shadow file into it.
      SANDBOX="$(sandbox_name_for "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
      CREATE_PAYLOAD="$(printf '%s' "$CFG_BASE" | jq -c --arg n "$SANDBOX" '.sandboxName = $n')"
      sandbox_ensure_running "$SANDBOX" "$PROJECT_DIR" "$STATE_DIR/sandbox.log" "$CREATE_PAYLOAD" || true
      handle_drift_if_any
      if [[ "$EFFECTIVE_SCOPE" != "directory" ]] && [[ "$EFFECTIVE_SCOPE" != "named" || -z "$EFFECTIVE_SANDBOX_NAME" ]]; then
        sandbox_track "$SESSION_ID" "$SANDBOX"
      fi
      mkdir -p "$(dirname "$SANDBOX_HOST_PATH")" 2>/dev/null || true
    fi

    emit_allow_file_path "$SANDBOX_HOST_PATH" "$EVENT"
    exit 0
    ;;

  Edit|MultiEdit)
    # CC checks file existence on the host BEFORE this hook fires, so Edit on
    # VM-only paths (/tmp/..., /etc/..., etc.) is blocked by CC with "File does
    # not exist" before we ever see the call — verified by hook tracing across
    # 5 sequential runs (trace log stayed empty for VM-only Edits).
    # For project-dir (bind-mounted) Edits, the file is already on host, so we
    # just pass through. Workaround for VM-only edits: use Bash + sed/echo.
    exit 0
    ;;

  WebFetch)
    # WebFetch uses CC's built-in HTTP client on the host, bypassing every
    # cc-msb config (network policy, pass_env, etc.). Deny it and nudge
    # Claude to use Bash + curl instead — the existing Bash hook routes
    # that through `msb exec` so the fetch actually happens in the sandbox.
    # PreToolUse hooks can't return synthetic tool results, so this two-turn
    # bounce (deny → next-turn Bash) is the cleanest path.
    URL="$(printf '%s' "$EVENT" | jq -r '.tool_input.url // empty')"
    PROMPT="$(printf '%s' "$EVENT" | jq -r '.tool_input.prompt // empty')"
    emit_deny "cc-msb: WebFetch is intercepted so network calls run inside the sandbox (where the configured \`network\` policy applies). Use Bash instead: run \`curl -sSL '$URL'\` and then answer this question about the response: $PROMPT"
    exit 0
    ;;
esac

HANDLER="$PLUGIN_ROOT/handlers/pre-tool-use.js"
[[ -f "$HANDLER" ]] || { echo '{"decision":"block","reason":"cc-msb handler not found"}'; exit 2; }
printf '%s' "$EVENT" | node "$HANDLER"
