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

# Emits one shell-quoted token per line per `msb create` network flag derived
# from a network spec. Output is suitable for: `mapfile -t arr < <(sandbox_network_args "$spec")`.
# Spec values:
#   "enabled" (or empty) — no flags (msb default = full access)
#   "disabled"           — emits `--no-net`
#   "d1,d2,..."          — emits `--net-rule allow@<domain>` per entry
# Args: spec
sandbox_network_args() {
  local spec="$1"
  case "$spec" in
    ""|enabled|Enabled|ENABLED)
      return 0
      ;;
    disabled|Disabled|DISABLED)
      printf '%s\n' "--no-net"
      ;;
    *)
      local domain
      while IFS= read -r domain || [[ -n "$domain" ]]; do
        domain="${domain#"${domain%%[![:space:]]*}"}"
        domain="${domain%"${domain##*[![:space:]]}"}"
        [[ -z "$domain" ]] && continue
        printf '%s\n' "--net-rule"
        printf '%s\n' "allow@${domain}"
      done < <(printf '%s' "$spec" | tr ',' '\n')
      ;;
  esac
}

# Emits one shell-token-per-line per `msb create --port HOST:GUEST` mapping
# derived from a comma-separated `ports` spec. Empty/unset spec emits nothing.
# Args: spec
sandbox_port_args() {
  local spec="$1"
  [[ -z "$spec" ]] && return 0
  local mapping
  while IFS= read -r mapping || [[ -n "$mapping" ]]; do
    mapping="${mapping#"${mapping%%[![:space:]]*}"}"
    mapping="${mapping%"${mapping##*[![:space:]]}"}"
    [[ -z "$mapping" ]] && continue
    printf '%s\n' "--port"
    printf '%s\n' "$mapping"
  done < <(printf '%s' "$spec" | tr ',' '\n')
}

# Emits newline-separated `msb create` tokens for the security settings
# (--secret, --on-secret-violation, --tls-intercept, --tls-intercept-port,
# --tls-bypass, --trust-host-cas). Args use the same comma-separated string
# format as `network` / `ports` for list values. Secret VALUE that starts
# with `$` is interpolated from the host env; if that env var is unset, the
# secret is silently skipped (matching `pass_env`'s list-skip semantics).
# Args: secrets on_violation tls_intercept tls_port tls_bypass trust_cas
sandbox_security_args() {
  local secrets="$1" on_violation="$2"
  local tls_intercept="$3" tls_port="$4" tls_bypass="$5" trust_cas="$6"

  if [[ -n "$secrets" ]]; then
    local entry env_name rest value host var_name resolved
    while IFS= read -r entry || [[ -n "$entry" ]]; do
      entry="${entry#"${entry%%[![:space:]]*}"}"
      entry="${entry%"${entry##*[![:space:]]}"}"
      [[ -z "$entry" ]] && continue
      # Expected format: ENV=VALUE@HOST
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
      printf '%s\n' "--secret"
      printf '%s\n' "${env_name}=${value}@${host}"
    done < <(printf '%s' "$secrets" | tr ',' '\n')
  fi

  if [[ -n "$on_violation" ]]; then
    printf '%s\n' "--on-secret-violation"
    printf '%s\n' "$on_violation"
  fi

  if [[ "$tls_intercept" == "true" ]]; then
    printf '%s\n' "--tls-intercept"
  fi

  if [[ -n "$tls_port" ]]; then
    printf '%s\n' "--tls-intercept-port"
    printf '%s\n' "$tls_port"
  fi

  if [[ -n "$tls_bypass" ]]; then
    local domain
    while IFS= read -r domain || [[ -n "$domain" ]]; do
      domain="${domain#"${domain%%[![:space:]]*}"}"
      domain="${domain%"${domain##*[![:space:]]}"}"
      [[ -z "$domain" ]] && continue
      printf '%s\n' "--tls-bypass"
      printf '%s\n' "$domain"
    done < <(printf '%s' "$tls_bypass" | tr ',' '\n')
  fi

  if [[ "$trust_cas" == "true" ]]; then
    printf '%s\n' "--trust-host-cas"
  fi
}

# Ensures the named sandbox is running. Creates it if it doesn't exist.
# Args: name, project_dir, log_file [image [mount_workdir [network_spec
#       [ports_spec [security_args_str]]]]]
# security_args_str: newline-separated msb create tokens, typically built by
#   sandbox_security_args.
sandbox_ensure_running() {
  local name="$1" project_dir="$2" log_file="$3"
  local image="${4:-${CC_MSB_SANDBOX_IMAGE:-ubuntu}}"
  local mount_workdir="${5:-true}"
  local network_spec="${6:-enabled}"
  local ports_spec="${7:-}"
  local security_args_str="${8:-}"
  local status
  status=$(sandbox_status "$name")

  case "$status" in
    Running)
      return 0
      ;;
    Stopped)
      msb start "$name" --quiet 2>>"$log_file"
      ;;
    *)
      local create_args=("$image" --name "$name" --workdir /workspace --quiet)
      if [[ "$mount_workdir" == "true" ]]; then
        create_args+=(--volume "$project_dir:/workspace")
      fi
      local net_args=()
      while IFS= read -r line; do
        [[ -n "$line" ]] && net_args+=("$line")
      done < <(sandbox_network_args "$network_spec")
      if (( ${#net_args[@]} > 0 )); then
        create_args+=("${net_args[@]}")
      fi
      local port_args=()
      while IFS= read -r line; do
        [[ -n "$line" ]] && port_args+=("$line")
      done < <(sandbox_port_args "$ports_spec")
      if (( ${#port_args[@]} > 0 )); then
        create_args+=("${port_args[@]}")
      fi
      if [[ -n "$security_args_str" ]]; then
        local sec_args=()
        while IFS= read -r line; do
          [[ -n "$line" ]] && sec_args+=("$line")
        done <<< "$security_args_str"
        if (( ${#sec_args[@]} > 0 )); then
          create_args+=("${sec_args[@]}")
        fi
      fi
      msb create "${create_args[@]}" 2>>"$log_file"
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
