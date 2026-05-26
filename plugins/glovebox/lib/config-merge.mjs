// Config resolution chains and merge logic for glovebox.
// Consumes parsed YAML docs from config-yaml.mjs and process.env.
//
// Resolution priority (highest → lowest):
//   env var → local YAML chain → global YAML chain → preset lookup → built-in default
//
// SCALAR: first-non-empty-wins across the chain.
// LIST_*: env var short-circuits; otherwise first-non-empty from user files,
//         then union-merged with all preset contributions.

// Each entry: { key, type, envMain, envAgent, noAgentSuffix, default }
// noAgentSuffix: agent env var has no _AGENT_TYPE suffix (only mount_workdir)
// sandboxImageSpecial: image uses GLOVEBOX_SANDBOX_IMAGE for main + special agent fallback
export const DEFAULT_SANDBOX_IMAGE = 'mcr.microsoft.com/devcontainers/base:bookworm';

const SETTINGS = [
  { key: 'sandbox_image',       type: 'SCALAR',      envMain: 'GLOVEBOX_SANDBOX_IMAGE',             envAgent: 'GLOVEBOX_AGENT_IMAGE',              sandboxImageSpecial: true, default: DEFAULT_SANDBOX_IMAGE   },
  { key: 'scope',               type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_SCOPE',                envAgent: 'GLOVEBOX_AGENT_SCOPE',              default: 'session'  },
  { key: 'sandbox_name',        type: 'SCALAR',      envMain: 'GLOVEBOX_SANDBOX_NAME',              envAgent: 'GLOVEBOX_AGENT_SANDBOX_NAME',       sandboxNameSpecial: true,  default: ''         },
  { key: 'mount_workdir',       type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_MOUNT_WORKDIR',        envAgent: 'GLOVEBOX_AGENT_MOUNT_WORKDIR',      noAgentSuffix: true,       default: 'true'     },
  { key: 'pass_env',            type: 'LIST_PASSENV',envMain: 'GLOVEBOX_MAIN_PASS_ENV',             envAgent: 'GLOVEBOX_AGENT_PASS_ENV',           default: 'none'     },
  { key: 'network',             type: 'LIST_NETWORK',envMain: 'GLOVEBOX_MAIN_NETWORK',              envAgent: 'GLOVEBOX_AGENT_NETWORK',            default: 'enabled'  },
  { key: 'ports',               type: 'LIST_CSV',    envMain: 'GLOVEBOX_MAIN_PORTS',                envAgent: 'GLOVEBOX_AGENT_PORTS',              default: ''         },
  { key: 'secrets',             type: 'LIST_CSV',    envMain: 'GLOVEBOX_MAIN_SECRETS',              envAgent: 'GLOVEBOX_AGENT_SECRETS',            default: ''         },
  { key: 'on_secret_violation', type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_ON_SECRET_VIOLATION',  envAgent: 'GLOVEBOX_AGENT_ON_SECRET_VIOLATION',default: ''         },
  { key: 'tls_intercept',       type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_TLS_INTERCEPT',        envAgent: 'GLOVEBOX_AGENT_TLS_INTERCEPT',      default: 'false'    },
  { key: 'tls_intercept_port',  type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_TLS_INTERCEPT_PORT',   envAgent: 'GLOVEBOX_AGENT_TLS_INTERCEPT_PORT', default: ''         },
  { key: 'tls_bypass',          type: 'LIST_CSV',    envMain: 'GLOVEBOX_MAIN_TLS_BYPASS',           envAgent: 'GLOVEBOX_AGENT_TLS_BYPASS',         default: ''         },
  { key: 'trust_host_cas',      type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_TRUST_HOST_CAS',       envAgent: 'GLOVEBOX_AGENT_TRUST_HOST_CAS',     default: 'false'    },
  { key: 'auto_recreate',       type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_AUTO_RECREATE',        envAgent: 'GLOVEBOX_AGENT_AUTO_RECREATE',      default: 'false'    },
  { key: 'git_user_name',       type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_GIT_USER_NAME',        envAgent: 'GLOVEBOX_AGENT_GIT_USER_NAME',      default: ''         },
  { key: 'git_user_email',      type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_GIT_USER_EMAIL',       envAgent: 'GLOVEBOX_AGENT_GIT_USER_EMAIL',     default: ''         },
  { key: 'github_token',        type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_GITHUB_TOKEN',         envAgent: 'GLOVEBOX_AGENT_GITHUB_TOKEN',       default: ''         },
  { key: 'github_hosts',        type: 'LIST_CSV',    envMain: 'GLOVEBOX_MAIN_GITHUB_HOSTS',         envAgent: 'GLOVEBOX_AGENT_GITHUB_HOSTS',       default: ''         },
  { key: 'git_user_autodetect', type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_GIT_USER_AUTODETECT',  envAgent: 'GLOVEBOX_AGENT_GIT_USER_AUTODETECT',default: 'true'     },
  { key: 'git_token_autodetect',type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT', envAgent: 'GLOVEBOX_AGENT_GIT_TOKEN_AUTODETECT',default: 'true'    },
  { key: 'user',                type: 'SCALAR',      envMain: 'GLOVEBOX_MAIN_USER',                 envAgent: 'GLOVEBOX_AGENT_USER',               default: ''         },
];

function get(doc, path, key) {
  return doc.sections[path]?.[key] || '';
}

function agentEnvName(s, agentType) {
  if (s.noAgentSuffix) return s.envAgent;
  const upper = agentType.replace(/-/g, '_').toUpperCase();
  return `${s.envAgent}_${upper}`;
}

// Ordered lookup paths for YAML chain (no env vars, no presets).
function yamlSources(s, isMain, agentType, localDoc, globalDoc) {
  if (isMain) {
    return [
      () => get(localDoc,  'main',           s.key),
      () => get(localDoc,  'defaults.main',  s.key),
      () => get(localDoc,  'defaults.agents',s.key),
      () => get(localDoc,  'defaults',       s.key),
      () => get(globalDoc, 'main',           s.key),
      () => get(globalDoc, 'defaults.main',  s.key),
      () => get(globalDoc, 'defaults.agents',s.key),
      () => get(globalDoc, 'defaults',       s.key),
    ];
  }
  return [
    () => get(localDoc,  `agents.${agentType}`, s.key),
    () => get(localDoc,  'defaults.agents',     s.key),
    () => get(localDoc,  'defaults',            s.key),
    () => get(globalDoc, `agents.${agentType}`, s.key),
    () => get(globalDoc, 'defaults.agents',     s.key),
    () => get(globalDoc, 'defaults',            s.key),
  ];
}

function firstNonEmpty(fns) {
  for (const fn of fns) { const v = fn(); if (v) return v; }
  return '';
}

// Preset scalar lookup: last-listed preset wins.
function presetScalar(s, isMain, presetDocs) {
  let winner = '';
  for (const doc of presetDocs) {
    const paths = isMain ? ['defaults.main', 'defaults.agents', 'defaults'] : ['defaults.agents', 'defaults'];
    for (const path of paths) {
      const v = get(doc, path, s.key);
      if (v) { winner = v; break; }
    }
  }
  return winner;
}

// Preset list collection: union from all presets (not first-wins).
function presetListValues(s, isMain, presetDocs) {
  const vals = [];
  for (const doc of presetDocs) {
    if (isMain) { const v = get(doc, 'defaults.main',   s.key); if (v) vals.push(v); }
    const v2 = get(doc, 'defaults.agents', s.key); if (v2) vals.push(v2);
    const v3 = get(doc, 'defaults',        s.key); if (v3) vals.push(v3);
  }
  return vals;
}

function csvUnion(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const item of part.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!seen.has(item)) { seen.add(item); out.push(item); }
    }
  }
  return out.join(',');
}

function mergeNetwork(values) {
  if (values.some(v => v === 'disabled')) return 'disabled';
  const hosts = values.filter(v => v && v !== 'enabled').join(',');
  return hosts ? csvUnion(hosts) : 'enabled';
}

function mergePassEnv(values) {
  if (values.some(v => v === 'all')) return 'all';
  const vars = values.filter(v => v && v !== 'none').join(',');
  return vars ? csvUnion(vars) : 'none';
}

function resolveScalar(s, isMain, agentType, localDoc, globalDoc, presetDocs) {
  // 1. Env var
  const envKey = isMain ? s.envMain : agentEnvName(s, agentType);
  if (process.env[envKey]) return process.env[envKey];

  // Special: image agent fallback inserts GLOVEBOX_SANDBOX_IMAGE between YAML sections
  if (s.sandboxImageSpecial && !isMain) {
    const agentVal = firstNonEmpty([
      () => get(localDoc,  `agents.${agentType}`, s.key),
      () => get(globalDoc, `agents.${agentType}`, s.key),
    ]);
    if (agentVal) return agentVal;
    if (process.env.GLOVEBOX_SANDBOX_IMAGE) return process.env.GLOVEBOX_SANDBOX_IMAGE;
    return firstNonEmpty([
      () => get(localDoc,  'defaults.agents', s.key),
      () => get(localDoc,  'defaults',        s.key),
      () => get(globalDoc, 'defaults.agents', s.key),
      () => get(globalDoc, 'defaults',        s.key),
    ]) || presetScalar(s, false, presetDocs) || s.default;
  }

  // Special: sandbox_name for agent falls back to main sandbox_name
  if (s.sandboxNameSpecial && !isMain) {
    return firstNonEmpty([
      () => get(localDoc,  `agents.${agentType}`, s.key),
      () => get(globalDoc, `agents.${agentType}`, s.key),
    ]) || process.env.GLOVEBOX_SANDBOX_NAME || '';
  }

  // 2. YAML chain
  const yamlVal = firstNonEmpty(yamlSources(s, isMain, agentType, localDoc, globalDoc));
  if (yamlVal) return yamlVal;

  // 3. Presets (last wins)
  const presetVal = presetScalar(s, isMain, presetDocs);
  return presetVal || s.default;
}

function resolveList(s, isMain, agentType, localDoc, globalDoc, presetDocs) {
  // 1. Env var short-circuits
  const envKey = isMain ? s.envMain : agentEnvName(s, agentType);
  if (process.env[envKey]) return process.env[envKey];

  // 2. First-non-empty from user files
  const userVal = firstNonEmpty(yamlSources(s, isMain, agentType, localDoc, globalDoc));

  // 3. Union with preset contributions
  const presetVals = presetListValues(s, isMain, presetDocs);
  const all = [userVal, ...presetVals].filter(Boolean);

  if (!all.length) return s.default;

  if (s.type === 'LIST_NETWORK') return mergeNetwork(all);
  if (s.type === 'LIST_PASSENV') return mergePassEnv(all);
  return csvUnion(...all) || s.default;
}

// Resolve all settings for the given context. Returns a flat object keyed by
// setting key (e.g. 'sandbox_image', 'scope', ...).
export function resolveAll(agentType, localDoc, globalDoc, presetDocs) {
  const isMain = !agentType;
  const result = {};
  for (const s of SETTINGS) {
    result[s.key] = s.type === 'SCALAR'
      ? resolveScalar(s, isMain, agentType, localDoc, globalDoc, presetDocs)
      : resolveList(s, isMain, agentType, localDoc, globalDoc, presetDocs);
  }
  return result;
}
