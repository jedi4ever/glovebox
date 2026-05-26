#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');
const { resolveConfig } = await import(join(pluginRoot, 'lib/config.mjs'));
const {
  sandboxNameFor, sandboxNameForFileOp, sandboxStateDir, sandboxTrack,
  sandboxEnsureRunning, sandboxResolvePath, sandboxReadIntoShadow,
  sandboxConfigFingerprint, sandboxFingerprintPath,
  sandboxEnvArgs, sandboxWrapCommand, sandboxWrapCommandEphemeral,
} = await import(join(pluginRoot, 'lib/sandbox.mjs'));

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const event = JSON.parse(readFileSync(0, 'utf8'));
const toolName  = event.tool_name ?? '';
const sessionId = event.session_id ?? '';
const agentType = event.agent_type ?? '';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function allow(updatedInput) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } });
}

function allowFilePath(filePath) {
  allow({ ...event.tool_input, file_path: filePath });
}

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function writeSandboxNotice(stateDir, type, sandboxName) {
  writeFileSync(join(stateDir, 'sandbox-notice.json'), JSON.stringify({ type, sandbox: sandboxName }));
}

// Pass-through tools
if (/^mcp__|^WebSearch$|^Agent$/.test(toolName)) process.exit(0);

const cfg = await resolveConfig(projectDir, agentType);

if (cfg.scope === 'host') process.exit(0);

// ---------------------------------------------------------------------------
function shouldTrack(scope, sandboxName) {
  return scope !== 'directory' && !(scope === 'named' && sandboxName);
}

function writeFp(name, payload) {
  const fp = sandboxConfigFingerprint(
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
    payload.user ?? '',
  );
  const fpPath = sandboxFingerprintPath(name);
  mkdirSync(dirname(fpPath), { recursive: true });
  writeFileSync(fpPath, fp + '\n');
}

// ---------------------------------------------------------------------------
async function handleDrift(driftName, stateDir, createPayload) {
  if (!driftName) return false;
  if (!cfg.autoRecreate) {
    deny(`glovebox: settings in .glovebox.yml changed since sandbox '${driftName}' was created. msb applies most flags only at create time. To apply: \`msb stop '${driftName}' && msb remove '${driftName}'\` — your next tool call will recreate it. (Set \`auto_recreate: true\` to do this automatically.)`);
    return true;
  }

  const recreateScript = join(pluginRoot, 'scripts/recreate-sandbox.mjs');
  // Use node explicitly: bun runs SDK cleanup on exit even with process.exit(0).
  const r = spawnSync('node', [recreateScript], {
    input: JSON.stringify(createPayload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let result = {};
  try { result = JSON.parse(r.stdout); } catch { /* ignore */ }

  if (result.ok) {
    writeFp(driftName, createPayload);
    writeSandboxNotice(stateDir, 'recreated', driftName);
    return false;
  }
  if (result.imageChanged) {
    deny(`glovebox: settings changed AND image changed for sandbox '${driftName}'. Image swaps require a full recreate. Run: \`msb stop '${driftName}' && msb remove '${driftName}'\``);
  } else {
    deny(`glovebox: auto_recreate failed for sandbox '${driftName}': ${result.error ?? 'unknown error'}. Manual recreate: \`msb stop '${driftName}' && msb remove '${driftName}'\``);
  }
  return true;
}

// ---------------------------------------------------------------------------
function makePayload(sandboxName) {
  return { ...cfg, projectDir, sandboxName };
}

// ---------------------------------------------------------------------------
if (toolName === 'Bash') {
  const command = event.tool_input?.command ?? '';
  if (!sessionId || !command || !SESSION_ID_RE.test(sessionId)) process.exit(0);

  const sandbox   = sandboxNameFor(sessionId, agentType, cfg.sandboxName, cfg.scope, projectDir);
  const stateDir  = sandboxStateDir(sessionId);
  mkdirSync(stateDir, { recursive: true });
  const payload   = makePayload(sandbox);
  const { drift, failed, restarted } = await sandboxEnsureRunning(sandbox, projectDir, join(stateDir, 'sandbox.log'), payload);
  if (failed) { deny(`glovebox: failed to start sandbox (see ${stateDir}/sandbox.log)`); process.exit(0); }
  if (await handleDrift(drift, stateDir, payload)) process.exit(0);
  if (restarted) writeSandboxNotice(stateDir, 'restarted', sandbox);
  if (shouldTrack(cfg.scope, cfg.sandboxName)) sandboxTrack(sessionId, sandbox);

  const envArgs = sandboxEnvArgs(cfg.passEnv);
  const wrapped = cfg.scope === 'per-run'
    ? sandboxWrapCommandEphemeral(sandbox, command, envArgs)
    : sandboxWrapCommand(sandbox, command, envArgs);
  allow({ command: wrapped });
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (toolName === 'Read') {
  const filePath = event.tool_input?.file_path ?? '';
  if (!sessionId || !filePath || !SESSION_ID_RE.test(sessionId)) process.exit(0);

  const stateDir = sandboxStateDir(sessionId);
  mkdirSync(stateDir, { recursive: true });
  const sandbox  = sandboxNameForFileOp(sessionId, agentType, cfg.sandboxName, cfg.scope, projectDir);
  const { hostPath, needsSync } = sandboxResolvePath(filePath, projectDir, stateDir);

  if (needsSync) {
    const payload = makePayload(sandbox);
    const { drift, failed, restarted } = await sandboxEnsureRunning(sandbox, projectDir, join(stateDir, 'sandbox.log'), payload);
    if (failed) { deny(`glovebox: failed to start sandbox for read of ${filePath}`); process.exit(0); }
    if (await handleDrift(drift, stateDir, payload)) process.exit(0);
    if (restarted) writeSandboxNotice(stateDir, 'restarted', sandbox);
    if (shouldTrack(cfg.scope, cfg.sandboxName)) sandboxTrack(sessionId, sandbox);
    if (!await sandboxReadIntoShadow(sandbox, filePath, hostPath)) {
      deny(`glovebox: cannot read ${filePath} from sandbox`); process.exit(0);
    }
  }
  allowFilePath(hostPath);
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (toolName === 'Write') {
  const filePath = event.tool_input?.file_path ?? '';
  if (!sessionId || !filePath || !SESSION_ID_RE.test(sessionId)) process.exit(0);

  const stateDir = sandboxStateDir(sessionId);
  mkdirSync(stateDir, { recursive: true });
  const { hostPath, needsSync } = sandboxResolvePath(filePath, projectDir, stateDir);

  if (needsSync) {
    const sandbox = sandboxNameFor(sessionId, agentType, cfg.sandboxName, cfg.scope, projectDir);
    const payload = makePayload(sandbox);
    sandboxEnsureRunning(sandbox, projectDir, join(stateDir, 'sandbox.log'), payload);
    if (shouldTrack(cfg.scope, cfg.sandboxName)) sandboxTrack(sessionId, sandbox);
    mkdirSync(dirname(hostPath), { recursive: true });
  }
  allowFilePath(hostPath);
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (toolName === 'Edit' || toolName === 'MultiEdit') {
  // All file edits must go through the sandbox (Bash), not CC's host-side Edit.
  // Even bind-mounted project-dir files should be modified via `sed -i`, `tee`,
  // or `echo >` in Bash so every write is visible in the sandbox's filesystem view.
  const filePath = event.tool_input?.file_path ?? event.tool_input?.old_string ?? '';
  deny(`glovebox: Edit is not available inside the sandbox — use Bash to modify files instead (e.g. \`sed -i 's/old/new/g' ${filePath || 'file'}\`).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (toolName === 'WebFetch') {
  const url    = event.tool_input?.url ?? '';
  const prompt = event.tool_input?.prompt ?? '';
  const safeUrl = url.replace(/'/g, "%27");
  deny(`glovebox: WebFetch is intercepted — network requests run inside the sandbox. Use Bash with curl instead: \`curl -sSL '${safeUrl}'\`${prompt ? `. Question about the response: ${prompt}` : ''}`);
  process.exit(0);
}

process.exit(0);
