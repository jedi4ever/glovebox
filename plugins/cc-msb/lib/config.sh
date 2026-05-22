# Config loading helpers. Sourced — not executed directly.
# Reads .cc-msb.yml from the project dir; env vars take precedence.

# Returns the trimmed, unquoted value for a given key from a YAML file.
# Only supports flat "key: value" lines (no nesting, no lists).
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

# Loads config from <project_dir>/.cc-msb.yml.
# Sets CC_MSB_* variables; environment variables take precedence over file values.
config_load() {
  local project_dir="$1"
  local config_file="$project_dir/.cc-msb.yml"

  local file_mount_workdir="true"
  local file_sandbox_image="ubuntu"

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get "$config_file" "mount_workdir")"
    [[ -n "$val" ]] && file_mount_workdir="$val"
    val="$(config_yaml_get "$config_file" "sandbox_image")"
    [[ -n "$val" ]] && file_sandbox_image="$val"
  fi

  CC_MSB_MOUNT_WORKDIR="${CC_MSB_MOUNT_WORKDIR:-$file_mount_workdir}"
  export CC_MSB_MOUNT_WORKDIR

  CC_MSB_SANDBOX_IMAGE="${CC_MSB_SANDBOX_IMAGE:-$file_sandbox_image}"
  export CC_MSB_SANDBOX_IMAGE
}

# Returns the effective sandbox image for a given agent type.
# Resolution order:
#   1. CC_MSB_AGENT_IMAGE_<UPPER_SNAKE> env var  (e.g. CC_MSB_AGENT_IMAGE_TEST_AGENT)
#   2. agent_image_<lower_snake> in the config file  (e.g. agent_image_test_agent)
#   3. CC_MSB_SANDBOX_IMAGE (global default)
# Args: agent_type, config_file
config_agent_image() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    echo "${CC_MSB_SANDBOX_IMAGE:-ubuntu}"
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
    val="$(config_yaml_get "$config_file" "agent_image_${lower}")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi

  echo "${CC_MSB_SANDBOX_IMAGE:-ubuntu}"
}
