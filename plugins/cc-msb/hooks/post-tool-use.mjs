#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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

if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') process.exit(0);

const sessionId = event.session_id ?? '';
const filePath  = event.tool_input?.file_path ?? '';
if (!sessionId || !filePath) process.exit(0);

const cfg       = await resolveConfig(projectDir, agentType);
if (cfg.scope === 'host') process.exit(0);

const stateDir   = sandboxStateDir(sessionId);
const shadowRoot = join(stateDir, 'shadow');
const sandbox    = sandboxNameForFileOp(sessionId, agentType, cfg.sandboxName, cfg.scope, projectDir);

if (filePath.startsWith(shadowRoot + '/') || filePath.startsWith(shadowRoot)) {
  // Shadow fallback: file was redirected to shadow; sync shadow → sandbox
  const vmPath = filePath.slice(shadowRoot.length);
  sandboxWriteFromShadow(sandbox, filePath, vmPath);
} else if (filePath.startsWith('/') && !filePath.startsWith(projectDir + '/') && !filePath.startsWith('/workspace/')) {
  // Transparent absolute path outside project dir: sync host → sandbox
  sandboxWriteFromShadow(sandbox, filePath, filePath);
}
