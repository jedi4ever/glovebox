#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');
const { resolveConfig } = await import(join(pluginRoot, 'lib/config.mjs'));
const { sandboxNameFor, sandboxStateDir, sandboxTrack, sandboxEnsureRunning } =
  await import(join(pluginRoot, 'lib/sandbox.mjs'));
const { loadSdk } = await import(join(pluginRoot, 'lib/sdk.mjs'));

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function emitContext(ctx) {
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
}

// Check required tools
const missing = ['node', 'msb'].filter(cmd => {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return r.error != null;
});
if (missing.length) {
  const list = missing.map(c => `  - ${c}`).join('\n');
  emitContext(`WARNING: glovebox plugin is missing required tools:\n${list}\n\nPlease install the missing tools before using this plugin. Sandbox enforcement is DISABLED for this session.`);
  process.exit(0);
}

let event = {};
try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { /* ignore */ }
const sessionId = event.session_id ?? '';
if (!sessionId) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cfg = await resolveConfig(projectDir, '');

if (cfg.scope === 'host') {
  emitContext('glovebox: main scope is `host` — Bash/Read/Write/Edit run directly on the host, not in a sandbox. The system `# Environment` block above is authoritative.');
  process.exit(0);
}

const sandbox  = sandboxNameFor(sessionId, '', cfg.sandboxName, cfg.scope, projectDir);
const stateDir = sandboxStateDir(sessionId);
mkdirSync(stateDir, { recursive: true });

const payload = { ...cfg, projectDir, sandboxName: sandbox };
const { failed } = await sandboxEnsureRunning(sandbox, projectDir, join(stateDir, 'sandbox.log'), payload);
if (failed) process.exit(0);

if (cfg.scope !== 'directory' && !(cfg.scope === 'named' && cfg.sandboxName)) {
  sandboxTrack(sessionId, sandbox);
}

// Introspect the sandbox environment via SDK.
const probe = `printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n" "$(pwd)" "$(uname -s)" "$(uname -m)" "$SHELL" "$HOME" "$(whoami 2>/dev/null || printf %s "$USER")" "$(. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME")"`;

let lines = [];
if (process.env.GLOVEBOX_FAKE_CREATE) {
  // Test seam: fake-msb handles 'exec … bash -c'.
  const r = spawnSync('msb', ['exec', sandbox, '--', 'bash', '-c', probe], { encoding: 'utf8' });
  if (r.status !== 0) process.exit(0);
  lines = r.stdout.split('\n');
} else {
  try {
    const { Sandbox } = await loadSdk();
    const h = await Sandbox.get(sandbox);
    // connect() requires the sandbox to be fully running. Retry briefly in
    // case of a transient delay after sandboxEnsureRunning returns.
    let live;
    for (let i = 0; i < 5; i++) {
      try { live = await h.connect(); break; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!live) process.exit(0);
    const r = await live.shell(probe);
    if (!r.success) process.exit(0);
    lines = r.stdout().split('\n');
  } catch { process.exit(0); }
}

const [sbPwd, sbKernel, sbArch, sbShell, sbHome, sbUser, sbOsRaw] = lines;
const sbOs = sbOsRaw || `${sbKernel} (MSB sandbox)`;

const ctx = `# glovebox Sandbox Environment (OVERRIDES host \`# Environment\` block)

Every Bash, Read, Write, and Edit tool call is routed through an MSB sandbox. The host \`# Environment\` block above describes the machine Claude Code itself runs on — it is **not** where your tool calls execute. Do not reference the host's user name, home directory, working directory, OS, shell, or any \`/Users/*\` paths when answering questions about the environment you are working in.

Sandbox environment:
- Operating system: ${sbOs}
- Kernel: ${sbKernel}
- Architecture: ${sbArch}
- User: ${sbUser}
- Home directory: ${sbHome}
- Shell: ${sbShell}
- Working directory: ${sbPwd}
- Sandbox name: ${sandbox}
- Scope: ${cfg.scope}

When asked about your user / name / home directory / working directory / OS / shell / platform — answer with these sandbox values.`;

emitContext(ctx);
