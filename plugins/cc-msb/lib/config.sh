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
