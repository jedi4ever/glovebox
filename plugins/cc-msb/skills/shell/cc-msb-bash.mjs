#!/usr/bin/env node
// cc-msb-bash.mjs — drop-in shim for /bin/bash.
//
// When invoked as `cc-msb-bash.mjs -c <cmd>`, forwards <cmd> into the
// current Claude Code session's cc-msb MSB sandbox via `msb exec`.
// Intended use is via CLAUDE_CODE_SHELL so the input-box `!` prefix
// executes inside the same sandbox as Claude's Bash tool calls.
//
// Activate by adding to your project's .claude/settings.json:
//   { "env": { "CLAUDE_CODE_SHELL": "<absolute path to this file>" } }
import { spawnSync } from 'node:child_process';

const hostBash = process.env.CC_MSB_HOST_BASH || '/bin/bash';
const traceLog = process.env.CC_MSB_SHELL_TRACE_LOG;

if (traceLog) {
  const ts = new Date().toISOString();
  const first = process.argv[2] ?? '-';
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(traceLog, `${ts}\t${process.argv.length - 2}\t${first}\n`);
  } catch { /* ignore trace errors */ }
}

function fallback(args) {
  const r = spawnSync(hostBash, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);

// No arguments → interactive shell
if (args.length === 0) fallback([]);

// Determine command string from arguments
let cmd;
if (args[0] === '-c') {
  cmd = args[1];
  if (!cmd || cmd.startsWith('-')) fallback(args);
} else if (args[0]?.startsWith('-')) {
  // Flag like -l, -i, --version → defer
  fallback(args);
} else if (args.length === 1) {
  // Could be a script path or bare command
  try {
    const { statSync } = await import('node:fs');
    statSync(args[0]);
    fallback(args); // exists on disk → script file
  } catch {
    cmd = args[0]; // treat as command string
  }
} else {
  fallback(args);
}

// Already a cc-msb rewrite → avoid double-wrapping
if (cmd && /\| msb exec .*-- bash/.test(cmd)) fallback(['-c', cmd]);

// Find newest running cc-msb-* sandbox
const listResult = spawnSync('msb', ['list'], { encoding: 'utf8' });
let sandbox = '';
if (!listResult.error) {
  for (const line of (listResult.stdout || '').split('\n')) {
    if (/^cc-msb-/.test(line) && /running/i.test(line)) {
      sandbox = line.split(/\s+/)[0] ?? '';
      break;
    }
  }
}

if (!sandbox) fallback(['-c', cmd]);

const r = spawnSync('msb', ['exec', sandbox, '--', 'bash', '-c', cmd], {
  stdio: 'inherit',
  input: '',
});
process.exit(r.status ?? 1);
