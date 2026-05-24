#!/usr/bin/env node
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');
const { resolveConfig } = await import(join(pluginRoot, 'lib/config.mjs'));
const { sandboxNameForFileOp, sandboxStateDir, sandboxWriteFromShadow } =
  await import(join(pluginRoot, 'lib/sandbox.mjs'));

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const event      = JSON.parse(readFileSync(0, 'utf8'));
const toolName   = event.tool_name ?? '';
const agentType  = event.agent_type ?? '';
const sessionId  = event.session_id ?? '';
if (!sessionId) process.exit(0);

const stateDir    = sandboxStateDir(sessionId);
const noticePath  = join(stateDir, 'sandbox-notice.json');

if (existsSync(noticePath)) {
  let notice = {};
  try { notice = JSON.parse(readFileSync(noticePath, 'utf8')); } catch { /* ignore */ }
  rmSync(noticePath, { force: true });

  const msg = notice.type === 'recreated'
    ? `cc-msb: sandbox '${notice.sandbox}' was automatically recreated to apply updated settings. In-memory state has been reset; project files are intact.`
    : `cc-msb: sandbox '${notice.sandbox}' was restarted (it was stopped). Ephemeral in-memory state has been reset; filesystem is preserved.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
  }) + '\n');
}

if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') process.exit(0);

const filePath  = event.tool_input?.file_path ?? '';
if (!filePath) process.exit(0);

const cfg       = await resolveConfig(projectDir, agentType);
if (cfg.scope === 'host') process.exit(0);

const shadowRoot = join(stateDir, 'shadow');
const sandbox    = sandboxNameForFileOp(sessionId, agentType, cfg.sandboxName, cfg.scope, projectDir);

if (filePath.startsWith(shadowRoot + '/') || filePath.startsWith(shadowRoot)) {
  // Shadow fallback: file was redirected to shadow; sync shadow → sandbox
  const vmPath = filePath.slice(shadowRoot.length);
  await sandboxWriteFromShadow(sandbox, filePath, vmPath);
} else if (filePath.startsWith('/') && !filePath.startsWith(projectDir + '/') && !filePath.startsWith('/workspace/')) {
  // Transparent absolute path outside project dir: sync host → sandbox
  await sandboxWriteFromShadow(sandbox, filePath, filePath);
}
