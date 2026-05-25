#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

const homeDir    = process.env.HOME || '';
const configDir  = process.env.GLOVEBOX_CONFIG_DIR || join(homeDir, '.config', 'glovebox');
const globalConf = join(configDir, 'config.yml');
const localConf  = join(process.env.CLAUDE_PROJECT_DIR || '.', '.glovebox.yml');
const hasConfig  = existsSync(globalConf) || existsSync(localConf);

if (!hasConfig) {
  const defaultImage = 'ghcr.io/jedi4ever/glovebox:latest';
  const images = spawnSync('msb', ['images'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const imageFound = (images.stdout || '').includes('jedi4ever/glovebox');
  if (!imageFound) {
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `WARNING: glovebox default image not found.\n\nRun: msb pull ${defaultImage}\n\nSandbox enforcement is DISABLED for this session.` } });
    process.exit(0);
  }
}

const runtime  = bunVer ? `bun=${bunVer}` : `node=${nodeVer}`;
const versions = `${runtime}, msb=${msbVer}`;
const hint = 'Edit is not available for files inside the sandbox — use Bash to edit them. WebFetch is also intercepted — use Bash with curl to fetch URLs so they go through the sandbox\'s network policy.';
emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `glovebox sandbox is active (${versions}). ${hint}` } });
