# DEPRECATED: replaced by lib/config.mjs (node config.mjs <project_dir> [agent_type]).
# This file is no longer sourced by any hook or script. Kept for reference only;
# delete after confirming no external callers remain.
#
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

# Returns the directory user presets live in. Override with
# CC_MSB_PRESETS_DIR (handy for tests).
config_user_presets_dir() {
  echo "${CC_MSB_PRESETS_DIR:-$HOME/.cc-msb/presets}"
}

# Returns the directory built-in presets ship in (inside the plugin).
config_builtin_presets_dir() {
  echo "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}/presets"
}

# Resolves a preset name to a YAML file path. User dir wins over built-in.
# Emits the path on success, empty string if not found.
# Args: name
config_preset_path() {
  local name="$1"
  [[ -z "$name" ]] && return 0
  local user_dir builtin_dir candidate
  user_dir="$(config_user_presets_dir)"
  builtin_dir="$(config_builtin_presets_dir)"
  for candidate in "$user_dir/$name.yml" "$user_dir/$name.yaml" \
                   "$builtin_dir/$name.yml" "$builtin_dir/$name.yaml"; do
    [[ -f "$candidate" ]] && { echo "$candidate"; return 0; }
  done
}

# Reads a top-level YAML key as a list (inline `[a, b]` or block `- a\n- b`).
# Returns items joined with commas; empty if the key is missing.
# Args: file key
config_yaml_get_top_list() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v k="$key" '
    BEGIN { mode = 0; result = "" }
    mode == 0 {
      if ($0 ~ "^" k "[[:space:]]*:") {
        line = $0
        sub("^" k "[[:space:]]*:[[:space:]]*", "", line)
        sub("[[:space:]]*#.*$", "", line)
        sub("[[:space:]]*$", "", line)
        # inline list: [a, b, c]
        if (line ~ /^\[.*\]$/) {
          sub(/^\[/, "", line); sub(/\]$/, "", line)
          n = split(line, parts, ",")
          for (i = 1; i <= n; i++) {
            item = parts[i]
            sub(/^[[:space:]]+/, "", item); sub(/[[:space:]]+$/, "", item)
            sub(/^["\047]/, "", item); sub(/["\047]$/, "", item)
            if (item != "") { result = (result == "" ? item : result "," item) }
          }
          print result; exit
        }
        if (length(line) > 0) { print line; exit }
        mode = 1
        next
      }
    }
    mode == 1 {
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^[[:space:]]*#/) next
      if ($0 ~ /^[^[:space:]]/) { if (result != "") print result; exit }
      if ($0 !~ /^[[:space:]]*-[[:space:]]+/) { if (result != "") print result; exit }
      item = $0
      sub(/^[[:space:]]*-[[:space:]]+/, "", item)
      sub(/[[:space:]]*#.*$/, "", item)
      sub(/[[:space:]]*$/, "", item)
      sub(/^["\047]/, "", item); sub(/["\047]$/, "", item)
      result = (result == "" ? item : result "," item)
    }
    END { if (mode == 1 && result != "") print result }
  ' "$file"
}

# Returns the resolved preset name list (comma-separated, in declaration order).
# Chain: CC_MSB_PRESETS env → local file `presets:` → global file `presets:`.
# Args: local_file
config_presets_list() {
  local local_file="$1"
  if [[ -n "${CC_MSB_PRESETS:-}" ]]; then
    echo "$CC_MSB_PRESETS"
    return
  fi
  local global_file val
  global_file="$(config_global_file)"
  for f in "$local_file" "$global_file"; do
    val="$(config_yaml_get_top_list "$f" "presets")"
    if [[ -n "$val" ]]; then
      echo "$val"
      return
    fi
  done
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
    val="$(_config_preset_lookup "$local_file" "" "scope")"
    [[ -n "$val" ]] && echo "$val" && return
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
  val="$(_config_preset_lookup "$local_file" "$agent_type" "scope")"
  [[ -n "$val" ]] && echo "$val" && return
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
    val="$(_config_preset_lookup "$local_file" "" "mount_workdir")"
    [[ -n "$val" ]] && echo "$val" && return
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
  val="$(_config_preset_lookup "$local_file" "$agent_type" "mount_workdir")"
  [[ -n "$val" ]] && echo "$val" && return
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
    val="$(_config_preset_lookup "$local_file" "" "sandbox_image")"
    [[ -n "$val" ]] && echo "$val" && return
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
  val="$(_config_preset_lookup "$local_file" "$agent_type" "sandbox_image")"
  [[ -n "$val" ]] && echo "$val" && return
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
# Unions across layers with most-permissive-wins semantics: any layer
# saying "all" forces "all"; variable names get unioned across presets,
# defaults, etc.; "none" contributes nothing. Env var still
# short-circuits as an explicit override.
config_agent_pass_env() {
  _config_setting_list "$1" "pass_env" "none" \
    "CC_MSB_MAIN_PASS_ENV" "CC_MSB_AGENT_PASS_ENV" "$2" "pass_env"
}

# Returns the effective network spec for a given agent type.
#
# Values:
#   "enabled"  — full network access (msb default)
#   "disabled" — no network at all (`--no-net`)
#   "domain1,domain2,..." — allow only these domains, deny everything else
#
# Unions across all layers with most-restrictive-wins semantics:
# any layer saying "disabled" forces "disabled"; allowlist hosts get
# unioned across presets, defaults, etc.; "enabled" contributes nothing.
# Env var still short-circuits as an explicit override.
config_agent_network() {
  _config_setting_list "$1" "network" "enabled" \
    "CC_MSB_MAIN_NETWORK" "CC_MSB_AGENT_NETWORK" "$2" "network"
}

# Returns the effective port-mapping spec for a given agent type.
#
# Values:
#   ""       — no port mappings (default)
#   "HOST:GUEST[,HOST:GUEST/proto,...]" — comma-separated msb --port mappings
#
# Unions across layers (no mode strings). Env var still short-circuits.
config_agent_ports() {
  _config_setting_list "$1" "ports" "" \
    "CC_MSB_MAIN_PORTS" "CC_MSB_AGENT_PORTS" "$2" "csv"
}

# ============================================================================
# List-shaped settings: union semantics across all layers (iteration 2)
# ============================================================================
# For settings like `secrets`, `network`, `pass_env`, `ports`, `tls_bypass`,
# `github_hosts` we want every layer that contributes a value to count —
# not just the first-non-empty. So `presets: [npm, aws]` adds both
# registries to the allowlist instead of one masking the other.
#
# Env vars still SHORT-CIRCUIT (preserves existing override semantics);
# all other layers union.

# Dumps each preset's non-empty value for the given key, one per line.
# Used by `_config_setting_list` to union preset contributions with the
# user-file's resolved value. Order of emission doesn't matter — the
# downstream mergers are set-union.
# Args: agent_type key local_file
_config_collect_presets() {
  local agent_type="$1" key="$2" local_file="$3"
  local list name path val
  list="$(config_presets_list "$local_file")"
  [[ -z "$list" ]] && return 0
  while IFS= read -r name || [[ -n "$name" ]]; do
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [[ -z "$name" ]] && continue
    path="$(config_preset_path "$name")"
    [[ -z "$path" ]] && continue
    if [[ -z "$agent_type" ]]; then
      val="$(config_yaml_get_nested "$path" "defaults" "main" "$key")"
      [[ -n "$val" ]] && printf '%s\n' "$val"
    fi
    val="$(config_yaml_get_nested "$path" "defaults" "agents" "$key")"
    [[ -n "$val" ]] && printf '%s\n' "$val"
    val="$(config_yaml_get_direct "$path" "defaults" "$key")"
    [[ -n "$val" ]] && printf '%s\n' "$val"
  done < <(printf '%s' "$list" | tr ',' '\n')
}

# Pure CSV union: each input line is a comma-separated value list; output
# is a single comma-separated list with duplicates removed (first-seen
# order preserved).
_config_union_csv() {
  awk -F, '
    {
      for (i = 1; i <= NF; i++) {
        v = $i
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        if (v != "" && !(v in seen)) {
          seen[v] = 1
          out = (out == "" ? v : out "," v)
        }
      }
    }
    END { if (out != "") print out }
  '
}

# Network merger. Mode strings short-circuit:
#   any layer == "disabled" → "disabled" (most-restrictive wins)
#   else if all layers == "enabled" or empty → "enabled"
#   else union of allowlist hosts (treating "enabled"/blank as no contribution)
_config_union_network() {
  local all merged
  all="$(cat)"
  if printf '%s\n' "$all" | grep -qx "disabled"; then
    echo "disabled"; return
  fi
  # Drop "enabled" / blank lines, then union the rest.
  merged="$(printf '%s\n' "$all" | grep -vx "" | grep -vx "enabled" | _config_union_csv || true)"
  if [[ -n "$merged" ]]; then echo "$merged"; else echo "enabled"; fi
}

# pass_env merger. Mode strings short-circuit:
#   any layer == "all"  → "all" (most-permissive wins)
#   else if all layers == "none" or empty → "none"
#   else union of variable names (treating "none"/blank as no contribution)
_config_union_pass_env() {
  local all merged
  all="$(cat)"
  if printf '%s\n' "$all" | grep -qx "all"; then
    echo "all"; return
  fi
  merged="$(printf '%s\n' "$all" | grep -vx "" | grep -vx "none" | _config_union_csv || true)"
  if [[ -n "$merged" ]]; then echo "$merged"; else echo "none"; fi
}

# Resolves a list-shaped setting.
#
# Semantics:
#   - Env var still short-circuits (explicit override; backward compat).
#   - Within the user's own files, the standard first-non-empty-wins
#     chain applies (main beats defaults, agent override beats
#     defaults.agents, local beats global). One winning value emerges.
#   - That winning value is then UNIONED with every preset's value for
#     the same key. The merger handles mode strings (e.g. network's
#     "disabled" forces disabled; pass_env's "all" forces all).
#
# This means presets contribute additively without overriding the user's
# explicit choices within their own file.
# Args: agent_type key default_val env_main env_agent_prefix local_file mode
# mode = "csv" | "network" | "pass_env"
_config_setting_list() {
  local agent_type="$1" key="$2" default_val="$3"
  local env_main="$4" env_agent_prefix="$5" local_file="$6" mode="$7"

  if [[ -z "$agent_type" ]]; then
    [[ -n "${!env_main:-}" ]] && echo "${!env_main}" && return
  else
    local env_var
    env_var="$(_config_agent_env_name "$agent_type" "$env_agent_prefix")"
    [[ -n "${!env_var:-}" ]] && echo "${!env_var}" && return
  fi

  # First-non-empty across the user's local + global files.
  local user_val="" file val
  local global_file
  global_file="$(config_global_file)"
  for file in "$local_file" "$global_file"; do
    [[ -f "$file" ]] || continue
    if [[ -z "$agent_type" ]]; then
      val="$(config_yaml_get_section "$file" "main" "$key")"
      if [[ -n "$val" ]]; then user_val="$val"; break; fi
      val="$(config_yaml_get_nested "$file" "defaults" "main" "$key")"
      if [[ -n "$val" ]]; then user_val="$val"; break; fi
    else
      val="$(config_yaml_get_nested "$file" "agents" "$agent_type" "$key")"
      if [[ -n "$val" ]]; then user_val="$val"; break; fi
    fi
    val="$(config_yaml_get_nested "$file" "defaults" "agents" "$key")"
    if [[ -n "$val" ]]; then user_val="$val"; break; fi
    val="$(config_yaml_get_direct "$file" "defaults" "$key")"
    if [[ -n "$val" ]]; then user_val="$val"; break; fi
  done

  # Union user value with every preset value.
  local preset_lines
  preset_lines="$(_config_collect_presets "$agent_type" "$key" "$local_file")"
  local combined
  if [[ -n "$user_val" && -n "$preset_lines" ]]; then
    combined="$(printf '%s\n%s\n' "$user_val" "$preset_lines")"
  elif [[ -n "$user_val" ]]; then
    combined="$user_val"
  else
    combined="$preset_lines"
  fi

  local merged
  case "$mode" in
    network)  merged="$(printf '%s\n' "$combined" | _config_union_network)" ;;
    pass_env) merged="$(printf '%s\n' "$combined" | _config_union_pass_env)" ;;
    *)        merged="$(printf '%s\n' "$combined" | _config_union_csv)" ;;
  esac
  if [[ -z "$merged" ]]; then echo "$default_val"; else echo "$merged"; fi
}

# Walks resolved preset files in declaration order and echoes the LAST
# non-empty value found. Presets are read like the user's `defaults:`
# section — meaning a preset file with `defaults: { main: {…}, agents:
# {…}, … }` plugs straight into the defaults layer. Last-listed preset
# wins among the chosen set.
#
# Args: local_file agent_type key
#   agent_type empty → consults defaults.main → defaults.agents → defaults
#   agent_type set   → consults defaults.agents → defaults
_config_preset_lookup() {
  local local_file="$1" agent_type="$2" key="$3"
  local list
  list="$(config_presets_list "$local_file")"
  [[ -z "$list" ]] && return 0
  local name path val winner=""
  while IFS= read -r name || [[ -n "$name" ]]; do
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [[ -z "$name" ]] && continue
    path="$(config_preset_path "$name")"
    [[ -z "$path" ]] && continue
    if [[ -z "$agent_type" ]]; then
      val="$(config_yaml_get_nested "$path" "defaults" "main" "$key")"
      if [[ -n "$val" ]]; then winner="$val"; continue; fi
    fi
    val="$(config_yaml_get_nested "$path" "defaults" "agents" "$key")"
    if [[ -n "$val" ]]; then winner="$val"; continue; fi
    val="$(config_yaml_get_direct "$path" "defaults" "$key")"
    [[ -n "$val" ]] && winner="$val"
  done < <(printf '%s' "$list" | tr ',' '\n')
  [[ -n "$winner" ]] && echo "$winner"
}

# Generic per-key resolvers used by the security settings below.
# Main-session chain:
#   main.X
#   → defaults.main.X → defaults.agents.X → defaults.X     (user-written)
#   → presets[last-wins].defaults.{main,agents,_}.X        (opted-in defaults)
# Agent chain:
#   agents.<name>.X
#   → defaults.agents.X → defaults.X                       (user-written)
#   → presets[last-wins].defaults.{agents,_}.X             (opted-in defaults)
# Presets live in `defaults:` semantically — user-explicit values in either
# `main:` or `defaults:` always win over a preset.
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
  # Presets consulted once, after every user-file default.
  val="$(_config_preset_lookup "$local_file" "" "$key")"
  [[ -n "$val" ]] && echo "$val" && return
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
  val="$(_config_preset_lookup "$local_file" "$agent_type" "$key")"
  [[ -n "$val" ]] && echo "$val" && return
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
# Unions across presets/defaults/main (env var still overrides).
config_agent_secrets() {
  _config_setting_list "$1" "secrets" "" \
    "CC_MSB_MAIN_SECRETS" "CC_MSB_AGENT_SECRETS" "$2" "csv"
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
# Unions across layers (env var still overrides).
config_agent_tls_bypass() {
  _config_setting_list "$1" "tls_bypass" "" \
    "CC_MSB_MAIN_TLS_BYPASS" "CC_MSB_AGENT_TLS_BYPASS" "$2" "csv"
}

# Boolean "true" / "false": ship the host's CA bundle into the guest.
config_agent_trust_host_cas() {
  _config_setting "$1" "trust_host_cas" "false" \
    "CC_MSB_MAIN_TRUST_HOST_CAS" "CC_MSB_AGENT_TRUST_HOST_CAS" "$2"
}

# Boolean "true" / "false": when config drift is detected on a persistent
# sandbox, run the SDK-backed recreate script (snapshot → recreate from
# snapshot with new flags) instead of denying. Filesystem state is preserved.
# Image changes can't be applied this way (snapshot pins the base image),
# so on image-change drift we fall back to the regular deny.
config_agent_auto_recreate() {
  _config_setting "$1" "auto_recreate" "false" \
    "CC_MSB_MAIN_AUTO_RECREATE" "CC_MSB_AGENT_AUTO_RECREATE" "$2"
}

# ============================================================================
# git_* / github_* — sandbox-side git identity + GitHub token auto-scoping
# ============================================================================
# These follow the standard resolution chain. Keys are flat under `main:` /
# `agents.<name>:` / `defaults*:` (matching every other setting). Future
# refactor could group them under `git:` / `github:` sub-mappings if we
# extend the YAML parser to handle 4-level paths.

# Applied via `git config --global` inside the sandbox once it's up.
# Empty value → no `git config` run for that field.
config_agent_git_user_name() {
  _config_setting "$1" "git_user_name" "" \
    "CC_MSB_MAIN_GIT_USER_NAME" "CC_MSB_AGENT_GIT_USER_NAME" "$2"
}

config_agent_git_user_email() {
  _config_setting "$1" "git_user_email" "" \
    "CC_MSB_MAIN_GIT_USER_EMAIL" "CC_MSB_AGENT_GIT_USER_EMAIL" "$2"
}

# Either a literal token VALUE or `$VAR` to interpolate from the host env at
# hook time (same semantics as `secrets`). When set, the hook auto-appends
# one `--secret GH_TOKEN=<resolved>@<host>` per github host AND merges the
# hosts into the `network` allowlist.
config_agent_github_token() {
  _config_setting "$1" "github_token" "" \
    "CC_MSB_MAIN_GITHUB_TOKEN" "CC_MSB_AGENT_GITHUB_TOKEN" "$2"
}

# Comma-separated host allowlist scoped for the token. Empty → fall back to
# `sandbox_github_default_hosts`. Accepts a YAML list (parsed → joined).
# Unions across layers (env var still overrides).
config_agent_github_hosts() {
  _config_setting_list "$1" "github_hosts" "" \
    "CC_MSB_MAIN_GITHUB_HOSTS" "CC_MSB_AGENT_GITHUB_HOSTS" "$2" "csv"
}

# Boolean "true"/"false": when true (default), unset git_user_name /
# git_user_email fall back to the host's `git config --global --get
# user.name` / `user.email`. Explicit config values always win.
config_agent_git_user_autodetect() {
  _config_setting "$1" "git_user_autodetect" "true" \
    "CC_MSB_MAIN_GIT_USER_AUTODETECT" "CC_MSB_AGENT_GIT_USER_AUTODETECT" "$2"
}

# Boolean "true"/"false": when true (default), an unset github_token
# falls back to the host's `gh auth token` output (silently no-op if
# `gh` isn't on PATH or isn't authenticated). Explicit config wins.
config_agent_git_token_autodetect() {
  _config_setting "$1" "git_token_autodetect" "true" \
    "CC_MSB_MAIN_GIT_TOKEN_AUTODETECT" "CC_MSB_AGENT_GIT_TOKEN_AUTODETECT" "$2"
}
