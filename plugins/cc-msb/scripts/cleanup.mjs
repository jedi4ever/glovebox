#!/usr/bin/env node
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');
const { sandboxStateDir, sandboxStatus } = await import(join(pluginRoot, 'lib/sandbox.mjs'));

let event = {};
try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { /* ignore */ }
const sessionId = event.session_id ?? '';
if (!sessionId) process.exit(0);

const stateDir     = sandboxStateDir(sessionId);
const sandboxList  = join(stateDir, 'sandboxes');

function removeSandbox(name) {
  if (!name) return;
  if (!sandboxStatus(name)) return;
  spawnSync('msb', ['stop',   name, '--quiet'], { stdio: 'ignore' });
  spawnSync('msb', ['remove', name, '--quiet'], { stdio: 'ignore' });
}

if (existsSync(sandboxList)) {
  const names = [...new Set(readFileSync(sandboxList, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))];
  for (const name of names) removeSandbox(name);
} else {
  // Fallback for sessions predating sandbox tracking
  removeSandbox(`cc-msb-${sessionId.slice(0, 16)}`);
}

try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
