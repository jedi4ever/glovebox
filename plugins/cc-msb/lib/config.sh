# Config loading helpers. Sourced — not executed directly.
# Reads .cc-msb.yml from the project dir; env vars take precedence.
#
# Supported format:
#   defaults:
#     agents:                  # defaults for all agents
#       sandbox_image: ubuntu
#       mount_workdir: true
#       scope: session         # session | per-agent | per-run | named | directory
#       pass_env: none         # none | all | "VAR1,VAR2"
#
#   main:                      # main session settings (always explicit)
#     scope: named
#     sandbox_name: foo
#     sandbox_image: debian
#     pass_env: "HOME,PATH"
#
#   agents:                    # per-agent overrides (inherit from defaults.agents)
#     test-agent:
#       scope: per-run
#       sandbox_image: alpine
#       sandbox_name: bar
#       pass_env: all

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

# Returns a value from a 3-level nested path: section.subsection.key
# Works for defaults.agents.* and agents.<name>.*
# Usage: config_yaml_get_nested file section subsection key
# Example: config_yaml_get_nested .cc-msb.yml defaults agents sandbox_image
# Example: config_yaml_get_nested .cc-msb.yml agents test-agent scope
config_yaml_get_nested() {
  local file="$1" section="$2" subsection="$3" key="$4"
  awk -v s="^${section}:[[:space:]]*$" \
    '$0~s{f=1;next} f&&/^[^[:space:]]/{f=0} f{print}' "$file" \
  | awk -v ss="$subsection" \
    '$0~("^  "ss":[[:space:]]*$"){f=1;next} f&&/^  [^[:space:]]/{f=0} f{print}' \
  | grep -E "^[[:space:]]*${key}[[:space:]]*:" \
  | head -1 \
  | sed -E "s/^[^:]+:[[:space:]]*//" \
  | sed -E "s/[[:space:]]*#.*//" \
  | sed -E "s/^[[:space:]]+|[[:space:]]+\$//g" \
  | sed -E "s/^['\"]|['\"]$//g" \
  || true
}

# Loads config from <project_dir>/.cc-msb.yml.
# Sets CC_MSB_SANDBOX_NAME.
# Scope and mount_workdir are resolved per-context by config_agent_scope / config_agent_mount_workdir.
# Environment variables always take precedence over file values.
config_load() {
  local project_dir="$1"
  local config_file="$project_dir/.cc-msb.yml"

  local file_sandbox_name=""

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_section "$config_file" "main" "sandbox_name")"
    [[ -n "$val" ]] && file_sandbox_name="$val"
  fi

  CC_MSB_SANDBOX_NAME="${CC_MSB_SANDBOX_NAME:-$file_sandbox_name}"
  export CC_MSB_SANDBOX_NAME
}

# Returns the effective scope for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_MAIN_SCOPE env var
#   2. main.scope in config file
#   3. defaults.agents.scope in config file
#   4. session
#
# Agents:
#   1. CC_MSB_AGENT_SCOPE_<UPPER_SNAKE> env var
#   2. agents.<name>.scope in config file
#   3. defaults.agents.scope in config file
#   4. session
#
# Args: agent_type, config_file
config_agent_scope() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_SCOPE:-}" ]] && echo "$CC_MSB_MAIN_SCOPE" && return
    if [[ -f "$config_file" ]]; then
      local val
      val="$(config_yaml_get_section "$config_file" "main" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
    fi
    echo "session"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_SCOPE_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_nested "$config_file" "agents" "$agent_type" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
  fi
  echo "session"
}

# Returns the effective mount_workdir setting for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_MAIN_MOUNT_WORKDIR env var
#   2. main.mount_workdir in config file
#   3. defaults.agents.mount_workdir in config file
#   4. true
#
# Agents:
#   1. CC_MSB_AGENT_MOUNT_WORKDIR env var
#   2. agents.<name>.mount_workdir in config file
#   3. defaults.agents.mount_workdir in config file
#   4. true
#
# Args: agent_type, config_file
config_agent_mount_workdir() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_MOUNT_WORKDIR:-}" ]] && echo "$CC_MSB_MAIN_MOUNT_WORKDIR" && return
    if [[ -f "$config_file" ]]; then
      local val
      val="$(config_yaml_get_section "$config_file" "main" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
    fi
    echo "true"
    return
  fi

  [[ -n "${CC_MSB_AGENT_MOUNT_WORKDIR:-}" ]] && echo "$CC_MSB_AGENT_MOUNT_WORKDIR" && return

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_nested "$config_file" "agents" "$agent_type" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
  fi
  echo "true"
}

# Returns the effective sandbox image for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_SANDBOX_IMAGE env var
#   2. main.sandbox_image in config file
#   3. defaults.agents.sandbox_image in config file
#   4. ubuntu
#
# Agents:
#   1. CC_MSB_AGENT_IMAGE_<UPPER_SNAKE> env var
#   2. agents.<name>.sandbox_image in config file
#   3. CC_MSB_SANDBOX_IMAGE env var
#   4. defaults.agents.sandbox_image in config file
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
      val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "sandbox_image")"
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
    val="$(config_yaml_get_nested "$config_file" "agents" "$agent_type" "sandbox_image")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi

  [[ -n "${CC_MSB_SANDBOX_IMAGE:-}" ]] && echo "$CC_MSB_SANDBOX_IMAGE" && return
  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "sandbox_image")"
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
#   3. CC_MSB_SANDBOX_NAME (from main.sandbox_name or env var)
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
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_SANDBOX_NAME_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_nested "$config_file" "agents" "$agent_type" "sandbox_name")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  fi

  echo "${CC_MSB_SANDBOX_NAME:-}"
}

# Returns the effective pass_env spec for a given agent type.
#
# Values:
#   "none" — pass no host env vars (default)
#   "all"  — pass every host env var
#   "VAR1,VAR2,..." — pass only the listed vars (if defined on the host)
#
# Main session (no agent_type):
#   1. CC_MSB_MAIN_PASS_ENV env var
#   2. main.pass_env in config file
#   3. defaults.agents.pass_env in config file
#   4. none
#
# Agents:
#   1. CC_MSB_AGENT_PASS_ENV_<UPPER_SNAKE> env var
#   2. agents.<name>.pass_env in config file
#   3. defaults.agents.pass_env in config file
#   4. none
#
# Args: agent_type, config_file
config_agent_pass_env() {
  local agent_type="$1" config_file="$2"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_PASS_ENV:-}" ]] && echo "$CC_MSB_MAIN_PASS_ENV" && return
    if [[ -f "$config_file" ]]; then
      local val
      val="$(config_yaml_get_section "$config_file" "main" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
    fi
    echo "none"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_PASS_ENV_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  if [[ -f "$config_file" ]]; then
    local val
    val="$(config_yaml_get_nested "$config_file" "agents" "$agent_type" "pass_env")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$config_file" "defaults" "agents" "pass_env")"
    [[ -n "$val" ]] && echo "$val" && return
  fi
  echo "none"
}
