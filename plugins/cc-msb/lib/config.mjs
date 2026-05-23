#!/usr/bin/env node
// Resolves the effective cc-msb configuration for a project and agent.
// Usage: node config.mjs <project_dir> [agent_type]
// Outputs a single JSON object with all resolved settings.
//
// The JSON is ready to pass directly to scripts/create-sandbox.mjs after
// appending { projectDir } via:  jq -c --arg pd "$PROJECT_DIR" '. + {projectDir: $pd}'

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFile } from './config-yaml.mjs';
import { resolveAll } from './config-merge.mjs';

const pluginRoot = join(fileURLToPath(import.meta.url), '../..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const [,, projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd(), agentType = ''] = process.argv;

// ---------------------------------------------------------------------------
// Load YAML documents
// ---------------------------------------------------------------------------
const localFile = join(projectDir, '.cc-msb.yml');
const globalConfigDir = process.env.CC_MSB_CONFIG_DIR
  || join(process.env.HOME || '~', '.config/cc-msb');
const globalFile = join(globalConfigDir, 'config.yml');

const localDoc  = parseFile(localFile);
const globalDoc = parseFile(globalFile);

// ---------------------------------------------------------------------------
// Resolve preset files
// ---------------------------------------------------------------------------
const presetNames = (() => {
  if (process.env.CC_MSB_PRESETS) {
    return process.env.CC_MSB_PRESETS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (localDoc.presets.length)  return localDoc.presets;
  if (globalDoc.presets.length) return globalDoc.presets;
  return [];
})();

const userPresetsDir    = process.env.CC_MSB_PRESETS_DIR || join(process.env.HOME || '~', '.cc-msb/presets');
const builtinPresetsDir = join(pluginRoot, 'presets');

const presetDocs = presetNames.map(name => {
  for (const dir of [userPresetsDir, builtinPresetsDir]) {
    for (const ext of ['.yml', '.yaml']) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return parseFile(p);
    }
  }
  return { presets: [], sections: {} };
});

// ---------------------------------------------------------------------------
// Resolve all settings
// ---------------------------------------------------------------------------
const cfg = resolveAll(agentType, localDoc, globalDoc, presetDocs);

// ---------------------------------------------------------------------------
// Git / GitHub autodetect
// ---------------------------------------------------------------------------
function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

if (!cfg.git_user_name && cfg.git_user_autodetect === 'true') {
  cfg.git_user_name = run('git config --global --get user.name');
}
if (!cfg.git_user_email && cfg.git_user_autodetect === 'true') {
  cfg.git_user_email = run('git config --global --get user.email');
}
if (!cfg.github_token && cfg.git_token_autodetect === 'true') {
  cfg.github_token = run('gh auth token');
}

// ---------------------------------------------------------------------------
// Resolve $VAR references in secrets spec
// ---------------------------------------------------------------------------
function resolveSecrets(spec) {
  if (!spec) return '';
  return spec.split(',')
    .map(entry => {
      entry = entry.trim();
      if (!entry) return null;
      const atIdx = entry.lastIndexOf('@');
      const eqIdx = entry.indexOf('=');
      if (atIdx === -1 || eqIdx === -1 || eqIdx > atIdx) return null;
      const envName = entry.slice(0, eqIdx);
      const value   = entry.slice(eqIdx + 1, atIdx);
      const host    = entry.slice(atIdx + 1);
      if (value.startsWith('$')) {
        const resolved = process.env[value.slice(1)];
        if (!resolved) return null;
        return `${envName}=${resolved}@${host}`;
      }
      return entry;
    })
    .filter(Boolean)
    .join(',');
}

cfg.secrets = resolveSecrets(cfg.secrets);

// ---------------------------------------------------------------------------
// GitHub token expansion → secrets + network + force TLS
// ---------------------------------------------------------------------------
function githubDefaultHosts() {
  return 'github.com,api.github.com,codeload.github.com,objects.githubusercontent.com,raw.githubusercontent.com';
}

function unionHosts(existing, newHosts) {
  if (!existing || existing === 'enabled') return newHosts;
  if (existing === 'disabled') return 'disabled';
  const seen = new Set(existing.split(',').map(h => h.trim()));
  newHosts.split(',').forEach(h => { const t = h.trim(); if (t) seen.add(t); });
  return [...seen].join(',');
}

if (cfg.github_token) {
  let resolved = cfg.github_token;
  if (resolved.startsWith('$')) {
    resolved = process.env[resolved.slice(1)] || '';
  }
  if (resolved) {
    const hosts = cfg.github_hosts || githubDefaultHosts();
    const entries = hosts.split(',')
      .map(h => h.trim())
      .filter(Boolean)
      .map(h => `GH_TOKEN=${resolved}@${h}`);
    cfg.secrets = cfg.secrets ? `${cfg.secrets},${entries.join(',')}` : entries.join(',');
    cfg.tls_intercept = 'true';
    cfg.network = unionHosts(cfg.network, hosts);
  }
}

// ---------------------------------------------------------------------------
// Emit JSON
// ---------------------------------------------------------------------------
const out = {
  sandboxName:       cfg.sandbox_name,
  image:             cfg.sandbox_image,
  mountWorkdir:      cfg.mount_workdir      === 'true',
  scope:             cfg.scope,
  passEnv:           cfg.pass_env,
  network:           cfg.network,
  ports:             cfg.ports,
  secrets:           cfg.secrets,
  onSecretViolation: cfg.on_secret_violation,
  tlsIntercept:      cfg.tls_intercept      === 'true',
  tlsInterceptPort:  cfg.tls_intercept_port ? Number(cfg.tls_intercept_port) : null,
  tlsBypass:         cfg.tls_bypass,
  trustHostCas:      cfg.trust_host_cas     === 'true',
  autoRecreate:      cfg.auto_recreate      === 'true',
  gitUserName:       cfg.git_user_name,
  gitUserEmail:      cfg.git_user_email,
};

process.stdout.write(JSON.stringify(out) + '\n');
