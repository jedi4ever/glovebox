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
EFFECTIVE_SANDBOX_NAME="$(config_agent_sandbox_name "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SCOPE="$(config_agent_scope "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_MOUNT_WORKDIR="$(config_agent_mount_workdir "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_PASS_ENV="$(config_agent_pass_env "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_NETWORK="$(config_agent_network "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_PORTS="$(config_agent_ports "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SECRETS_RAW="$(config_agent_secrets "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_SECRETS="$(sandbox_resolve_secrets "$EFFECTIVE_SECRETS_RAW")"
EFFECTIVE_ON_SECRET_VIOLATION="$(config_agent_on_secret_violation "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_TLS_INTERCEPT="$(config_agent_tls_intercept "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_TLS_INTERCEPT_PORT="$(config_agent_tls_intercept_port "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_TLS_BYPASS="$(config_agent_tls_bypass "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_TRUST_HOST_CAS="$(config_agent_trust_host_cas "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_AUTO_RECREATE="$(config_agent_auto_recreate "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GIT_USER_NAME="$(config_agent_git_user_name "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GIT_USER_EMAIL="$(config_agent_git_user_email "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GITHUB_TOKEN="$(config_agent_github_token "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GITHUB_HOSTS="$(config_agent_github_hosts "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GIT_USER_AUTODETECT="$(config_agent_git_user_autodetect "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
EFFECTIVE_GIT_TOKEN_AUTODETECT="$(config_agent_git_token_autodetect "$AGENT_TYPE" "$PROJECT_DIR/.cc-msb.yml")"
# Fill in any unset git/github fields from the host (git config + gh auth token).
sandbox_autodetect_git_identity \
  "$EFFECTIVE_GIT_USER_NAME" "$EFFECTIVE_GIT_USER_EMAIL" "$EFFECTIVE_GITHUB_TOKEN" \
  "$EFFECTIVE_GIT_USER_AUTODETECT" "$EFFECTIVE_GIT_TOKEN_AUTODETECT"
EFFECTIVE_GIT_USER_NAME="$AUTODETECTED_GIT_USER_NAME"
EFFECTIVE_GIT_USER_EMAIL="$AUTODETECTED_GIT_USER_EMAIL"
EFFECTIVE_GITHUB_TOKEN="$AUTODETECTED_GITHUB_TOKEN"

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
    local recreate_payload recreate_out
    recreate_payload="$(sandbox_build_create_payload \
      "$name" "$EFFECTIVE_IMAGE" "$PROJECT_DIR" \
      "$EFFECTIVE_MOUNT_WORKDIR" "$EFFECTIVE_NETWORK" "$EFFECTIVE_PORTS" \
      "$EFFECTIVE_SECRETS" "$EFFECTIVE_ON_SECRET_VIOLATION" \
      "$EFFECTIVE_TLS_INTERCEPT" "$EFFECTIVE_TLS_INTERCEPT_PORT" \
      "$EFFECTIVE_TLS_BYPASS" "$EFFECTIVE_TRUST_HOST_CAS" \
      "$EFFECTIVE_GIT_USER_NAME" "$EFFECTIVE_GIT_USER_EMAIL" \
      "$EFFECTIVE_GITHUB_TOKEN" "$EFFECTIVE_GITHUB_HOSTS")"
    recreate_out="$(printf '%s' "$recreate_payload" \
      | node "$PLUGIN_ROOT/scripts/recreate-sandbox.mjs" 2>>"$STATE_DIR/recreate.log")" || true
    local ok image_changed recreate_err
    ok="$(printf '%s' "$recreate_out" | jq -r '.ok // false' 2>/dev/null || echo "false")"
    image_changed="$(printf '%s' "$recreate_out" | jq -r '.imageChanged // false' 2>/dev/null || echo "false")"
    recreate_err="$(printf '%s' "$recreate_out" | jq -r '.error // ""' 2>/dev/null || echo "")"
    if [[ "$ok" == "true" ]]; then
      # Recreate succeeded — rewrite the fingerprint to silence drift.
      # Apply the same github expansion the payload builder did, so the
      # fingerprint matches what sandbox_ensure_running computes on the
      # next call (which reads post-expansion network/secrets out of the
      # payload).
      sandbox_apply_github_expansion \
        "$EFFECTIVE_NETWORK" "$EFFECTIVE_SECRETS" \
        "$EFFECTIVE_GITHUB_TOKEN" "$EFFECTIVE_GITHUB_HOSTS"
      local new_fp fp_path
      new_fp="$(sandbox_config_fingerprint \
        "$EFFECTIVE_IMAGE" "$EFFECTIVE_MOUNT_WORKDIR" "$GH_EXPANDED_NETWORK" "$EFFECTIVE_PORTS" \
        "$GH_EXPANDED_SECRETS" "$EFFECTIVE_ON_SECRET_VIOLATION" \
        "$EFFECTIVE_TLS_INTERCEPT" "$EFFECTIVE_TLS_INTERCEPT_PORT" \
        "$EFFECTIVE_TLS_BYPASS" "$EFFECTIVE_TRUST_HOST_CAS" \
        "$EFFECTIVE_GIT_USER_NAME" "$EFFECTIVE_GIT_USER_EMAIL")"
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

    SANDBOX="$(sandbox_name_for "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    CREATE_PAYLOAD="$(sandbox_build_create_payload \
      "$SANDBOX" "$EFFECTIVE_IMAGE" "$PROJECT_DIR" \
      "$EFFECTIVE_MOUNT_WORKDIR" "$EFFECTIVE_NETWORK" "$EFFECTIVE_PORTS" \
      "$EFFECTIVE_SECRETS" "$EFFECTIVE_ON_SECRET_VIOLATION" \
      "$EFFECTIVE_TLS_INTERCEPT" "$EFFECTIVE_TLS_INTERCEPT_PORT" \
      "$EFFECTIVE_TLS_BYPASS" "$EFFECTIVE_TRUST_HOST_CAS" \
      "$EFFECTIVE_GIT_USER_NAME" "$EFFECTIVE_GIT_USER_EMAIL" \
      "$EFFECTIVE_GITHUB_TOKEN" "$EFFECTIVE_GITHUB_HOSTS")"
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

    SANDBOX="$(sandbox_name_for_file_op "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"

    if [[ "$SANDBOX_NEEDS_SYNC" == "yes" ]]; then
      CREATE_PAYLOAD="$(sandbox_build_create_payload \
        "$SANDBOX" "$EFFECTIVE_IMAGE" "$PROJECT_DIR" \
        "$EFFECTIVE_MOUNT_WORKDIR" "$EFFECTIVE_NETWORK" "$EFFECTIVE_PORTS" \
        "$EFFECTIVE_SECRETS" "$EFFECTIVE_ON_SECRET_VIOLATION" \
        "$EFFECTIVE_TLS_INTERCEPT" "$EFFECTIVE_TLS_INTERCEPT_PORT" \
        "$EFFECTIVE_TLS_BYPASS" "$EFFECTIVE_TRUST_HOST_CAS")"
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

    STATE_DIR="$(sandbox_state_dir "$SESSION_ID")"
    mkdir -p "$STATE_DIR"

    sandbox_resolve_path "$FILE_PATH" "$PROJECT_DIR" "$STATE_DIR"

    if [[ "$SANDBOX_NEEDS_SYNC" == "yes" ]]; then
      # Ensure the sandbox exists so post-tool-use can sync the shadow file into it.
      SANDBOX="$(sandbox_name_for "$SESSION_ID" "$AGENT_TYPE" "$EFFECTIVE_SANDBOX_NAME" "$EFFECTIVE_SCOPE" "$PROJECT_DIR")"
      CREATE_PAYLOAD="$(sandbox_build_create_payload \
        "$SANDBOX" "$EFFECTIVE_IMAGE" "$PROJECT_DIR" \
        "$EFFECTIVE_MOUNT_WORKDIR" "$EFFECTIVE_NETWORK" "$EFFECTIVE_PORTS" \
        "$EFFECTIVE_SECRETS" "$EFFECTIVE_ON_SECRET_VIOLATION" \
        "$EFFECTIVE_TLS_INTERCEPT" "$EFFECTIVE_TLS_INTERCEPT_PORT" \
        "$EFFECTIVE_TLS_BYPASS" "$EFFECTIVE_TRUST_HOST_CAS")"
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
