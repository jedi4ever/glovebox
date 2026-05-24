#!/usr/bin/env node
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');
const { sandboxStateDir } = await import(join(pluginRoot, 'lib/sandbox.mjs'));
const { loadSdk } = await import(join(pluginRoot, 'lib/sdk.mjs'));

let event = {};
try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { /* ignore */ }
const sessionId = event.session_id ?? '';
if (!sessionId) process.exit(0);

const stateDir    = sandboxStateDir(sessionId);
const sandboxList = join(stateDir, 'sandboxes');

let Sandbox;
try { ({ Sandbox } = await loadSdk()); } catch { /* msb not installed */ }

async function removeSandbox(name) {
  if (!name) return;
  if (process.env.CC_MSB_FAKE_CREATE) {
    try { rmSync(`/tmp/fake-msb-${name}.state`); } catch {}
    return;
  }
  if (!Sandbox) return;
  try {
    const h = await Sandbox.get(name);
    await h.stop().catch(() => {});
    await h.remove().catch(() => {});
  } catch { /* sandbox already gone */ }
}

if (existsSync(sandboxList)) {
  const names = [...new Set(readFileSync(sandboxList, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))];
  for (const name of names) await removeSandbox(name);
} else {
  // Fallback for sessions predating sandbox tracking
  await removeSandbox(`cc-msb-${sessionId.slice(0, 16)}`);
}

try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
