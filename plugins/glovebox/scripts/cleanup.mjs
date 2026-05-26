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
  if (process.env.GLOVEBOX_FAKE_CREATE) {
    try { rmSync(`/tmp/fake-msb-${name}.state`); } catch {}
    return;
  }
  if (!Sandbox) return;
  try {
    let h = await Sandbox.get(name);
    if (h.status === 'running' || h.status === 'draining') {
      // connect() + stopAndWait() waits for VM exit before remove().
      // Fall back to kill() for stuck sandboxes (e.g. broken mounts).
      try {
        const live = await h.connect();
        await live.stopAndWait();
      } catch {
        try { await h.kill(); } catch {}
      }
      // Poll until the sandbox leaves running/draining (the user noted a
      // timing gap between kill() and the daemon updating the status).
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          h = await Sandbox.get(name);
          if (h.status !== 'running' && h.status !== 'draining') break;
        } catch { break; }
      }
    }
    // Static Sandbox.remove() works immediately after stopAndWait(); the
    // instance handle.remove() can fail with SandboxStillRunning on the
    // same tick due to a daemon internal-lock release lag.
    await Sandbox.remove(name);
  } catch { /* sandbox already gone */ }
}

if (existsSync(sandboxList)) {
  const names = [...new Set(readFileSync(sandboxList, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))];
  for (const name of names) await removeSandbox(name);
} else {
  // Fallback for sessions predating sandbox tracking
  await removeSandbox(`glovebox-${sessionId.slice(0, 16)}`);
}

try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
