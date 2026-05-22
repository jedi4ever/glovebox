# Sandbox lifecycle helpers. Sourced — not executed directly.

sandbox_name() {
  echo "cc-msb-${1:0:16}"
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

# Ensures the named sandbox is running. Creates it if it doesn't exist.
# Args: name, project_dir, log_file
sandbox_ensure_running() {
  local name="$1" project_dir="$2" log_file="$3"
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
      msb create ubuntu \
        --name "$name" \
        --volume "$project_dir:/workspace" \
        --workdir /workspace \
        --quiet 2>>"$log_file"
      ;;
  esac
}

# Wraps an arbitrary command to run inside the sandbox via base64 encoding,
# avoiding any shell-escaping issues with the original command content.
sandbox_wrap_command() {
  local name="$1" command="$2"
  local encoded
  encoded=$(printf '%s' "$command" | base64 | tr -d '\n')
  echo "printf '%s' '$encoded' | base64 -d | msb exec '$name' -- bash"
}
