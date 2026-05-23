// Shared helpers for the SDK-backed sandbox-create path.
//
// Two entry-point scripts use this module:
//   - scripts/create-sandbox.mjs   (initial create)
//   - scripts/recreate-sandbox.mjs (snapshot-then-recreate on drift)
//
// `applyConfig(builder, cfg)` is the single source of truth that turns
// a cc-msb config payload into SDK builder calls. Replacing the backend
// later (different SDK, different runtime) means editing this function.

import { realpathSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// SDK locator. `microsandbox` is typically installed globally alongside the
// `msb` CLI. ESM `import "microsandbox"` from a plugin-local script can't
// find it — Node's ESM resolver doesn't honor NODE_PATH and there's no
// node_modules relative to the plugin. We resolve via the `msb` binary's
// realpath (npm/fnm/nvm-agnostic).
// ---------------------------------------------------------------------------
export async function loadSdk() {
  try {
    return await import("microsandbox");
  } catch {
    let pkgDir;
    try {
      const msbBin = execSync("command -v msb", { encoding: "utf8" }).trim();
      const real = realpathSync(msbBin);
      pkgDir = resolvePath(dirname(real), "..");
    } catch {
      throw new Error("microsandbox SDK not found and `msb` binary not on PATH");
    }
    return await import(pathToFileURL(`${pkgDir}/dist/index.js`).href);
  }
}

// ---------------------------------------------------------------------------
// Fake-SDK seam for unit tests. When CC_MSB_FAKE_CREATE=1, we dump the
// resolved config to /tmp/fake-msb-<name>.create-args (the same path the
// old fake-msb shell stub wrote argv to) and signal the caller to skip
// the SDK call. Tests read this file and assert on its JSON fields.
// ---------------------------------------------------------------------------
export function dumpFake(cfg) {
  if (!process.env["CC_MSB_FAKE_CREATE"]) return false;
  const name = cfg.sandboxName;
  if (!name) return false;
  writeFileSync(`/tmp/fake-msb-${name}.create-args`, JSON.stringify(cfg, null, 2));
  writeFileSync(`/tmp/fake-msb-${name}.state`, "Running\n");
  return true;
}

// ---------------------------------------------------------------------------
// applyConfig — THE central translator. Takes a SandboxBuilder that the
// caller has already pinned to a starting point (`.image(img)` or
// `.fromSnapshot(snap)`) and applies every cc-msb knob: workdir, bind
// volume, ports, network policy, TLS interception, secrets.
//
// Returns the same builder for chaining.
// ---------------------------------------------------------------------------
export function applyConfig(builder, cfg) {
  applyMount(builder, cfg);
  builder.network((nb) => {
    // Ports must be set on the NetworkBuilder, not the SandboxBuilder:
    // the SDK exposes `port()` on both but only the network-builder one
    // actually binds the host port. Verified empirically.
    applyPorts(nb, cfg.ports);
    applyNetwork(nb, cfg.network);
    // Note the casing: the SDK exposes `trustHostCAs` (capital CA), not
    // `trustHostCas`. Matches `--trust-host-cas` on the CLI but spelled
    // CAs in the JS API because it's a plural acronym.
    if (truthy(cfg.trustHostCas)) nb.trustHostCAs(true);
    if (truthy(cfg.tlsIntercept)) applyTls(nb, cfg);
    applySecrets(nb, cfg);
    return nb;
  });
  return builder;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function truthy(v) {
  return v === true || v === "true";
}

function applyMount(builder, cfg) {
  if (!cfg.projectDir) return;
  if (!truthy(cfg.mountWorkdir)) return;
  builder.workdir("/workspace");
  builder.volume("/workspace", (m) => m.bind(cfg.projectDir));
}

function applyPorts(builder, ports) {
  const list = (ports || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    // Format: HOST:GUEST  or  HOST:GUEST/proto
    const [hostGuest, proto] = entry.split("/");
    const [hStr, gStr] = (hostGuest || "").split(":");
    const host = Number(hStr);
    const guest = Number(gStr);
    if (!Number.isInteger(host) || !Number.isInteger(guest)) {
      throw new Error(`bad port spec: ${entry}`);
    }
    if (proto === "udp") {
      builder.portUdp(host, guest);
    } else {
      builder.port(host, guest);
    }
  }
}

function applyNetwork(nb, network) {
  if (network === "disabled") {
    nb.enabled(false);
    return;
  }
  if (!network || network === "enabled") return;
  const domains = network.split(",").map((s) => s.trim()).filter(Boolean);
  if (domains.length === 0) return;
  // Default-deny egress to public, default-allow ingress, and explicitly
  // allow each listed domain. Mirrors the `--net-rule allow@<domain>`
  // policy msb creates from the CLI flag.
  const policy = {
    default_egress: "deny",
    default_ingress: "allow",
    rules: domains.map((d) => ({
      action: "allow",
      direction: "egress",
      destination: { domain: d },
    })),
  };
  nb.policyJson(JSON.stringify(policy));
}

function applyTls(nb, cfg) {
  const bypass = (cfg.tlsBypass || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  nb.tls((tb) => {
    for (const dom of bypass) tb.bypass(dom);
    if (cfg.tlsInterceptPort) tb.interceptedPorts([Number(cfg.tlsInterceptPort)]);
    return tb;
  });
}

function applySecrets(nb, cfg) {
  const entries = (cfg.secrets || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return;
  for (const s of entries) {
    // ENV=VALUE@HOST  ($VAR substitution was done bash-side before piping)
    const eq = s.indexOf("=");
    const at = s.lastIndexOf("@");
    if (eq < 0 || at < 0 || at < eq) continue;
    const envVar = s.slice(0, eq);
    const value = s.slice(eq + 1, at);
    const host = s.slice(at + 1);
    nb.secretEnvSimple(envVar, value, host);
  }
  if (cfg.onSecretViolation) nb.onSecretViolation(cfg.onSecretViolation);
}
