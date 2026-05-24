#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function version(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.error ? null : (r.stdout || r.stderr || '').split('\n')[0].trim();
}

const bunVer  = version('bun');
const nodeVer = version('node');
const msbVer  = version('msb');
const missing = [bunVer || nodeVer ? null : 'node (or bun)', msbVer ? null : 'msb'].filter(Boolean);

if (missing.length) {
  const list = missing.map(c => `  - ${c}`).join('\n');
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `WARNING: glovebox plugin is missing required tools:\n${list}\n\nPlease install the missing tools before using this plugin. Sandbox enforcement is DISABLED for this session.` } });
  process.exit(0);
}

const runtime  = bunVer ? `bun=${bunVer}` : `node=${nodeVer}`;
const versions = `${runtime}, msb=${msbVer}`;
const hint = 'Edit is not available for files inside the sandbox — use Bash to edit them. WebFetch is also intercepted — use Bash with curl to fetch URLs so they go through the sandbox\'s network policy.';
emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `glovebox sandbox is active (${versions}). ${hint}` } });
