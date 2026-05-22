# `.cc-msb.yml` configuration reference

This file is read from the **project root** (`$CLAUDE_PROJECT_DIR/.cc-msb.yml`) on every tool call. It is optional — if absent, every setting falls back to its default.

## Top-level structure

```yaml
defaults:
  agents:                 # defaults inherited by every agent — and by `main`
    scope: session        # as a fallback when main.<setting> is not set
    sandbox_image: ubuntu
    mount_workdir: true
    pass_env: none
    network: enabled
    ports: ""

main:                     # main-session settings
  scope: named
  sandbox_name: my-project
  sandbox_image: debian
  mount_workdir: true
  pass_env: "HOME,PATH"
  network: "github.com,api.openai.com"
  ports: "8080:80,5432:5432"

agents:                   # per-agent overrides — inherit from defaults.agents
  test-agent:
    scope: per-run
    sandbox_image: alpine
  reviewer:
    scope: named
    sandbox_name: reviewer-sandbox
    pass_env: all
    network: disabled
```

There is no `defaults.main:` sub-section. The `defaults.agents:` block doubles as the fallback layer for `main` settings that aren't explicitly set under `main:` (except `sandbox_name`, which is per-context).

## Resolution order

Every setting follows the same precedence chain, from highest to lowest:

**Main session** (no agent context)
1. Env var (`CC_MSB_MAIN_*` or the legacy `CC_MSB_SANDBOX_IMAGE`/`CC_MSB_SANDBOX_NAME`)
2. `main.<setting>` in the config file
3. `defaults.agents.<setting>` in the config file *(for `scope`, `sandbox_image`, `mount_workdir`, `pass_env`, `network`, `ports`)*
4. Built-in default

**Agent** (`agent_type` present in the event)
1. Env var `CC_MSB_AGENT_<SETTING>_<AGENT_NAME>` (agent name uppercased with `-` → `_`)
2. `agents.<name>.<setting>` in the config file
3. `defaults.agents.<setting>` in the config file
4. Built-in default

`sandbox_name` is the one exception to the chain above: it is per-context and never inherited from `defaults.agents`. Agents fall back to the main session's `sandbox_name` (or `CC_MSB_SANDBOX_NAME`) when their own isn't set. `sandbox_image` for agents has an extra step too — the legacy `CC_MSB_SANDBOX_IMAGE` env var is consulted between the agent's own config and `defaults.agents`.

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

### `network`

Outbound network policy for the sandbox.

| Value | Behavior |
|---|---|
| `enabled` *(default)* | Full network access — msb's normal behavior (egress allowed to public addresses). |
| `disabled` | Complete network isolation — adds `--no-net` to `msb create`. |
| `"domain1,domain2,..."` | Allowlist: only the listed domains are reachable; everything else is denied. Translates to one `--net-rule allow@<domain>` per entry. |

Applied at sandbox-creation time, so the policy is fixed for the sandbox's lifetime. Changing `network` for a long-lived sandbox (named/directory scope) only takes effect when the sandbox is destroyed and recreated.

**Env override**: `CC_MSB_MAIN_NETWORK`, `CC_MSB_AGENT_NETWORK_<NAME>`

### `ports`

Host port forwardings into the sandbox. Each entry is an msb `--port` mapping in `HOST:GUEST` form, with an optional `/tcp` or `/udp` proto suffix.

| Value | Behavior |
|---|---|
| *(unset / empty)* *(default)* | No host ports are forwarded into the sandbox. |
| `"HOST:GUEST[,HOST:GUEST/proto,...]"` | One `--port` flag per comma-separated entry. |

Applied at sandbox-creation time, so the mappings are fixed for the sandbox's lifetime. Updating `ports` for a long-lived sandbox (`named`/`directory`) requires destroying and recreating the sandbox to take effect.

**Env override**: `CC_MSB_MAIN_PORTS`, `CC_MSB_AGENT_PORTS_<NAME>`

## Behavior

### WebFetch interception

The plugin denies the `WebFetch` tool with a hint telling Claude to use `Bash` with `curl` instead. The Bash hook then routes that curl call through `msb exec` so the fetch happens **inside** the sandbox and respects the configured `network` policy — otherwise CC's built-in WebFetch would bypass every cc-msb config and hit the URL from the host.

PreToolUse hooks can't return synthetic tool results, so this two-turn bounce (deny → next-turn Bash) is the cleanest path. There's no opt-out per se; `scope: host` already bypasses every cc-msb hook, including this one.

For tests / projects that fetch URLs, choose a sandbox image that ships with curl preinstalled (e.g. `buildpack-deps:noble`) — the default `ubuntu` image doesn't have curl and Claude would have to `apt-get install` it first.

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

### Air-gapped main session, allowlisted agents
```yaml
main:
  network: disabled
agents:
  fetcher:
    network: "registry.npmjs.org,github.com,objects.githubusercontent.com"
```

### Expose a dev server running inside the sandbox
```yaml
main:
  scope: named
  sandbox_name: my-app-dev
  ports: "3000:3000,9229:9229"   # web + node inspector
```
