# Config loading helpers. Sourced — not executed directly.
# Reads .cc-msb.yml from the project dir; env vars take precedence.
#
# Supported format:
#   sandbox_image: ubuntu   # defaults (top-level)
#   mount_workdir: true
#   scope: session
#
#   main:                   # main session overrides
#     sandbox_name: foo
#     sandbox_image: debian
#
#   agents:                 # per-agent overrides
#     test-agent:
#       sandbox_image: alpine
#       sandbox_name: bar

# Returns the trimmed, unquoted value for a top-level key.
config_yaml_get() {
  local file="$1" key="$2"
  grep -E "^[[:space:]]*${key}[[:space:]]*:" "$file" 2>/dev/null \
    | head -1 \
    | sed -E "s/^[^:]+:[[:space:]]*//" \
    | sed -E "s/[[:space:]]*#.*//" \
    | sed -E "s/^[[:space:]]+|[[:space:]]+\$//g" \
    | sed -E "s/^['\"]|['\"]$//g" \
    || true
}

# Returns a value from a named top-level section block.
# Usage: config_yaml_get_section file section key
# Example: config_yaml_get_section .cc-msb.yml main sandbox_name
config_yaml_get_section() {
  local file="$1" section="$2" key="$3"
  awk -v s="^${section}:[[:space:]]*$" \
    '$0~s{f=1;next} f&&/^[^[:space:]]/{f=0} f{print}' "$file" \
  | grep -E "^[[:space:]]*${key}[[:space:]]*:" \
  | head -1 \
  | sed -E "s/^[^:]+:[[:space:]]*//" \
  | sed -E "s/[[:space:]]*#.*//" \
  | sed -E "s/^[[:space:]]+|[[:space:]]+\$//g" \
  | sed -E "s/^['\"]|['\"]$//g" \
  || true
}

# Returns a value from a named agent block under agents:.
# Usage: config_yaml_get_agent_key file agent-name key
# Example: config_yaml_get_agent_key .cc-msb.yml test-agent sandbox_image
config_yaml_get_agent_key() {
  local file="$1" agent="$2" key="$3"
  awk '/^agents:[[:space:]]*$/{f=1;next} f&&/^[^[:space:]]/{f=0} f{print}' "$file" \
  | awk -v agent="$agent" \
    '$0~("^  "agent":[[:space:]]*$"){f=1;next} f&&/^  [^[:space:]]/{f=0} f{print}' \
  | grep -E "^[[:space:]]*${key}[[:space:]]*:" \
  | head -1 \
  | sed -E "s/^[^:]+:[[:space:]]*//" \
  | sed -E "s/[[:space:]]*#.*//" \
  | sed -E "s/^[[:space:]]+|[[:space:]]+\$//g" \
  | sed -E "s/^['\"]|['\"]$//g" \
  || true
}

# Loads config from <project_dir>/.cc-msb.yml.
# Sets CC_MSB_MOUNT_WORKDIR, CC_MSB_SCOPE, CC_MSB_SANDBOX_NAME.
# CC_MSB_SANDBOX_IMAGE is NOT set here — resolved per-call by config_agent_image.
# Environment variables always take precedence over file values.
config_load() {
  local project_dir="$1"
  local config_file="$project_dir/.cc-msb.yml"

  local file_mount_workdir="true"
  local file_scope="session"
  local file_sandbox_name=""

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get "$config_file" "mount_workdir")"
    [[ -n "$val" ]] && file_mount_workdir="$val"
    val="$(config_yaml_get "$config_file" "scope")"
    [[ -n "$val" ]] && file_scope="$val"
    val="$(config_yaml_get_section "$config_file" "main" "sandbox_name")"
    [[ -n "$val" ]] && file_sandbox_name="$val"
  fi

  CC_MSB_MOUNT_WORKDIR="${CC_MSB_MOUNT_WORKDIR:-$file_mount_workdir}"
  export CC_MSB_MOUNT_WORKDIR

  CC_MSB_SCOPE="${CC_MSB_SCOPE:-$file_scope}"
  export CC_MSB_SCOPE

  CC_MSB_SANDBOX_NAME="${CC_MSB_SANDBOX_NAME:-$file_sandbox_name}"
  export CC_MSB_SANDBOX_NAME
}

# Returns the effective sandbox image for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_SANDBOX_IMAGE env var
#   2. main.sandbox_image in config file
#   3. sandbox_image in config file (global default)
#   4. ubuntu
#
# Agents:
#   1. CC_MSB_AGENT_IMAGE_<UPPER_SNAKE> env var
#   2. agents.<name>.sandbox_image in config file
#   3. CC_MSB_SANDBOX_IMAGE env var
#   4. sandbox_image in config file (global default)
#   5. ubuntu
#
# Args: agent_type, config_file
config_agent_image() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_SANDBOX_IMAGE:-}" ]] && echo "$CC_MSB_SANDBOX_IMAGE" && return
    if [[ -f "$config_file" ]]; then
      local val
      val="$(config_yaml_get_section "$config_file" "main" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get "$config_file" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
    fi
    echo "ubuntu"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper lower
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"
  lower="$(printf '%s' "$snake" | tr '[:upper:]' '[:lower:]')"

  local env_var="CC_MSB_AGENT_IMAGE_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_agent_key "$config_file" "$agent_type" "sandbox_image")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi

  [[ -n "${CC_MSB_SANDBOX_IMAGE:-}" ]] && echo "$CC_MSB_SANDBOX_IMAGE" && return
  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get "$config_file" "sandbox_image")"
    [[ -n "$val" ]] && echo "$val" && return
  fi
  echo "ubuntu"
}

# Returns the effective named sandbox for a given agent type (scope: named only).
#
# Main session (no agent_type):
#   1. CC_MSB_SANDBOX_NAME env var (set from main.sandbox_name by config_load)
#
# Agents:
#   1. CC_MSB_AGENT_SANDBOX_NAME_<UPPER_SNAKE> env var
#   2. agents.<name>.sandbox_name in config file
#   3. CC_MSB_SANDBOX_NAME (global, from main.sandbox_name or env var)
#
# Returns empty string when no name is configured (caller falls back to session scope).
# Args: agent_type, config_file
config_agent_sandbox_name() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    echo "${CC_MSB_SANDBOX_NAME:-}"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper lower
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"
  lower="$(printf '%s' "$snake" | tr '[:upper:]' '[:lower:]')"

  local env_var="CC_MSB_AGENT_SANDBOX_NAME_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_agent_key "$config_file" "$agent_type" "sandbox_name")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi

  echo "${CC_MSB_SANDBOX_NAME:-}"
}
