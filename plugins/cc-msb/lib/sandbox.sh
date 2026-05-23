# Sandbox lifecycle helpers. Sourced — not executed directly.

sandbox_name() {
  echo "cc-msb-${1:0:16}"
}

# Returns the sandbox name for a tool call.
#   session   — one shared sandbox per session (default)
#   per-agent — one sandbox per agent type; main session always uses the base name
#   per-run   — agents get a unique name each call (for Bash wrapping + self-cleanup)
#   named     — use explicit_name directly (persists across sessions)
#   directory — stable name derived from project_dir; persists across sessions
# Args: session_id [agent_type [explicit_name [scope [project_dir]]]]
sandbox_name_for() {
  local session_id="$1" agent_type="${2:-}" explicit_name="${3:-}" mode="${4:-session}" project_dir="${5:-}"

  # named scope with a configured name — use it directly (persists across sessions)
  if [[ "$mode" == "named" && -n "$explicit_name" ]]; then
    echo "$explicit_name"
    return
  fi

  # directory scope — stable name derived from the project directory path
  if [[ "$mode" == "directory" ]]; then
    local hash
    hash="$(printf '%s' "${project_dir:-$PWD}" | openssl dgst -sha256 2>/dev/null | sed -E 's/^.*= //' | cut -c1-12)"
    echo "cc-msb-dir-${hash}"
    return
  fi

  # no agent, session mode, or named with no name configured — use the main sandbox
  if [[ -z "$agent_type" ]] || [[ "$mode" == "session" ]] || [[ "$mode" == "named" ]]; then
    echo "cc-msb-${session_id:0:16}"
    return
  fi

  local lower
  lower="$(printf '%s' "${agent_type//-/_}" | tr '[:upper:]' '[:lower:]')"

  case "$mode" in
    per-agent)
      echo "cc-msb-${session_id:0:8}-${lower:0:8}"
      ;;
    per-run)
      local rand
      rand="$(openssl rand -hex 4 2>/dev/null || od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
      echo "cc-msb-${session_id:0:8}-${rand}"
      ;;
    *)
      echo "cc-msb-${session_id:0:16}"
      ;;
  esac
}

# Like sandbox_name_for but treats per-run as per-agent (file ops keep a stable sandbox).
# Args: session_id [agent_type [explicit_name [scope [project_dir]]]]
sandbox_name_for_file_op() {
  local session_id="$1" agent_type="${2:-}" explicit_name="${3:-}" mode="${4:-session}" project_dir="${5:-}"
  if [[ "$mode" == "per-run" ]]; then
    if [[ -z "$agent_type" ]]; then
      echo "cc-msb-${session_id:0:16}"
    else
      local lower
      lower="$(printf '%s' "${agent_type//-/_}" | tr '[:upper:]' '[:lower:]')"
      echo "cc-msb-${session_id:0:8}-${lower:0:8}"
    fi
  else
    sandbox_name_for "$session_id" "$agent_type" "$explicit_name" "$mode" "$project_dir"
  fi
}

# Appends a sandbox name to the session tracking list for cleanup.
# Args: session_id sandbox_name
sandbox_track() {
  local session_id="$1" name="$2"
  local state_dir
  state_dir="$(sandbox_state_dir "$session_id")"
  echo "$name" >> "$state_dir/sandboxes"
}

# Emits one shell-quoted token per line for each `--env KEY=VALUE` pair derived from
# a pass_env spec. The spec is "none" (or empty), "all", or a comma-separated list.
# Output is suitable for: `mapfile -t arr < <(sandbox_env_args "$spec")`.
# Args: spec
sandbox_env_args() {
  local spec="$1"
  case "$spec" in
    ""|none|None|NONE)
      return 0
      ;;
    all|All|ALL)
      while IFS= read -r -d '' kv; do
        # Skip lines without an '=' (shouldn't happen with `env -0`, but be safe)
        [[ "$kv" != *=* ]] && continue
        printf '%s\n' "--env"
        printf '%s\n' "$kv"
      done < <(env -0)
      ;;
    *)
      local var
      while IFS= read -r var || [[ -n "$var" ]]; do
        var="${var#"${var%%[![:space:]]*}"}"
        var="${var%"${var##*[![:space:]]}"}"
        [[ -z "$var" ]] && continue
        if [[ -n "${!var+set}" ]]; then
          printf '%s\n' "--env"
          printf '%s\n' "$var=${!var}"
        fi
      done < <(printf '%s' "$spec" | tr ',' '\n')
      ;;
  esac
}

# Wraps a command to run in the sandbox and auto-destroy it afterward (per-run scope).
# Args: name command [env_arg ...]
sandbox_wrap_command_ephemeral() {
  local name="$1" command="$2"
  shift 2
  local env_args=("$@")
  local encoded
  encoded=$(printf '%s' "$command" | base64 | tr -d '\n')
  local env_str=""
  if (( ${#env_args[@]} > 0 )); then
    env_str=$(printf ' %q' "${env_args[@]}")
  fi
  echo "printf '%s' '$encoded' | base64 -d | msb exec${env_str} '$name' -- bash; _ec=\$?; msb stop '$name' --quiet 2>/dev/null; msb remove '$name' --quiet 2>/dev/null; exit \$_ec"
}

sandbox_state_dir() {
  echo "$HOME/.cache/cc-msb/$1"
}

# Returns the sandbox status string ("Running", "Stopped", or "" if not found).
sandbox_status() {
  local json
  json=$(msb status "$1" --format json 2>/dev/null) || { echo ""; return 0; }
  printf '%s' "$json" | jq -r '.status // empty' 2>/dev/null || echo ""
}

# Computes a stable 16-char fingerprint of every sandbox-create-time setting
# so we can detect when the config drifted from what the sandbox was created
# with. Inputs match the JSON payload fields that the SDK consumer (the
# create-sandbox.mjs script) sees, so a fingerprint mismatch precisely
# means "the SDK would build a different sandbox now".
# Args: image mount network ports secrets on_violation tls_on tls_port
#       tls_bypass trust_cas git_user_name git_user_email
sandbox_config_fingerprint() {
  local payload
  payload="image=${1}|mount=${2}|net=${3}|ports=${4}|secrets=${5}|onv=${6}|tls=${7}|tlsp=${8}|tlsb=${9}|trust=${10}|gitn=${11}|gite=${12}"
  printf '%s' "$payload" | openssl dgst -sha256 2>/dev/null \
    | sed -E 's/^.*= //' | cut -c1-16
}

# Default GitHub host allowlist when `github_token` is set without an
# explicit `github_hosts` override. Matches the standard 5-host set used
# when working against `api.github.com` + the various raw/content CDNs.
sandbox_github_default_hosts() {
  printf '%s' "github.com,api.github.com,codeload.github.com,objects.githubusercontent.com,raw.githubusercontent.com"
}

# Given the user's existing `network` + `secrets` + the (optional) GitHub
# fields, expand the github auto-wiring into the primitive forms the rest
# of the pipeline already understands:
#   - Append `GH_TOKEN=<value>@<host>` to `secrets` for each host in the
#     allowlist (using the standard 5-host set unless the user overrode it).
#   - Union the github hosts into `network`. If `network` is `enabled` or
#     empty, replace it with the github allowlist. If `disabled`, leave
#     alone (user explicitly opted out of egress; document the gotcha).
#
# Sets three globals as output (no stdout — bash multi-return convention):
#   GH_EXPANDED_NETWORK, GH_EXPANDED_SECRETS, GH_EXPANDED_FORCE_TLS
#
# GH_EXPANDED_FORCE_TLS is "true" when expansion actually injected a token:
# secret substitution on HTTPS hosts (which github.com et al all are) only
# works when msb's TLS interceptor can MITM-decrypt outbound traffic.
# Without it, the placeholder `$MSB_GH_TOKEN` passes through to GitHub
# verbatim and the server returns "Bad credentials".
#
# Args: network secrets github_token github_hosts
sandbox_apply_github_expansion() {
  local network="$1" secrets="$2" github_token="$3" github_hosts="$4"
  GH_EXPANDED_NETWORK="$network"
  GH_EXPANDED_SECRETS="$secrets"
  GH_EXPANDED_FORCE_TLS="false"

  # No token configured → nothing to do.
  [[ -z "$github_token" ]] && return 0
  # Resolve $VAR substitution for the token value.
  local resolved="$github_token"
  if [[ "$resolved" == \$* ]]; then
    local var_name="${resolved:1}"
    resolved="${!var_name:-}"
    # Unset host var → skip the entire expansion (same semantics as
    # sandbox_resolve_secrets dropping unresolved entries).
    [[ -z "$resolved" ]] && return 0
  fi
  GH_EXPANDED_FORCE_TLS="true"

  local hosts="${github_hosts:-$(sandbox_github_default_hosts)}"

  # Append GH_TOKEN=<resolved>@<host> per host to secrets.
  local host new_secrets="$secrets"
  while IFS= read -r host || [[ -n "$host" ]]; do
    host="${host#"${host%%[![:space:]]*}"}"
    host="${host%"${host##*[![:space:]]}"}"
    [[ -z "$host" ]] && continue
    if [[ -n "$new_secrets" ]]; then
      new_secrets="${new_secrets},GH_TOKEN=${resolved}@${host}"
    else
      new_secrets="GH_TOKEN=${resolved}@${host}"
    fi
  done < <(printf '%s' "$hosts" | tr ',' '\n')
  GH_EXPANDED_SECRETS="$new_secrets"

  # Merge hosts into network. Respect explicit `disabled`.
  if [[ "$network" == "disabled" ]]; then
    GH_EXPANDED_NETWORK="disabled"
    return 0
  fi
  if [[ -z "$network" || "$network" == "enabled" ]]; then
    GH_EXPANDED_NETWORK="$hosts"
    return 0
  fi
  # Allowlist already present — union the new hosts in, de-duped.
  local existing="$network" merged="$network"
  while IFS= read -r host || [[ -n "$host" ]]; do
    host="${host#"${host%%[![:space:]]*}"}"
    host="${host%"${host##*[![:space:]]}"}"
    [[ -z "$host" ]] && continue
    # Skip if already present (anchored match against commas-or-edges).
    if [[ ",${existing}," == *",${host},"* ]]; then
      continue
    fi
    merged="${merged},${host}"
  done < <(printf '%s' "$hosts" | tr ',' '\n')
  GH_EXPANDED_NETWORK="$merged"
}

# Where the per-sandbox config fingerprint is persisted. Survives across CC
# sessions, alongside other long-lived state under ~/.cache/cc-msb/.
sandbox_fingerprint_path() {
  echo "$HOME/.cache/cc-msb/fingerprints/$1.fp"
}

# Builds the canonical JSON payload that the Node create/recreate scripts
# consume. Single source of truth for the wire format between bash and
# the SDK-backed creator — used by both sandbox_ensure_running and
# pre-tool-use.sh::handle_drift_if_any. The shape matches scripts/lib/
# sandbox-build.mjs::applyConfig.
#
# This is also where the `github_*` auto-wiring happens: github_token +
# github_hosts get expanded into the existing `network` allowlist and
# `secrets` list before the JSON is emitted. The rest of the pipeline
# (Node creator, fingerprint, drift) sees only the post-expansion values.
#
# Args: name image project_dir mount_workdir network ports
#       secrets on_violation tls_intercept tls_port tls_bypass trust_cas
#       git_user_name git_user_email github_token github_hosts
sandbox_build_create_payload() {
  local name="$1" image="$2" project_dir="$3"
  local mount_workdir="$4" network="$5" ports="$6"
  local secrets="$7" on_violation="$8"
  local tls_intercept="$9" tls_port="${10}" tls_bypass="${11}" trust_cas="${12}"
  local git_user_name="${13:-}" git_user_email="${14:-}"
  local github_token="${15:-}" github_hosts="${16:-}"

  # Expand `github_token` / `github_hosts` into the existing secrets +
  # network primitives. Sets GH_EXPANDED_NETWORK / GH_EXPANDED_SECRETS,
  # and GH_EXPANDED_FORCE_TLS=true when a token was actually injected
  # (HTTPS substitution requires TLS interception).
  sandbox_apply_github_expansion "$network" "$secrets" "$github_token" "$github_hosts"
  network="$GH_EXPANDED_NETWORK"
  secrets="$GH_EXPANDED_SECRETS"
  if [[ "$GH_EXPANDED_FORCE_TLS" == "true" ]]; then
    tls_intercept="true"
  fi

  local _b_mount _b_tls _b_trust
  [[ "$mount_workdir" == "true" ]] && _b_mount=true || _b_mount=false
  [[ "$tls_intercept" == "true" ]] && _b_tls=true   || _b_tls=false
  [[ "$trust_cas"     == "true" ]] && _b_trust=true || _b_trust=false
  jq -nc \
    --arg name "$name" --arg image "$image" --arg projectDir "$project_dir" \
    --argjson mount "$_b_mount" \
    --arg network "$network" --arg ports "$ports" \
    --arg secrets "$secrets" --arg onViol "$on_violation" \
    --argjson tlsOn "$_b_tls" --arg tlsPort "$tls_port" --arg tlsBypass "$tls_bypass" \
    --argjson trust "$_b_trust" \
    --arg gitUserName "$git_user_name" --arg gitUserEmail "$git_user_email" \
    '{sandboxName:$name, image:$image, projectDir:$projectDir, mountWorkdir:$mount,
      network:$network, ports:$ports, secrets:$secrets, onSecretViolation:$onViol,
      tlsIntercept:$tlsOn,
      tlsInterceptPort: (if ($tlsPort|length) > 0 then ($tlsPort|tonumber) else null end),
      tlsBypass:$tlsBypass, trustHostCas:$trust,
      gitUserName:$gitUserName, gitUserEmail:$gitUserEmail}'
}

# Expands `$VAR` references in a comma-separated `secrets` spec using the
# host env, so the resolved values can be embedded in the JSON payload.
# Entries whose `$VAR` is unset are silently skipped (same semantics as
# pass_env list items that reference missing host vars). Quoted-empty
# input passes through unchanged.
# Args: secrets_spec
sandbox_resolve_secrets() {
  local spec="$1"
  [[ -z "$spec" ]] && return 0
  local entry env_name rest value host var_name resolved out=""
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -z "$entry" ]] && continue
    [[ "$entry" != *=*@* ]] && continue
    env_name="${entry%%=*}"
    rest="${entry#*=}"
    value="${rest%@*}"
    host="${rest##*@}"
    if [[ "$value" == \$* ]]; then
      var_name="${value:1}"
      resolved="${!var_name:-}"
      [[ -z "$resolved" ]] && continue
      value="$resolved"
    fi
    if [[ -n "$out" ]]; then
      out="${out},${env_name}=${value}@${host}"
    else
      out="${env_name}=${value}@${host}"
    fi
  done < <(printf '%s' "$spec" | tr ',' '\n')
  printf '%s' "$out"
}

# Reads the host's git identity / GitHub token to fill in any unset config
# values. Driven by `git_user_autodetect` / `git_token_autodetect` (both
# default true). Explicit config values are NEVER overridden — autodetect
# only fills in fields that the user didn't set.
#
# Sets three globals as output:
#   AUTODETECTED_GIT_USER_NAME, AUTODETECTED_GIT_USER_EMAIL,
#   AUTODETECTED_GITHUB_TOKEN
#
# Args: cfg_user_name cfg_user_email cfg_github_token
#       user_autodetect token_autodetect
sandbox_autodetect_git_identity() {
  local cfg_name="$1" cfg_email="$2" cfg_token="$3"
  local user_auto="$4" token_auto="$5"

  if [[ -z "$cfg_name" && "$user_auto" == "true" ]]; then
    cfg_name="$(git config --global --get user.name 2>/dev/null || true)"
  fi
  if [[ -z "$cfg_email" && "$user_auto" == "true" ]]; then
    cfg_email="$(git config --global --get user.email 2>/dev/null || true)"
  fi
  if [[ -z "$cfg_token" && "$token_auto" == "true" ]]; then
    if command -v gh >/dev/null 2>&1; then
      cfg_token="$(gh auth token 2>/dev/null || true)"
    fi
  fi
  AUTODETECTED_GIT_USER_NAME="$cfg_name"
  AUTODETECTED_GIT_USER_EMAIL="$cfg_email"
  AUTODETECTED_GITHUB_TOKEN="$cfg_token"
}

# Ensures the named sandbox is running. Creates it if it doesn't exist by
# piping the canonical JSON payload into scripts/create-sandbox.mjs (which
# uses the microsandbox SDK). The CLI's `msb create` is no longer used.
#
# Args: name, project_dir, log_file, payload_json
sandbox_ensure_running() {
  local name="$1" project_dir="$2" log_file="$3"
  local payload="${4:-}"
  local status
  status=$(sandbox_status "$name")

  # Fingerprint of the *currently desired* settings. We re-check on every
  # call against what was stored when the sandbox was created — if they
  # differ, the sandbox is using stale flags (since most of these only
  # apply at create time, not at exec). The caller decides what to do via
  # the SANDBOX_CONFIG_DRIFT global.
  SANDBOX_CONFIG_DRIFT=""
  local image mount_workdir network_spec ports_spec
  local secrets on_violation tls_intercept tls_port tls_bypass trust_cas
  local git_user_name git_user_email
  image="$(printf '%s' "$payload" | jq -r '.image // "ubuntu"')"
  mount_workdir="$(printf '%s' "$payload" | jq -r 'if .mountWorkdir then "true" else "false" end')"
  network_spec="$(printf '%s' "$payload" | jq -r '.network // "enabled"')"
  ports_spec="$(printf '%s' "$payload" | jq -r '.ports // ""')"
  secrets="$(printf '%s' "$payload" | jq -r '.secrets // ""')"
  on_violation="$(printf '%s' "$payload" | jq -r '.onSecretViolation // ""')"
  tls_intercept="$(printf '%s' "$payload" | jq -r 'if .tlsIntercept then "true" else "false" end')"
  tls_port="$(printf '%s' "$payload" | jq -r '.tlsInterceptPort // "" | tostring | sub("^null$"; "")')"
  tls_bypass="$(printf '%s' "$payload" | jq -r '.tlsBypass // ""')"
  trust_cas="$(printf '%s' "$payload" | jq -r 'if .trustHostCas then "true" else "false" end')"
  git_user_name="$(printf '%s' "$payload" | jq -r '.gitUserName // ""')"
  git_user_email="$(printf '%s' "$payload" | jq -r '.gitUserEmail // ""')"

  local current_fp fp_path stored_fp=""
  current_fp="$(sandbox_config_fingerprint \
    "$image" "$mount_workdir" "$network_spec" "$ports_spec" \
    "$secrets" "$on_violation" "$tls_intercept" "$tls_port" "$tls_bypass" "$trust_cas" \
    "$git_user_name" "$git_user_email")"
  fp_path="$(sandbox_fingerprint_path "$name")"
  [[ -f "$fp_path" ]] && stored_fp="$(< "$fp_path")"

  case "$status" in
    Running)
      if [[ -n "$stored_fp" && "$stored_fp" != "$current_fp" ]]; then
        SANDBOX_CONFIG_DRIFT="$name"
      fi
      return 0
      ;;
    Stopped)
      if [[ -n "$stored_fp" && "$stored_fp" != "$current_fp" ]]; then
        SANDBOX_CONFIG_DRIFT="$name"
        return 0
      fi
      msb start "$name" --quiet 2>>"$log_file"
      ;;
    *)
      if printf '%s' "$payload" | node "$PLUGIN_ROOT/scripts/create-sandbox.mjs" >>"$log_file" 2>&1; then
        mkdir -p "$(dirname "$fp_path")"
        printf '%s\n' "$current_fp" > "$fp_path"
      else
        return 1
      fi
      ;;
  esac
}

# Resolves a file path to either the host path (for bind-mounted project files)
# or a shadow file path (for VM-only files). Sets:
#   SANDBOX_HOST_PATH  — path the host tool should read
#   SANDBOX_NEEDS_SYNC — "yes" if the file must be fetched from the sandbox first
# Args: file_path, project_dir, state_dir
sandbox_resolve_path() {
  local file_path="$1" project_dir="$2" state_dir="$3"
  local shadow_root="$state_dir/shadow"

  case "$file_path" in
    "$project_dir"|"$project_dir"/*)
      SANDBOX_HOST_PATH="$file_path"
      SANDBOX_NEEDS_SYNC="no"
      ;;
    /workspace|/workspace/*)
      SANDBOX_HOST_PATH="$project_dir/${file_path#/workspace/}"
      SANDBOX_NEEDS_SYNC="no"
      ;;
    /*)
      SANDBOX_HOST_PATH="$shadow_root$file_path"
      SANDBOX_NEEDS_SYNC="yes"
      ;;
    *)
      SANDBOX_HOST_PATH="$file_path"
      SANDBOX_NEEDS_SYNC="no"
      ;;
  esac
}

# Reads a file from inside the sandbox into a shadow file on the host.
# Args: name, vm_path, host_path
sandbox_read_into_shadow() {
  local name="$1" vm_path="$2" host_path="$3"
  mkdir -p "$(dirname -- "$host_path")"
  msb exec "$name" -- cat "$vm_path" > "$host_path"
}

# Syncs a shadow file back into the sandbox after a host Write/Edit.
# Args: name, shadow_path, vm_path
sandbox_write_from_shadow() {
  local name="$1" shadow_path="$2" vm_path="$3"
  local encoded_dir
  encoded_dir=$(printf '%s' "$(dirname "$vm_path")" | base64 | tr -d '\n')
  local encoded_path
  encoded_path=$(printf '%s' "$vm_path" | base64 | tr -d '\n')
  msb exec "$name" -- bash -c \
    "mkdir -p \"\$(printf '%s' '$encoded_dir' | base64 -d)\" && cat > \"\$(printf '%s' '$encoded_path' | base64 -d)\"" \
    < "$shadow_path"
}

# Wraps an arbitrary command to run inside the sandbox via base64 encoding,
# avoiding any shell-escaping issues with the original command content.
# Args: name command [env_arg ...]
sandbox_wrap_command() {
  local name="$1" command="$2"
  shift 2
  local env_args=("$@")
  local encoded
  encoded=$(printf '%s' "$command" | base64 | tr -d '\n')
  local env_str=""
  if (( ${#env_args[@]} > 0 )); then
    env_str=$(printf ' %q' "${env_args[@]}")
  fi
  echo "printf '%s' '$encoded' | base64 -d | msb exec${env_str} '$name' -- bash"
}
