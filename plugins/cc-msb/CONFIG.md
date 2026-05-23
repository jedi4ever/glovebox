# `.cc-msb.yml` configuration reference

Two config files are consulted on every tool call, in priority order:

1. **Local** — `$CLAUDE_PROJECT_DIR/.cc-msb.yml` (project root)
2. **Global** — `${CC_MSB_CONFIG_DIR:-$HOME/.config/cc-msb}/config.yml`

Both files are optional and share the exact same schema. The local file is consulted first; settings it doesn't define fall through to the global file, then to the built-in default. Env vars beat both files.

Set `CC_MSB_CONFIG_DIR` to point the global file somewhere else (useful for testing, or for keeping your global config under a dotfiles repo).

## List values

Settings that take a comma-separated string (`network`, `pass_env`, `ports`) can also be written as a YAML block list — the two forms are equivalent:

```yaml
main:
  network: "github.com,api.github.com,registry.npmjs.org"
  # …or:
  network:
    - github.com
    - api.github.com
    - registry.npmjs.org
```

The list form keeps long allowlists readable and lets you put a `# comment` on each line.

## Top-level structure

```yaml
defaults:
  # Bare keys directly under `defaults:` apply to BOTH main and agents.
  # Use this for settings you want shared across the board.
  sandbox_image: ubuntu
  mount_workdir: true
  pass_env: none
  ports: ""

  main:                   # main-only overrides of the shared defaults
    sandbox_image: debian
    network: "github.com,api.openai.com"

  agents:                 # agents-only overrides of the shared defaults
    scope: session
    network: enabled

main:                     # main-session overrides (per-project)
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

The `defaults:` block has three layers, in order of specificity:

- `defaults.main:` — overrides used **only** by the main session.
- `defaults.agents:` — overrides used **only** by agents (and as a fallback for main, for backwards compatibility).
- bare `defaults.<key>:` — shared baseline used by **both** main and agents when nothing more specific is set.

Typical use: put truly shared values (image, mount_workdir, pass_env) directly under `defaults:`, then specialize per-context only where you need to.

## Resolution order

Every setting follows the same precedence chain, from highest to lowest:

**Main session** (no agent context)
1. Env var (`CC_MSB_MAIN_*` or the legacy `CC_MSB_SANDBOX_IMAGE`/`CC_MSB_SANDBOX_NAME`)
2. `main.X` → `defaults.main.X` → `defaults.agents.X` → `defaults.X` in the **local** file
3. `main.X` → `defaults.main.X` → `defaults.agents.X` → `defaults.X` in the **global** file
4. Built-in default

**Agent** (`agent_type` present in the event)
1. Env var `CC_MSB_AGENT_<SETTING>_<AGENT_NAME>` (agent name uppercased with `-` → `_`)
2. `agents.<name>.X` → `defaults.agents.X` → `defaults.X` in the **local** file
3. `agents.<name>.X` → `defaults.agents.X` → `defaults.X` in the **global** file
4. Built-in default

The local file is treated as a complete layer: its `main.X → defaults.agents.X` cascade runs fully before the global file is consulted. So if your local file sets *anything* relevant to a given setting (even via `defaults.agents.X`), the global file's `main.X` for that setting is ignored.

`sandbox_name` is the one exception to the chain above: it is per-context and never inherited from `defaults.agents`. Agents fall back to the main session's `sandbox_name` (or `CC_MSB_SANDBOX_NAME`) when their own isn't set. `sandbox_image` for agents has an extra step too — the legacy `CC_MSB_SANDBOX_IMAGE` env var is consulted between the agent's own config (in both files) and the `defaults.agents` block (in both files).

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

### `secrets`

Inject secret env vars into the sandbox via msb's egress proxy. Each entry is the `ENV=VALUE@HOST` form msb itself takes.

| Value | Behavior |
|---|---|
| *(unset / empty)* *(default)* | No secrets injected. |
| `"ENV=VALUE@HOST[, ...]"` | One `--secret` flag per entry. |

The secret VALUE never appears inside the sandbox's env or filesystem — msb keeps it inside the egress proxy and substitutes it only into outbound traffic destined for `@HOST`. The sandbox sees a placeholder; the wire sees the real value.

If VALUE starts with `$`, it's interpolated from the host env at hook time. A missing host var causes that one secret entry to be silently skipped (same semantics as a `pass_env` list entry pointing at an unset var). Literal values are passed through unchanged.

```yaml
main:
  secrets:
    - "GITHUB_TOKEN=$GH_TOKEN@github.com"          # from host env
    - "NPM_TOKEN=$NPM_AUTH_TOKEN@registry.npmjs.org"
    - "FIXED=literal_value@api.example.com"        # literal — discouraged
```

**Env override**: `CC_MSB_MAIN_SECRETS`, `CC_MSB_AGENT_SECRETS_<NAME>`

### `on_secret_violation`

What msb does when the sandbox tries to send a secret to a non-allowlisted host.

| Value | Behavior |
|---|---|
| *(unset)* *(default)* | msb's own default applies. |
| `block` | Strip the secret from the request, let it proceed. |
| `block-and-log` | Same as `block`, plus log the violation. |
| `block-and-terminate` | Strip the secret and kill the sandbox. |

**Env override**: `CC_MSB_MAIN_ON_SECRET_VIOLATION`, `CC_MSB_AGENT_ON_SECRET_VIOLATION_<NAME>`

### `tls_intercept` / `tls_intercept_port` / `tls_bypass` / `trust_host_cas`

Enable msb's built-in TLS MITM proxy so the egress filter (network allowlist, secret substitution) can inspect HTTPS traffic.

```yaml
main:
  tls_intercept: true
  tls_intercept_port: 443     # default; only set if non-443
  tls_bypass:
    - "*.internal.com"        # don't intercept these
    - intranet.corp
  trust_host_cas: true        # ship host's CA bundle into the guest
```

| Setting | Type | Default | Behavior |
|---|---|---|---|
| `tls_intercept` | bool | `false` | Adds `--tls-intercept`. |
| `tls_intercept_port` | int | *(unset)* | Adds `--tls-intercept-port <N>`. |
| `tls_bypass` | list / string | *(unset)* | One `--tls-bypass <domain>` per entry. |
| `trust_host_cas` | bool | `false` | Adds `--trust-host-cas` — useful behind a corporate MITM proxy whose CA the host already trusts but the guest's stock CA bundle doesn't. |

**Env overrides**: `CC_MSB_MAIN_TLS_INTERCEPT`, `CC_MSB_MAIN_TLS_INTERCEPT_PORT`, `CC_MSB_MAIN_TLS_BYPASS`, `CC_MSB_MAIN_TRUST_HOST_CAS` (and the `CC_MSB_AGENT_…_<NAME>` equivalents).

### `git_user_name` / `git_user_email` — sandbox-side git identity

Applied via `git config --global` inside the guest right after sandbox creation. Best-effort: silently skipped if the image lacks `git`. Empty values are no-ops.

```yaml
main:
  git_user_name: "Alice Example"
  git_user_email: "alice@example.com"
```

Both fields participate in the drift fingerprint, so changing them on a long-lived sandbox triggers the standard recreate path (or `auto_recreate` if set).

**Autodetect**: by default, an unset `git_user_name` / `git_user_email` falls back to the host's `git config --global --get user.name` / `user.email` — so most users don't need to set these explicitly; their normal git identity flows through. Disable with `git_user_autodetect: false`.

**Env overrides**: `CC_MSB_MAIN_GIT_USER_NAME`, `CC_MSB_MAIN_GIT_USER_EMAIL`, `CC_MSB_MAIN_GIT_USER_AUTODETECT`, plus the `CC_MSB_AGENT_…_<NAME>` equivalents.

### `github_token` / `github_hosts` — scoped GitHub auth

Sugar over `secrets` + `network`. When `github_token` is set, the plugin auto-wires the standard GitHub host set:

```yaml
main:
  github_token: $GH_TOKEN     # literal value or $VAR (resolved from host env)
  # github_hosts:             # optional; defaults to the 5-host set below
  #   - github.com
  #   - api.github.com
```

Default hosts: `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`.

For each host in the (effective) list, the plugin emits one `--secret GH_TOKEN=<resolved>@<host>`. msb's egress proxy substitutes the placeholder into outbound traffic for that host only — the real token never reaches the sandbox env or filesystem. The hosts are also unioned into the `network` allowlist so the requests can actually leave.

Behavior with explicit `network:`:
- `network: enabled` (or unset): replaced with the github host list.
- `network: disabled`: **left alone**. The user opted out of egress; secrets are still configured but won't be usable until network is re-enabled.
- `network: "a,b"`: unioned with the github hosts (no duplicates).

If `github_token: $VAR` and `$VAR` is unset on the host, the entire expansion is silently skipped (matches `secrets`' behavior for unresolved `$VAR`s).

**Autodetect**: by default, an unset `github_token` falls back to the output of `gh auth token` on the host. If `gh` isn't on PATH or you aren't authenticated, the fallback silently no-ops (no secrets injected, no network change). Disable with `git_token_autodetect: false`.

**Env overrides**: `CC_MSB_MAIN_GITHUB_TOKEN`, `CC_MSB_MAIN_GITHUB_HOSTS`, `CC_MSB_MAIN_GIT_TOKEN_AUTODETECT`, plus the `CC_MSB_AGENT_…_<NAME>` equivalents.

## Behavior

### `auto_recreate` — preserve state on drift

By default, a config change to a long-lived sandbox triggers a **deny** with manual `msb stop && msb remove` instructions. Set `auto_recreate: true` (per-`main`, per-agent, or under `defaults`) and the plugin will instead:

1. Connect to the sandbox via the microsandbox SDK, `sync` pending writes, and `stopAndWait`.
2. Snapshot the writable overlay (`msb snapshot create`).
3. Remove the old sandbox.
4. Recreate it from the snapshot with the new flags applied (`Sandbox.builder(name).fromSnapshot(snap).…create()`).
5. Drop the temporary snapshot.

Result: filesystem state outside `/workspace` (apt installs, `/etc` edits, `/root` config, etc.) is preserved across the new flags. `/workspace` is already bind-mounted and unaffected either way.

**Exception**: if the desired `sandbox_image` differs from the snapshot's pinned base image, the snapshot can't be honored (msb's snapshot ties to a specific base). The hook detects this and falls back to the regular drift deny — the user accepts state loss for an image swap by running the manual `stop && remove`.

```yaml
main:
  scope: directory
  auto_recreate: true       # opt-in; default is false
```

**Env override**: `CC_MSB_MAIN_AUTO_RECREATE`, `CC_MSB_AGENT_AUTO_RECREATE_<NAME>`

### Config-drift detection (persistent sandboxes)

msb applies most settings (`sandbox_image`, `network`, `ports`, `secrets`, `on_secret_violation`, `tls_intercept`, `tls_intercept_port`, `tls_bypass`, `trust_host_cas`, `mount_workdir`) **only at `msb create` time**. They're baked into the sandbox's lifetime. If you edit `.cc-msb.yml` (or `~/.config/cc-msb/config.yml`) while a long-lived sandbox is up (e.g. `scope: named` / `scope: directory`), the running sandbox keeps using the old flags — silently.

To make this fail loudly, the plugin persists a 16-char fingerprint of every create-time setting to `~/.cache/cc-msb/fingerprints/<sandbox>.fp` whenever it creates a sandbox. On every subsequent hook call, the current effective config is re-hashed and compared. If the fingerprints differ, the hook emits a **deny** with a one-line recreate instruction:

```
cc-msb: settings in .cc-msb.yml changed since sandbox 'my-project' was created.
To apply: `msb stop 'my-project' && msb remove 'my-project'` — your next tool
call will recreate it. Files in /workspace are bind-mounted and unaffected;
other in-sandbox state (apt installs, /etc edits) will be lost.
```

Notes:
- Both local *and* global config changes are detected — the fingerprint hashes the *effective* (resolved) values, not the file contents.
- `pass_env` is **not** included in the fingerprint: it's applied at `msb exec` time per call, so changes take effect immediately without a recreate.
- Sandboxes that pre-date this feature (no `.fp` file on disk) are *not* flagged as drifted, so adopting the new version doesn't block existing long-lived sandboxes.
- `scope: per-run` sandboxes are created fresh per call → no drift is possible. `session` / `per-agent` sandboxes will drift on edits made mid-session.

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

### GitHub authentication with proper identity + scoped token

In the common case — your machine has `git config --global user.name`/`user.email` set and you're logged in via `gh auth login` — **no config is needed at all**. The plugin autodetects both. Just leave the new sections out of your `.cc-msb.yml`.

To override either piece explicitly:

```yaml
main:
  git_user_name: "Alice Example"           # overrides host git config
  git_user_email: "alice@example.com"
  github_token: $GH_TOKEN                  # overrides `gh auth token`
```

In both cases, the PAT is exposed *only* to outbound HTTPS to the standard GitHub host set (github.com, api.github.com, codeload.github.com, objects.githubusercontent.com, raw.githubusercontent.com). Any other host attempting to use `$GH_TOKEN` sees the placeholder unsubstituted. Hosts are also auto-allowlisted into `network:` so the requests can actually leave.

To opt out of autodetect:

```yaml
main:
  git_user_autodetect:  false   # don't read host git config
  git_token_autodetect: false   # don't call `gh auth token`
```

### Global defaults across every project
Put this in `~/.config/cc-msb/config.yml` (or `$CC_MSB_CONFIG_DIR/config.yml`). Any project without its own `.cc-msb.yml` inherits these settings; projects with a local file can selectively override.

Use `defaults.main:` for main-only baselines that you don't want agents to inherit:

```yaml
defaults:
  main:
    sandbox_image: debian
    network: "github.com,registry.npmjs.org,api.openai.com"
  agents:
    sandbox_image: ubuntu
    pass_env: none
    network: disabled        # agents air-gapped by default
```
