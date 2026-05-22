---
name: shell
description: Route Claude Code's `!`-prefixed input-box commands through the cc-msb sandbox so the user's terminal sees the same filesystem and state as Claude's Bash, Read, Write, and Edit tool calls. Activated by setting CLAUDE_CODE_SHELL to the bundled shim. Falls back transparently to /bin/bash when no cc-msb sandbox is running.
---

# cc-msb shell

By default, `!cmd` typed in Claude Code's input box runs on the **host** — separate from the cc-msb sandbox where Claude's tool calls execute. This skill ships a drop-in bash shim (`cc-msb-bash.sh`) that routes those `!` commands through the newest running cc-msb MSB sandbox so your input-box shell and Claude share the same state.

## Activate

Add an `env.CLAUDE_CODE_SHELL` entry to your project's `.claude/settings.json` (or `.claude/settings.local.json` for personal opt-in):

```json
{
  "env": {
    "CLAUDE_CODE_SHELL": "${CLAUDE_PLUGIN_ROOT}/skills/shell/cc-msb-bash.sh"
  }
}
```

Start (or restart) Claude Code from this project. From that point on, every `!` command in the input box is routed through the cc-msb sandbox.

## How it works

The shim follows the gondolin-sandbox `gondolin-bash.sh` pattern:

1. Parses the bash invocation (`-c <cmd>`, bare command string, script file, interactive). Only `-c <cmd>` (and the equivalent bare-string form CC sometimes uses) is rewritten — every other form is deferred to real `/bin/bash`.
2. Skips already-wrapped commands so Bash-tool calls (which the PreToolUse hook has already rewritten as `printf '%s' '<b64>' | base64 -d | msb exec '<name>' -- bash`) aren't double-wrapped.
3. Looks up the newest running `cc-msb-*` sandbox via `msb list`. If none is running, falls back to `/bin/bash` so unrelated terminal usage is unaffected.
4. Otherwise execs `msb exec <sandbox> -- bash -c <cmd>`.

## Deactivate

Remove the `CLAUDE_CODE_SHELL` entry from `.claude/settings.json` and restart Claude Code.
