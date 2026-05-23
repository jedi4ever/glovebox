# Config loading helpers. Sourced — not executed directly.
#
# Two config files are consulted, in priority order:
#   1. Local:  <project_dir>/.cc-msb.yml
#   2. Global: ${CC_MSB_CONFIG_DIR:-$HOME/.config/cc-msb}/config.yml
#
# Env vars beat both files. Within each file, lookups cascade from the
# most specific section to the most general:
#   - Main session:  main.X → defaults.main.X → defaults.agents.X
#   - Agent:         agents.<name>.X → defaults.agents.X
# The first non-empty value wins; the local file is fully consulted
# before the global file.
#
# Supported format (same for local + global):
#   defaults:
#     main:                    # main-only defaults (not inherited by agents)
#       sandbox_image: debian
#       network: enabled
#     agents:                  # baseline for agents AND fallback for main
#       sandbox_image: ubuntu
#       mount_workdir: true
#       scope: session         # session | per-agent | per-run | named | directory | host
#       pass_env: none         # none | all | "VAR1,VAR2"
#       network: enabled       # enabled | disabled | "domain1,domain2"
#       ports: ""              # "" | "HOST:GUEST[,HOST:GUEST/udp,...]"
#
#   main:                      # main session settings (per-project overrides)
#     scope: named
#     sandbox_name: foo
#     sandbox_image: debian
#     pass_env: "HOME,PATH"
#     network: "github.com,api.openai.com"
#     ports: "8080:80,5432:5432"
#
#   agents:                    # per-agent overrides (inherit from defaults.agents)
#     test-agent:
#       scope: per-run
#       sandbox_image: alpine
#       sandbox_name: bar
#       pass_env: all

# Returns the path to the global config file. Existence not guaranteed.
# Override directory with CC_MSB_CONFIG_DIR (handy for tests).
config_global_file() {
  echo "${CC_MSB_CONFIG_DIR:-$HOME/.config/cc-msb}/config.yml"
}

# Reads pre-isolated section content from stdin and emits the value of <key>.
# Supports two forms:
#   1. Inline:  "key: value"        → emits "value"
#   2. Block:   "key:\n  - a\n  - b" → emits "a,b" (joined with commas)
# Quotes around inline values and individual list items are stripped.
# Inline comments (# ...) are stripped. Emits nothing if the key is absent.
_config_extract_value() {
  local key="$1"
  awk -v k="$key" '
    BEGIN { state = 0; result = ""; keyindent = -1 }
    state == 0 {
      if ($0 ~ "^[[:space:]]*" k "[[:space:]]*:") {
        keyindent = match($0, /[^ ]/) - 1
        line = $0
        sub("^[[:space:]]*" k "[[:space:]]*:[[:space:]]*", "", line)
        sub("[[:space:]]*#.*$", "", line)
        sub("[[:space:]]*$", "", line)
        sub("^[\"\047]", "", line)
        sub("[\"\047]$", "", line)
        if (length(line) > 0) { print line; exit }
        state = 1
        next
      }
    }
    state == 1 {
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^[[:space:]]*#/) next
      ind = match($0, /[^ ]/) - 1
      if (ind <= keyindent) exit
      if ($0 !~ /^[[:space:]]*-[[:space:]]+/) exit
      item = $0
      sub("^[[:space:]]*-[[:space:]]+", "", item)
      sub("[[:space:]]*#.*$", "", item)
      sub("[[:space:]]*$", "", item)
      sub("^[\"\047]", "", item)
      sub("[\"\047]$", "", item)
      if (result == "") result = item
      else result = result "," item
    }
    END { if (state == 1 && result != "") print result }
  '
}

# Returns the value of a key that is a DIRECT child of <section> (not buried
# inside a nested sub-mapping like defaults.main: or defaults.agents:).
# Locks onto the indent of the section's first non-blank child line and
# only matches keys at that exact indent. Supports inline and block-list
# values, same rules as _config_extract_value.
# Usage: config_yaml_get_direct file section key
# Example: config_yaml_get_direct .cc-msb.yml defaults sandbox_image
config_yaml_get_direct() {
  local file="$1" section="$2" key="$3"
  local pattern="^${section}:[[:space:]]*$"
  # Friendly alias: accept `default:` as shorthand for `defaults:`.
  [[ "$section" == "defaults" ]] && pattern="^defaults?:[[:space:]]*$"
  awk -v s="$pattern" -v k="$key" '
    BEGIN { in_section = 0; first_indent = -1; mode = 0; result = "" }
    {
      if (in_section && /^[^[:space:]]/) in_section = 0
      if (!in_section) {
        if ($0 ~ s) { in_section = 1; first_indent = -1; mode = 0; result = "" }
        next
      }
      if ($0 ~ /^[[:space:]]*$/) next
      ind = match($0, /[^ ]/) - 1
      if (first_indent == -1) first_indent = ind
      if (mode == 0) {
        if (ind != first_indent) next
        if ($0 ~ "^[[:space:]]*" k "[[:space:]]*:") {
          line = $0
          sub("^[[:space:]]*" k "[[:space:]]*:[[:space:]]*", "", line)
          sub("[[:space:]]*#.*$", "", line)
          sub("[[:space:]]*$", "", line)
          sub("^[\"\047]", "", line)
          sub("[\"\047]$", "", line)
          if (length(line) > 0) { print line; exit }
          mode = 1
        }
        next
      }
      # mode == 1: collecting list items deeper than first_indent
      if (ind <= first_indent) {
        if (result != "") print result
        exit
      }
      if ($0 ~ /^[[:space:]]*#/) next
      if ($0 !~ /^[[:space:]]*-[[:space:]]+/) {
        if (result != "") print result
        exit
      }
      item = $0
      sub("^[[:space:]]*-[[:space:]]+", "", item)
      sub("[[:space:]]*#.*$", "", item)
      sub("[[:space:]]*$", "", item)
      sub("^[\"\047]", "", item)
      sub("[\"\047]$", "", item)
      if (result == "") result = item
      else result = result "," item
    }
    END { if (mode == 1 && result != "") print result }
  ' "$file"
}

# Returns a value from a named top-level section block.
# Usage: config_yaml_get_section file section key
# Example: config_yaml_get_section .cc-msb.yml main sandbox_name
config_yaml_get_section() {
  local file="$1" section="$2" key="$3"
  awk -v s="^${section}:[[:space:]]*$" \
    '$0~s{f=1;next} f&&/^[^[:space:]]/{f=0} f{print}' "$file" \
  | _config_extract_value "$key" \
  || true
}

# Returns a value from a 3-level nested path: section.subsection.key
# Works for defaults.agents.* and agents.<name>.*
# Usage: config_yaml_get_nested file section subsection key
# Example: config_yaml_get_nested .cc-msb.yml defaults agents sandbox_image
# Example: config_yaml_get_nested .cc-msb.yml agents test-agent scope
config_yaml_get_nested() {
  local file="$1" section="$2" subsection="$3" key="$4"
  local pattern="^${section}:[[:space:]]*$"
  # Friendly alias: accept `default:` as shorthand for `defaults:`.
  [[ "$section" == "defaults" ]] && pattern="^defaults?:[[:space:]]*$"
  awk -v s="$pattern" \
    '$0~s{f=1;next} f&&/^[^[:space:]]/{f=0} f{print}' "$file" \
  | awk -v ss="$subsection" \
    '$0~("^  "ss":[[:space:]]*$"){f=1;next} f&&/^  [^[:space:]]/{f=0} f{print}' \
  | _config_extract_value "$key" \
  || true
}

# Loads config from local + global files.
# Sets CC_MSB_SANDBOX_NAME (env var still wins).
# Scope and mount_workdir are resolved per-context by config_agent_scope / config_agent_mount_workdir.
config_load() {
  local project_dir="$1"
  local local_file="$project_dir/.cc-msb.yml"
  local global_file
  global_file="$(config_global_file)"

  local file_sandbox_name="" file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_section "$file" "main" "sandbox_name")"
    if [[ -n "$val" ]]; then
      file_sandbox_name="$val"
      break
    fi
    val="$(config_yaml_get_nested "$file" "defaults" "main" "sandbox_name")"
    if [[ -n "$val" ]]; then
      file_sandbox_name="$val"
      break
    fi
  done

  CC_MSB_SANDBOX_NAME="${CC_MSB_SANDBOX_NAME:-$file_sandbox_name}"
  export CC_MSB_SANDBOX_NAME
}

# Returns the effective scope for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_MAIN_SCOPE env var
#   2. main.scope → defaults.main.scope → defaults.agents.scope in local file
#   3. main.scope → defaults.main.scope → defaults.agents.scope in global file
#   4. session
#
# Agents:
#   1. CC_MSB_AGENT_SCOPE_<UPPER_SNAKE> env var
#   2. agents.<name>.scope → defaults.agents.scope in local file
#   3. agents.<name>.scope → defaults.agents.scope in global file
#   4. session
#
# Args: agent_type, local_config_file
config_agent_scope() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_SCOPE:-}" ]] && echo "$CC_MSB_MAIN_SCOPE" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "scope")"
      [[ -n "$val" ]] && echo "$val" && return
    done
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

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "session"
}

# Returns the effective mount_workdir setting for a given agent type.
# Resolution chain mirrors config_agent_scope (env → local → global → default=true).
# Args: agent_type, local_config_file
config_agent_mount_workdir() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_MOUNT_WORKDIR:-}" ]] && echo "$CC_MSB_MAIN_MOUNT_WORKDIR" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "mount_workdir")"
      [[ -n "$val" ]] && echo "$val" && return
    done
    echo "true"
    return
  fi

  [[ -n "${CC_MSB_AGENT_MOUNT_WORKDIR:-}" ]] && echo "$CC_MSB_AGENT_MOUNT_WORKDIR" && return

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "true"
}

# Returns the effective sandbox image for a given agent type.
#
# Main session (no agent_type):
#   1. CC_MSB_SANDBOX_IMAGE env var
#   2. main.sandbox_image → defaults.main.sandbox_image → defaults.agents.sandbox_image in local file
#   3. main.sandbox_image → defaults.main.sandbox_image → defaults.agents.sandbox_image in global file
#   4. ubuntu
#
# Agents:
#   1. CC_MSB_AGENT_IMAGE_<UPPER_SNAKE> env var
#   2. agents.<name>.sandbox_image in local then global file
#   3. CC_MSB_SANDBOX_IMAGE env var
#   4. defaults.agents.sandbox_image in local then global file
#   5. ubuntu
#
# Args: agent_type, local_config_file
config_agent_image() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_SANDBOX_IMAGE:-}" ]] && echo "$CC_MSB_SANDBOX_IMAGE" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "sandbox_image")"
      [[ -n "$val" ]] && echo "$val" && return
    done
    echo "ubuntu"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_IMAGE_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "sandbox_image")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  done

  [[ -n "${CC_MSB_SANDBOX_IMAGE:-}" ]] && echo "$CC_MSB_SANDBOX_IMAGE" && return

  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "sandbox_image")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "sandbox_image")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "ubuntu"
}

# Returns the effective named sandbox for a given agent type (scope: named only).
#
# Main session (no agent_type):
#   1. CC_MSB_SANDBOX_NAME env var (set from main.sandbox_name by config_load,
#      which already considers local + global files)
#
# Agents:
#   1. CC_MSB_AGENT_SANDBOX_NAME_<UPPER_SNAKE> env var
#   2. agents.<name>.sandbox_name in local then global file
#   3. CC_MSB_SANDBOX_NAME (from main.sandbox_name or env var)
#
# Returns empty string when no name is configured (caller falls back to session scope).
# Args: agent_type, local_config_file
config_agent_sandbox_name() {
  local agent_type="$1" local_file="$2"

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

  local global_file
  global_file="$(config_global_file)"
  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "sandbox_name")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  done

  echo "${CC_MSB_SANDBOX_NAME:-}"
}

# Returns the effective pass_env spec for a given agent type.
#
# Values:
#   "none" — pass no host env vars (default)
#   "all"  — pass every host env var
#   "VAR1,VAR2,..." — pass only the listed vars (if defined on the host)
#
# Resolution chain mirrors config_agent_scope (env → local → global → default=none).
# Args: agent_type, local_config_file
config_agent_pass_env() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_PASS_ENV:-}" ]] && echo "$CC_MSB_MAIN_PASS_ENV" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "pass_env")"
      [[ -n "$val" ]] && echo "$val" && return
    done
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

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "pass_env")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "pass_env")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "pass_env")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "none"
}

# Returns the effective network spec for a given agent type.
#
# Values:
#   "enabled"  — full network access (msb default)
#   "disabled" — no network at all (`--no-net`)
#   "domain1,domain2,..." — allow only these domains, deny everything else
#
# Resolution chain mirrors config_agent_pass_env.
# Args: agent_type, local_config_file
config_agent_network() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_NETWORK:-}" ]] && echo "$CC_MSB_MAIN_NETWORK" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "network")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "network")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "network")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "network")"
      [[ -n "$val" ]] && echo "$val" && return
    done
    echo "enabled"
    return
  fi

  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_NETWORK_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "network")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "network")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "network")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "enabled"
}

# Returns the effective port-mapping spec for a given agent type.
#
# Values:
#   ""       — no port mappings (default)
#   "HOST:GUEST[,HOST:GUEST/proto,...]" — comma-separated msb --port mappings
#
# Resolution chain mirrors config_agent_pass_env / config_agent_network.
# Args: agent_type, local_config_file
config_agent_ports() {
  local agent_type="$1" local_file="$2"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${CC_MSB_MAIN_PORTS:-}" ]] && echo "$CC_MSB_MAIN_PORTS" && return
    local file val
    for file in "$local_file" "$global_file"; do
      [[ -f "$file" ]] || continue
      val="$(config_yaml_get_section "$file" "main" "ports")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "main" "ports")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_nested "$file" "defaults" "agents" "ports")"
      [[ -n "$val" ]] && echo "$val" && return
      val="$(config_yaml_get_direct "$file" "defaults" "ports")"
      [[ -n "$val" ]] && echo "$val" && return
    done
    echo ""
    return
  fi

  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"

  local env_var="CC_MSB_AGENT_PORTS_${upper}"
  local env_val="${!env_var:-}"
  if [[ -n "$env_val" ]]; then
    echo "$env_val"
    return
  fi

  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "ports")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "ports")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "ports")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo ""
}

# Generic per-key resolvers used by the security settings below.
# Main-session chain: main.X → defaults.main.X → defaults.agents.X → defaults.X
# Agent chain:        agents.<name>.X → defaults.agents.X → defaults.X
# Args (main):  key default_val local_file global_file
# Args (agent): agent_type key default_val local_file global_file
_config_resolve_main_chain() {
  local key="$1" default_val="$2" local_file="$3" global_file="$4"
  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_section "$file" "main" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "main" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "$default_val"
}

_config_resolve_agent_chain() {
  local agent_type="$1" key="$2" default_val="$3" local_file="$4" global_file="$5"
  local file val
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
    val="$(config_yaml_get_direct "$file" "defaults" "$key")"
    [[ -n "$val" ]] && echo "$val" && return
  done
  echo "$default_val"
}

# Helper: build the agent-snake-uppercased env-var name.
_config_agent_env_name() {
  local agent_type="$1" prefix="$2"
  local snake="${agent_type//-/_}"
  local upper
  upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"
  echo "${prefix}_${upper}"
}

# Resolves a setting using the standard chain, including env-var override.
# Args: agent_type setting_key built_in_default env_prefix_main env_prefix_agent local_file
# Example: _config_setting "" secrets "" CC_MSB_MAIN_SECRETS CC_MSB_AGENT_SECRETS /path/.cc-msb.yml
_config_setting() {
  local agent_type="$1" key="$2" default_val="$3"
  local env_main="$4" env_agent_prefix="$5" local_file="$6"
  local global_file
  global_file="$(config_global_file)"

  if [[ -z "$agent_type" ]]; then
    local env_val="${!env_main:-}"
    [[ -n "$env_val" ]] && echo "$env_val" && return
    _config_resolve_main_chain "$key" "$default_val" "$local_file" "$global_file"
    return
  fi

  local env_var
  env_var="$(_config_agent_env_name "$agent_type" "$env_agent_prefix")"
  local env_val="${!env_var:-}"
  [[ -n "$env_val" ]] && echo "$env_val" && return
  _config_resolve_agent_chain "$agent_type" "$key" "$default_val" "$local_file" "$global_file"
}

# ============================================================================
# Security: secrets + TLS interception
# ============================================================================
# All six settings follow the standard main/agent resolution chain.
# Env-var overrides: CC_MSB_MAIN_<KEY> and CC_MSB_AGENT_<KEY>_<AGENT>.

# Comma-separated list of secret specs: "ENV=VALUE@HOST".
# VALUE may start with $ to interpolate from the host env (see sandbox_secret_args).
config_agent_secrets() {
  _config_setting "$1" "secrets" "" \
    "CC_MSB_MAIN_SECRETS" "CC_MSB_AGENT_SECRETS" "$2"
}

# Action when a secret tries to leak: block | block-and-log | block-and-terminate.
# Empty default → no flag emitted → msb's own default applies.
config_agent_on_secret_violation() {
  _config_setting "$1" "on_secret_violation" "" \
    "CC_MSB_MAIN_ON_SECRET_VIOLATION" "CC_MSB_AGENT_ON_SECRET_VIOLATION" "$2"
}

# Boolean "true" / "false": enable msb's built-in TLS interception proxy.
config_agent_tls_intercept() {
  _config_setting "$1" "tls_intercept" "false" \
    "CC_MSB_MAIN_TLS_INTERCEPT" "CC_MSB_AGENT_TLS_INTERCEPT" "$2"
}

# Port to intercept TLS on (default in msb = 443). Empty → no flag emitted.
config_agent_tls_intercept_port() {
  _config_setting "$1" "tls_intercept_port" "" \
    "CC_MSB_MAIN_TLS_INTERCEPT_PORT" "CC_MSB_AGENT_TLS_INTERCEPT_PORT" "$2"
}

# Comma-separated list of domains to skip interception for.
config_agent_tls_bypass() {
  _config_setting "$1" "tls_bypass" "" \
    "CC_MSB_MAIN_TLS_BYPASS" "CC_MSB_AGENT_TLS_BYPASS" "$2"
}

# Boolean "true" / "false": ship the host's CA bundle into the guest.
config_agent_trust_host_cas() {
  _config_setting "$1" "trust_host_cas" "false" \
    "CC_MSB_MAIN_TRUST_HOST_CAS" "CC_MSB_AGENT_TRUST_HOST_CAS" "$2"
}
