#!/usr/bin/env node
// Recreate a long-lived msb sandbox in place, preserving the writable
// overlay (apt installs, /etc edits, etc.) but applying new create-time
// flags (network, ports, secrets, tls). Uses the microsandbox SDK's
// `fromSnapshot()` which composes base + overlay properly — something
// the CLI's `msb create <snap-path>` can't do.
//
// Input: JSON on stdin describing the desired post-recreate config.
// Output (stdout): single-line JSON `{ "ok": true }` on success, or
//   `{ "ok": false, "error": "...", "imageChanged": true|false }` on failure.
// Exit:   0 on success, 1 on failure.
//
// Schema (matching the EFFECTIVE_* set the hook already resolves):
// {
//   "sandboxName":      "cc-msb-dir-…",
//   "image":            "ubuntu",
//   "projectDir":       "/abs/path",            // for the bind mount
//   "mountWorkdir":     true,
//   "network":          "github.com,api.example.com" | "enabled" | "disabled" | "",
//   "ports":            "8080:80,5432:5432/tcp" | "",
//   "secrets":          "ENV=value@host,…"     | "",
//   "onSecretViolation":"block" | "block-and-log" | "block-and-terminate" | "",
//   "tlsIntercept":     true|false,
//   "tlsInterceptPort": 443 | null,
//   "tlsBypass":        "*.internal.com,intra"  | "",
//   "trustHostCas":     true|false
// }

import { readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

// `microsandbox` is typically installed globally alongside the `msb` CLI.
// ESM `import "microsandbox"` from this plugin-local script can't find it
// — Node's ESM resolver doesn't honor NODE_PATH and there's no
// node_modules relative to the plugin. We locate the SDK by following
// the `msb` binary's symlink to its npm package and import that
// package's entry directly.
async function loadSdk() {
  try {
    return await import("microsandbox");
  } catch {
    let pkgDir;
    try {
      const msbBin = execSync("command -v msb", { encoding: "utf8" }).trim();
      // realpath resolves the npm bin shim → <pkg>/bin/microsandbox.cjs
      const real = realpathSync(msbBin);
      pkgDir = resolvePath(dirname(real), "..");
    } catch {
      throw new Error("microsandbox SDK not found and `msb` binary not on PATH");
    }
    const entry = pathToFileURL(`${pkgDir}/dist/index.js`).href;
    return await import(entry);
  }
}
const { Sandbox, Snapshot } = await loadSdk();

function fatal(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }) + "\n");
  process.exit(1);
}

const raw = readFileSync(0, "utf8");
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  fatal(`bad JSON on stdin: ${e.message}`);
}

const name = cfg.sandboxName;
if (!name) fatal("sandboxName is required");
const snapName = `${name}--cc-msb-pending`;

const handle = await Sandbox.get(name).catch(() => null);
if (!handle) fatal(`sandbox not found: ${name}`);

// 1. Connect (read-only), flush pending writes, and stop the sandbox
//    cleanly. The flush is critical: apk/apt run sync internally but
//    raw `echo > /etc/foo` does not, so without it the overlay can be
//    incomplete at snapshot time. `stopAndWait` blocks until the sandbox
//    has actually exited — `snapshot create` rejects running sandboxes.
try {
  const live = await handle.connect();
  try {
    await live.exec("sh", ["-c", "sync"]);
  } catch {
    // Best-effort. If the guest is too minimal for `sh`, ride on the overlay as-is.
  }
  await live.stopAndWait();
} catch {
  // Already stopped, or never came up — proceed to snapshot.
}

// 3. Snapshot the writable overlay.
let snap;
try {
  // Clean any leftover artifact from a prior aborted run.
  try { await Snapshot.remove(snapName, { force: true }); } catch {}
  snap = await handle.snapshot(snapName);
} catch (e) {
  fatal(`snapshot failed: ${e.message}`);
}

// 4. If the desired image differs from the one the snapshot pins, we
//    can't honor it via fromSnapshot — base image is fixed. Bail and
//    let the caller fall back to a full recreate (state loss accepted).
if (cfg.image && snap.imageRef && cfg.image !== snap.imageRef) {
  try { await Snapshot.remove(snapName, { force: true }); } catch {}
  process.stdout.write(JSON.stringify({
    ok: false,
    error: `image changed from ${snap.imageRef} to ${cfg.image}; snapshot pins the old image, full recreate needed`,
    imageChanged: true,
  }) + "\n");
  process.exit(1);
}

// 5. Remove the old sandbox so we can claim its name.
try {
  await handle.remove();
} catch (e) {
  // Already gone? Continue anyway.
}

// 6. Build the fresh sandbox from the snapshot, applying new flags.
const b = Sandbox.builder(name).fromSnapshot(snapName).replace();
if (cfg.mountWorkdir && cfg.projectDir) {
  b.workdir("/workspace");
  b.volume("/workspace", m => m.bind(cfg.projectDir));
}

// Ports — same comma-separated format the hook already parses.
const portsList = (cfg.ports || "").split(",").map(s => s.trim()).filter(Boolean);
for (const p of portsList) {
  // HOST:GUEST  or HOST:GUEST/proto
  const [hostGuest, proto] = p.split("/");
  const [hostStr, guestStr] = hostGuest.split(":");
  const host = Number(hostStr);
  const guest = Number(guestStr);
  if (!Number.isInteger(host) || !Number.isInteger(guest)) {
    fatal(`bad port spec: ${p}`);
  }
  if (proto === "udp") {
    b.portUdp(host, guest);
  } else {
    b.port(host, guest);
  }
}

// Network: use the policy/tls/secret builder via `.network(cb)`.
const net = cfg.network;
const tlsOn = cfg.tlsIntercept === true || cfg.tlsIntercept === "true";
const trustOn = cfg.trustHostCas === true || cfg.trustHostCas === "true";
const tlsBypass = (cfg.tlsBypass || "").split(",").map(s => s.trim()).filter(Boolean);
const secrets = (cfg.secrets || "").split(",").map(s => s.trim()).filter(Boolean);
const onViolation = cfg.onSecretViolation || "";

b.network(nb => {
  if (net === "disabled") {
    nb.enabled(false);
  } else if (net && net !== "enabled") {
    // domain1,domain2 → policy with egress allows
    const domains = net.split(",").map(s => s.trim()).filter(Boolean);
    if (domains.length > 0) {
      const policy = {
        default_egress: "deny",
        default_ingress: "allow",
        rules: domains.map(d => ({
          action: "allow",
          direction: "egress",
          destination: { domain: d },
        })),
      };
      nb.policyJson(JSON.stringify(policy));
    }
  }
  if (trustOn) nb.trustHostCas(true);
  if (tlsOn) {
    nb.tls(tb => {
      for (const dom of tlsBypass) tb.bypass(dom);
      if (cfg.tlsInterceptPort) tb.interceptedPorts([Number(cfg.tlsInterceptPort)]);
      return tb;
    });
  }
  if (secrets.length > 0) {
    for (const s of secrets) {
      // ENV=VALUE@HOST
      const eq = s.indexOf("=");
      const at = s.lastIndexOf("@");
      if (eq < 0 || at < 0 || at < eq) continue;
      const envVar = s.slice(0, eq);
      const value = s.slice(eq + 1, at);
      const host = s.slice(at + 1);
      // $VAR substitution: caller already expanded these before passing in,
      // so we just forward the literal value here.
      nb.secretEnvSimple(envVar, value, host);
    }
    if (onViolation) nb.onSecretViolation(onViolation);
  }
  return nb;
});

try {
  // createDetached so the sandbox keeps running after this script exits —
  // exactly what the hook needs.
  await b.createDetached();
} catch (e) {
  fatal(`recreate failed: ${e.message}`);
}

// 7. Snapshot served its purpose; we can drop it.
try {
  await Snapshot.remove(snapName, { force: true });
} catch {
  // Keep silent; not critical.
}

process.stdout.write(JSON.stringify({ ok: true }) + "\n");
// IMPORTANT: process.exit(0) bypasses the SDK's clean-exit hook that
// would otherwise stop our freshly-detached sandbox. We want it to
// keep running after this script exits so the next CC tool call can
// use it.
process.exit(0);
