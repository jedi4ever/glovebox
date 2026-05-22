# Hook response JSON helpers. Sourced — not executed directly.

emit_allow_rewrite() {
  jq -nc --arg cmd "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: $cmd }
    }
  }'
}

emit_allow_file_path() {
  local file_path="$1" original_input="$2"
  jq -nc --arg fp "$file_path" --argjson orig "$(jq -c '.tool_input' <<<"$original_input")" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: ($orig + { file_path: $fp })
    }
  }'
}

emit_deny() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
}
