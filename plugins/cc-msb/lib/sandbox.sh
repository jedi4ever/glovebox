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
# Args: name, project_dir, log_file [image]
sandbox_ensure_running() {
  local name="$1" project_dir="$2" log_file="$3"
  local image="${4:-${CC_MSB_SANDBOX_IMAGE:-ubuntu}}"
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
      if [[ "${CC_MSB_MOUNT_WORKDIR:-true}" == "true" ]]; then
        create_args+=(--volume "$project_dir:/workspace")
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
sandbox_wrap_command() {
  local name="$1" command="$2"
  local encoded
  encoded=$(printf '%s' "$command" | base64 | tr -d '\n')
  echo "printf '%s' '$encoded' | base64 -d | msb exec '$name' -- bash"
}
