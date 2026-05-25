# Glovebox — Project Narrative

> Don't box the agent. Box the action.

## Why Glovebox?

A lab glovebox is a sealed chamber for handling things you can't be in the room with — radioactive material, toxic compounds. The operator stands outside. Gloves are built into the wall. You see through the window, you decide from outside, and only your hands cross the boundary through a narrow, controlled interface.

That's the model here. The agent is the operator. The sandbox is the box. Bash, Edit, Read, Write are the gloves — the only way anything gets touched. A hallucinated `rm -rf` or a prompt-injected exfiltration attempt stays inside the box.

---

## What Is This?

- **Glovebox** is a Claude Code plugin that routes all Claude tool calls (Bash, Read, Write, Edit, WebFetch) through isolated [Micro Sandbox (MSB)](https://microsandbox.dev) micro-VMs, preventing Claude from running arbitrary commands on your host machine
- The plugin lives at `plugins/glovebox/` and is usable directly — no compilation step required
- This project repo contains only the test harness (Vitest + TypeScript); the plugin itself is the deliverable

### Inner vs. Outer Sandboxing

Most sandboxing approaches for AI agents are **outer sandboxes** — they wrap the entire Claude Code process inside a container or VM. The agent is boxed.

Glovebox is an **inner sandbox**. Claude Code itself runs normally on your host. What gets sandboxed are the individual *actions* Claude takes — each Bash command, each file read, each write — intercepted at the tool call level via Claude's hook system and redirected into a micro-VM.

This is distinct from Claude Code's own built-in sandbox: rather than restricting what Claude Code can do as a process, Glovebox replaces the execution target for each tool call. Claude thinks it's running commands locally; they actually run inside an isolated VM. The agent stays on the host; only the actions cross the boundary.

Anthropic has since embraced the same idea officially with [self-hosted sandboxes for managed agents](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes), allowing the execution plane to be delegated to providers like E2B or Daytona. Glovebox takes the same approach but locally, via MSB micro-VMs, with finer-grained control over network policy, secrets, and config.

The same pattern was pioneered by [pi-gondolin](https://github.com/pasky/pi-gondolin) — a Pi coding agent extension that uses [Gondolin](https://github.com/earendil-works/gondolin) as its inner execution engine in the same way. That project was the direct inspiration for Glovebox.

---

## Why Was It Built?

- The inspiration came from [Gondolin](https://github.com/earendil-works/gondolin) — a programmable sandbox that could execute commands in isolation without putting the host inside a container
- Previous sandboxing approaches (Docker, bubblewrap, seatbelt) all had friction: secrets management, static configuration, version drift with Claude Code updates
- Claude Code's own sandbox was not restrictive enough for our purposes
- [Micro Sandbox](https://microsandbox.dev) was chosen because it supports OCI/existing container images, and MSB gives a JavaScript SDK — making it *programmable*, not just configurable

---

## The Core Problem It Solves

- When Claude Code runs `bash`, `read`, or `write` commands, they run on *your* host by default
- Glovebox intercepts those calls via Claude's **hook system** and transparently redirects them into a sandboxed micro-VM
- Claude doesn't know it's sandboxed — the same commands work, but execution is isolated

---

## How the Hook System Works

- Claude Code supports hooks that fire at `SessionStart`, `PreToolUse`, `PostToolUse`, and `SessionEnd`
- Glovebox registers hooks in `hooks/hooks.json` to intercept every relevant tool
- **Bash** → the command is base64-encoded and wrapped as `printf '<base64>' | base64 -d | msb exec -- bash` to avoid shell-escaping issues
- **Read** → the file is pulled from the sandbox into a local shadow directory, then Claude reads the shadow copy
- **Write/Edit** → writes land in the shadow directory first; PostToolUse syncs them back into the sandbox
- **WebFetch** → denied with a hint to use `curl` inside a Bash call instead (so network policy applies)
- `pre-tool-use.mjs` handles interception; `post-tool-use.mjs` handles sync-back and notices to Claude

---

## Sandbox Lifecycle

- At **SessionStart**: `preflight.mjs` checks that `node` and `msb` are available; `session-start.mjs` creates/starts the sandbox and probes its environment (OS, shell, user, pwd)
- At **SessionEnd**: `cleanup.mjs` stops and removes all sandboxes created during the session
- The sandbox name is deterministic per scope (session, directory, named, per-agent, per-run), stored in `~/.cache/glovebox/<sessionId>/sandboxes`
- The project directory is **bind-mounted** into the sandbox as `/workspace` — edits to project files are immediately visible on both sides with no sync needed
- Files outside `/workspace` (e.g. `/etc`, `/root`) go through a **shadow directory** (`~/.cache/glovebox/<sessionId>/shadow`) for bidirectional sync

---

## Drift Detection & Auto-Recreate

- Every sandbox gets a **config fingerprint** (SHA256 of image, mounts, network, secrets, ports) stored at `~/.cache/glovebox/fingerprints/<name>.fp`
- If the config changes between sessions (image upgrade, new network rule), drift is detected on the next run
- With `auto_recreate: true`, glovebox automatically: snapshots the sandbox state, tears it down, recreates it with the new config, restores the snapshot — transparent to Claude
- Without `auto_recreate`, Claude is told the sandbox needs recreation and how to trigger it

---

## Configuration System

- Projects configure glovebox via `.glovebox.yml` at the project root
- A global config lives at `~/.config/glovebox/config.yml`
- Environment variables (`GLOVEBOX_MAIN_*`, `GLOVEBOX_AGENT_*_NAME`) take highest priority
- **Resolution order**: env var → local YAML → global YAML → presets → built-in defaults
- Config supports per-agent overrides so different Claude sub-agents can use different sandboxes

### Sandbox Scopes
- `session` — one sandbox per Claude Code session (default)
- `directory` — one sandbox shared across all sessions in the same project directory
- `named` — an explicitly named, persistent sandbox
- `per-agent` — one sandbox per Claude sub-agent within the session
- `per-run` — a fresh ephemeral sandbox per Bash call
- `host` — no sandbox; run directly on host (opt-out)

### Presets
- Built-in presets for common developer ecosystems: `npm`, `pip`, `cargo`, `go`, `apt`, `docker`, `github`, `dev`
- Each preset opens the right network allowlist, enables auth autodetect, and enables necessary tools
- Multiple presets compose: `presets: [github, npm]` merges both

---

## Network & Security Controls

- Network policy is configurable: `enabled` (full), `disabled` (no egress), or an allowlist of hostnames
- A TLS proxy layer can transparently inspect and control outbound HTTPS traffic
- **Secrets** are injected into the sandbox as environment variables — they are never visible to Claude in plaintext
- **GitHub auth**: `gh auth token` is read from the host and passed as a secret into the sandbox; HTTPS git works, SSH does not
- **Pass-env**: control which host environment variables are forwarded into the sandbox (`none`, `all`, or an explicit list)
- Port forwarding is supported for dev servers running inside the sandbox

---

## Context Injection (What Claude Sees)

- By default, Claude Code injects host OS information into its context (username, OS type, working directory)
- Glovebox overrides this at session start by probing the *sandbox* environment and injecting that instead — Claude believes it's operating in the sandbox, not on the host
- This prevents Claude from making incorrect assumptions about available tools or the filesystem layout

---

## Replacing `!` (`glovebox-bash`)

- There is also a shell shim that intercepts the `!` command in Claude Code's prompt box
- It finds the active `glovebox-*` sandbox and routes `!` commands through `msb exec` instead of the host shell
- Activated by setting `CLAUDE_CODE_SHELL` in `.claude/settings.json`
- Falls back to host bash for interactive or scripting cases where sandbox routing doesn't apply

---

## Implementation Choices & Evolution

- Started with bash hook scripts → moved to Node.js → settled on plain `.mjs` files for low startup latency and testability
- Both Bun and Node work, but Bun needs special handling for some test cases that behave differently under Bun
- All plugin code is plain JavaScript (no TypeScript compilation) to keep it directly usable
- Shared logic lives in `lib/`: `config.mjs`, `config-yaml.mjs`, `config-merge.mjs`, `sandbox.mjs`, `sdk.mjs`
- A custom minimal YAML parser (`config-yaml.mjs`) was written with no external dependencies, handling the subset of YAML needed for config files
- The MSB SDK is loaded with a fallback resolver (`lib/sdk.mjs`) that handles nvm/fnm/global install layouts

---

## Testing Strategy

- Tests run in **completely isolated Claude Code sessions**: separate `CLAUDE_CONFIG_DIR`, no memory, Anthropic API key auth
- Two test layers:
  - **Integration tests** (`src/tests/*.test.ts`) — spawn real `claude` processes with the plugin and assert sandbox behavior end-to-end
  - **Unit tests** (`src/tests/unit/*.test.ts`) — test hook functions and config logic in isolation, no Claude spawning
- **Fixtures** (`src/tests/fixtures/`) provide pre-configured project directories for each scenario (scope types, network modes, images, secrets, etc.) — no ad-hoc config creation in tests
- A `fake-msb` fixture provides a mock MSB CLI for unit tests that need to inspect sandbox create arguments without a real VM
- Global setup cleans up leftover test sandboxes before each test run
- `claude plugin validate` is run as part of the validation step

---

## Known Limitations & Open Issues

- If hooks are misconfigured, commands fall through to the host — there is no hard kernel-level enforcement
- New Claude Code tools added in the future would bypass the sandbox until a hook is added for them
- Disk sizing for sandboxes has an outstanding patch upstream
- Claude's local memory and plans remain accessible (intentional — lets Claude use project context) but could leak across sessions if not managed
