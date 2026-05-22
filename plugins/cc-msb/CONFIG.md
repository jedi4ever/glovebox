# `.cc-msb.yml` configuration reference

This file is read from the **project root** (`$CLAUDE_PROJECT_DIR/.cc-msb.yml`) on every tool call. It is optional — if absent, every setting falls back to its default.

## Top-level structure

```yaml
defaults:
  agents:                 # defaults applied to every agent (not main)
    scope: session
    sandbox_image: ubuntu
    mount_workdir: true
    pass_env: none

main:                     # settings for the main session — always explicit
  scope: named
  sandbox_name: my-project
  sandbox_image: debian
  mount_workdir: true
  pass_env: "HOME,PATH"

agents:                   # per-agent overrides — inherit from defaults.agents
  test-agent:
    scope: per-run
    sandbox_image: alpine
  reviewer:
    scope: named
    sandbox_name: reviewer-sandbox
    pass_env: all
```

There is no `defaults.main:` sub-section. Main settings are always written in full under `main:`.

## Resolution order

Every setting follows the same precedence chain, from highest to lowest:

**Main session** (no agent context)
1. Env var (`CC_MSB_MAIN_*` or the legacy `CC_MSB_SANDBOX_IMAGE`/`CC_MSB_SANDBOX_NAME`)
2. `main.<setting>` in the config file
3. `defaults.agents.<setting>` in the config file *(for `sandbox_image`, `mount_workdir`, `scope`, `pass_env`)*
4. Built-in default

**Agent** (`agent_type` present in the event)
1. Env var `CC_MSB_AGENT_<SETTING>_<AGENT_NAME>` (agent name uppercased with `-` → `_`)
2. `agents.<name>.<setting>` in the config file
3. `defaults.agents.<setting>` in the config file
4. Built-in default

## Settings

### `scope`

Where the sandbox lives and how its lifetime is bound.

| Value | Behavior |
|---|---|
| `session` *(default)* | One sandbox shared for the entire CC session; agents share it with main. |
| `per-agent` | Each agent type gets its own sandbox; main keeps the session sandbox. |
| `per-run` | Each agent bash call gets a fresh sandbox; destroyed after the call. |
| `named` | Use `sandbox_name` directly — persists across sessions. |
| `directory` | Sandbox name is derived (SHA-256) from the project dir — persists across sessions in that dir. |
| `host` | **No sandbox.** Tool calls run directly on the host. Use for trusted contexts. |

**Env override**: `CC_MSB_MAIN_SCOPE`, `CC_MSB_AGENT_SCOPE_<NAME>`

### `sandbox_image`

OCI/MSB image used when creating a sandbox.

- Type: string
- Default: `ubuntu`
- Examples: `ubuntu`, `debian`, `alpine`, `python:3.12`

**Env override**: `CC_MSB_SANDBOX_IMAGE` (legacy, applies to main), `CC_MSB_AGENT_IMAGE_<NAME>`

### `sandbox_name`

Explicit sandbox name. Required when `scope: named`; ignored otherwise.

- Type: string
- Default: *(unset)* — `named` scope without a name falls back to `session` scope.

**Env override**: `CC_MSB_SANDBOX_NAME` (main), `CC_MSB_AGENT_SANDBOX_NAME_<NAME>`

### `mount_workdir`

Whether to bind-mount the project dir into the sandbox at `/workspace`.

- Type: boolean (`true` / `false`)
- Default: `true`

When `false`, the sandbox cannot see project files — useful for testing isolation or running fully-self-contained workflows.

**Env override**: `CC_MSB_MAIN_MOUNT_WORKDIR`, `CC_MSB_AGENT_MOUNT_WORKDIR`

### `pass_env`

Which host env vars to forward into the sandbox via `msb exec --env`.

| Value | Behavior |
|---|---|
| `none` *(default)* | Pass nothing. The sandbox sees only its own native env. |
| `all` | Pass every host env var. |
| `"VAR1,VAR2,..."` | Pass only the listed vars (skipping any that are unset on the host). |

Applied at exec time, so each Bash call sees the current host env. Internal shadow-sync calls (for Read/Write) don't forward env.

**Env override**: `CC_MSB_MAIN_PASS_ENV`, `CC_MSB_AGENT_PASS_ENV_<NAME>`

## Env-var naming

- Main settings use a fixed name: `CC_MSB_MAIN_<SETTING>` (e.g. `CC_MSB_MAIN_SCOPE`).
- Agent settings include the agent name uppercased with `-` mapped to `_`:
  `agent_type: test-agent` → `CC_MSB_AGENT_SCOPE_TEST_AGENT`
- Two legacy globals are still recognized for backwards compatibility:
  `CC_MSB_SANDBOX_IMAGE` (main image), `CC_MSB_SANDBOX_NAME` (main named sandbox).

## Examples

### Minimal — only override the main image
```yaml
main:
  sandbox_image: debian
```

### Persistent sandbox for the project (survives across CC sessions)
```yaml
main:
  scope: named
  sandbox_name: my-project-sandbox
```

### Lock everything to a directory-derived sandbox
```yaml
defaults:
  agents:
    scope: directory
main:
  scope: directory
```

### Trust the main session, sandbox the agents
```yaml
defaults:
  agents:
    scope: session
main:
  scope: host
```

### Per-agent specialization
```yaml
defaults:
  agents:
    sandbox_image: ubuntu
    scope: session
    pass_env: none

agents:
  builder:
    sandbox_image: node:20
    pass_env: "NPM_TOKEN,GH_TOKEN"
  reviewer:
    scope: per-run         # fresh sandbox per bash call — ephemeral by design
    sandbox_image: alpine
  release:
    scope: host            # release scripts run on the host
```

### Forward selected secrets to the sandbox
```yaml
main:
  pass_env: "ANTHROPIC_API_KEY,GITHUB_TOKEN"
```
