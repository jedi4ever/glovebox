// Sandbox lifecycle helpers — SDK-backed, async throughout.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSdk } from './sdk.mjs';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');

// Load SDK once at module init — graceful if msb is not installed.
let Sandbox;
try { ({ Sandbox } = await loadSdk()); } catch { /* msb not installed */ }

export function sandboxStateDir(sessionId) {
  return join(homedir(), '.cache/glovebox', sessionId);
}

export function sandboxFingerprintPath(name) {
  return join(homedir(), '.cache/glovebox/fingerprints', `${name}.fp`);
}

export function sandboxTrack(sessionId, name) {
  const stateDir = sandboxStateDir(sessionId);
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'sandboxes'), `${name}\n`);
}

// ---------------------------------------------------------------------------
// Sandbox naming — mirrors sandbox_name_for() in sandbox.sh
// ---------------------------------------------------------------------------
export function sandboxNameFor(sessionId, agentType = '', explicitName = '', scope = 'session', projectDir = '') {
  if (scope === 'named' && explicitName) {
    const safe = explicitName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return safe || 'glovebox-named';
  }

  if (scope === 'directory') {
    const dir = projectDir || process.cwd();
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 12);
    return `glovebox-dir-${hash}`;
  }

  if (!agentType || scope === 'session' || scope === 'named') {
    return `glovebox-${sessionId.slice(0, 16)}`;
  }

  const lower = agentType.replace(/-/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');

  if (scope === 'per-agent') {
    return `glovebox-${sessionId.slice(0, 8)}-${lower.slice(0, 8)}`;
  }
  if (scope === 'per-run') {
    const rand = randomBytes(4).toString('hex');
    return `glovebox-${sessionId.slice(0, 8)}-${rand}`;
  }
  return `glovebox-${sessionId.slice(0, 16)}`;
}

// Like sandboxNameFor but treats per-run as per-agent (file ops need stable names).
export function sandboxNameForFileOp(sessionId, agentType = '', explicitName = '', scope = 'session', projectDir = '') {
  if (scope === 'per-run') {
    if (!agentType) return `glovebox-${sessionId.slice(0, 16)}`;
    const lower = agentType.replace(/-/g, '_').toLowerCase().replace(/[^a-z0-9_]/g, '');
    return `glovebox-${sessionId.slice(0, 8)}-${lower.slice(0, 8)}`;
  }
  return sandboxNameFor(sessionId, agentType, explicitName, scope, projectDir);
}

// ---------------------------------------------------------------------------
// Status / fingerprint
// ---------------------------------------------------------------------------

// Returns lowercase status string: 'running'|'stopped'|'crashed'|'' (not found).
export async function sandboxStatus(name) {
  // Test seam: fake-msb writes /tmp/fake-msb-<name>.state; SDK doesn't read those.
  if (process.env.GLOVEBOX_FAKE_CREATE) {
    try { return readFileSync(`/tmp/fake-msb-${name}.state`, 'utf8').trim().toLowerCase(); }
    catch { return ''; }
  }
  if (!Sandbox) return '';
  try { return (await Sandbox.get(name)).status; } catch { return ''; }
}

export function sandboxConfigFingerprint(image, mount, network, ports, secrets, onViolation, tlsOn, tlsPort, tlsBypass, trustCas, gitName, gitEmail) {
  const payload = `image=${image}|mount=${mount}|net=${network}|ports=${ports}|secrets=${secrets}|onv=${onViolation}|tls=${tlsOn}|tlsp=${tlsPort}|tlsb=${tlsBypass}|trust=${trustCas}|gitn=${gitName}|gite=${gitEmail}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function fingerprintFromPayload(payload) {
  return sandboxConfigFingerprint(
    payload.image ?? 'ubuntu',
    payload.mountWorkdir ? 'true' : 'false',
    payload.network ?? 'enabled',
    payload.ports ?? '',
    payload.secrets ?? '',
    payload.onSecretViolation ?? '',
    payload.tlsIntercept ? 'true' : 'false',
    payload.tlsInterceptPort != null ? String(payload.tlsInterceptPort) : '',
    payload.tlsBypass ?? '',
    payload.trustHostCas ? 'true' : 'false',
    payload.gitUserName ?? '',
    payload.gitUserEmail ?? '',
  );
}

// ---------------------------------------------------------------------------
// Ensure running — returns { drift: name|'', restarted?: true, failed?: true }
// ---------------------------------------------------------------------------
export async function sandboxEnsureRunning(name, projectDir, logFile, payload) {
  const status = await sandboxStatus(name);
  const currentFp = fingerprintFromPayload(payload);
  const fpPath = sandboxFingerprintPath(name);
  const storedFp = existsSync(fpPath) ? readFileSync(fpPath, 'utf8').trim() : '';

  if (status === 'running') {
    return { drift: storedFp && storedFp !== currentFp ? name : '' };
  }

  if (status === 'stopped') {
    if (storedFp && storedFp !== currentFp) return { drift: name };
    if (process.env.GLOVEBOX_FAKE_CREATE) {
      writeFileSync(`/tmp/fake-msb-${name}.state`, 'Running\n');
    } else if (Sandbox) {
      try {
        const h = await Sandbox.get(name);
        await h.startDetached();
      } catch { /* best-effort */ }
    }
    return { drift: '', restarted: true };
  }

  // Not found — create via sub-script (SDK create path, handles all config flags).
  const createScript = join(pluginRoot, 'scripts/create-sandbox.mjs');
  const input = JSON.stringify(payload);
  mkdirSync(dirname(logFile), { recursive: true });
  const r = spawnSync(process.execPath, [createScript], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logLine = r.stdout + (r.stderr || '');
  if (logLine) appendFileSync(logFile, logLine);
  if (r.status !== 0) return { drift: '', failed: true };
  mkdirSync(dirname(fpPath), { recursive: true });
  writeFileSync(fpPath, currentFp + '\n');
  return { drift: '' };
}

// ---------------------------------------------------------------------------
// Path resolution (mirrors sandbox_resolve_path)
// ---------------------------------------------------------------------------
export function sandboxResolvePath(filePath, projectDir, stateDir) {
  const shadowRoot = join(stateDir, 'shadow');
  const canonical = normalize(filePath);

  if (canonical === projectDir || canonical.startsWith(projectDir + '/')) {
    return { hostPath: filePath, needsSync: false };
  }
  if (canonical === '/workspace' || canonical.startsWith('/workspace/')) {
    return { hostPath: join(projectDir, canonical.slice('/workspace/'.length - 1)), needsSync: false };
  }
  if (canonical.startsWith('/')) {
    return { hostPath: shadowRoot + canonical, needsSync: true };
  }
  return { hostPath: filePath, needsSync: false };
}

// ---------------------------------------------------------------------------
// File sync helpers — SDK-backed, fall back to CLI in test mode.
// ---------------------------------------------------------------------------
export async function sandboxReadIntoShadow(name, vmPath, hostPath) {
  mkdirSync(dirname(hostPath), { recursive: true });

  if (process.env.GLOVEBOX_FAKE_CREATE) {
    // Test seam: fake-msb handles 'exec … cat <path>' in its exec subcommand.
    const r = spawnSync('msb', ['exec', name, '--', 'cat', vmPath], { encoding: 'buffer' });
    if (r.status !== 0) return false;
    writeFileSync(hostPath, r.stdout);
    return true;
  }

  if (!Sandbox) return false;
  try {
    const h = await Sandbox.get(name);
    const live = await h.connect();
    const bytes = await live.fs().read(vmPath);
    writeFileSync(hostPath, bytes);
    return true;
  } catch { return false; }
}

export async function sandboxWriteFromShadow(name, shadowPath, vmPath) {
  if (process.env.GLOVEBOX_FAKE_CREATE) {
    // Test seam: fake-msb handles 'exec … bash -c <script>' in its exec subcommand.
    const encodedDir  = Buffer.from(dirname(vmPath)).toString('base64');
    const encodedPath = Buffer.from(vmPath).toString('base64');
    const script = `mkdir -p "$(printf '%s' '${encodedDir}' | base64 -d)" && cat > "$(printf '%s' '${encodedPath}' | base64 -d)"`;
    const input = readFileSync(shadowPath);
    spawnSync('msb', ['exec', name, '--', 'bash', '-c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] });
    return;
  }

  if (!Sandbox) return;
  try {
    const h = await Sandbox.get(name);
    const live = await h.connect();
    const fs = live.fs();
    const dir = dirname(vmPath);
    if (dir && dir !== '/') await live.exec('mkdir', ['-p', dir]).catch(() => {});
    await fs.write(vmPath, readFileSync(shadowPath));
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Command wrapping (base64 to avoid all shell-escaping issues)
// ---------------------------------------------------------------------------
export function sandboxEnvArgs(spec) {
  const s = spec || '';
  if (!s || /^(none|NONE|None)$/i.test(s)) return [];
  if (/^(all|ALL|All)$/i.test(s)) {
    return Object.entries(process.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  }
  return s.split(',')
    .map(v => v.trim())
    .filter(v => v && v in process.env)
    .flatMap(v => ['--env', `${v}=${process.env[v]}`]);
}

export function sandboxWrapCommand(name, command, envArgs = []) {
  const encoded = Buffer.from(command).toString('base64');
  const envStr = buildEnvStr(envArgs);
  return `printf '%s' '${encoded}' | base64 -d | msb exec${envStr} '${name}' -- bash`;
}

export function sandboxWrapCommandEphemeral(name, command, envArgs = []) {
  const encoded = Buffer.from(command).toString('base64');
  const envStr = buildEnvStr(envArgs);
  return `printf '%s' '${encoded}' | base64 -d | msb exec${envStr} '${name}' -- bash; _ec=$?; msb stop '${name}' --quiet 2>/dev/null; msb remove '${name}' --quiet 2>/dev/null; exit $_ec`;
}

// Formats ['--env','K=V','--env','K2=V2'] → " --env 'K=V' --env 'K2=V2'"
function buildEnvStr(envArgs) {
  if (!envArgs.length) return '';
  const parts = [];
  for (let i = 0; i < envArgs.length; i++) {
    if (envArgs[i] === '--env' && i + 1 < envArgs.length) {
      parts.push(`--env ${shellQuote(envArgs[++i])}`);
    } else {
      parts.push(shellQuote(envArgs[i]));
    }
  }
  return ' ' + parts.join(' ');
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
