// Shared helpers for the SDK-backed sandbox-create path.
//
// Two entry-point scripts use this module:
//   - scripts/create-sandbox.mjs   (initial create)
//   - scripts/recreate-sandbox.mjs (snapshot-then-recreate on drift)
//
// `applyConfig(builder, cfg)` is the single source of truth that turns
// a glovebox config payload into SDK builder calls. Replacing the backend
// later (different SDK, different runtime) means editing this function.

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadSdk } from "../../lib/sdk.mjs";
export { loadSdk };

// ---------------------------------------------------------------------------
// Fake-SDK seam for unit tests. When GLOVEBOX_FAKE_CREATE=1, we dump the
// resolved config to /tmp/fake-msb-<name>.create-args (the same path the
// old fake-msb shell stub wrote argv to) and signal the caller to skip
// the SDK call. Tests read this file and assert on its JSON fields.
// ---------------------------------------------------------------------------
export function dumpFake(cfg) {
  if (!process.env["GLOVEBOX_FAKE_CREATE"]) return false;
  const name = cfg.sandboxName;
  if (!name) return false;
  writeFileSync(`/tmp/fake-msb-${name}.create-args`, JSON.stringify(cfg, null, 2));
  writeFileSync(`/tmp/fake-msb-${name}.state`, "Running\n");
  return true;
}

// ---------------------------------------------------------------------------
// applyConfig — THE central translator. Takes a SandboxBuilder that the
// caller has already pinned to a starting point (`.image(img)` or
// `.fromSnapshot(snap)`) and applies every glovebox knob: workdir, bind
// volume, ports, network policy, TLS interception, secrets.
//
// Returns the same builder for chaining.
// ---------------------------------------------------------------------------
export function applyConfig(builder, cfg) {
  applyUser(builder, cfg);
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

function applyUser(builder, cfg) {
  if (cfg.user) {
    // Explicit config always wins.
    builder.user(cfg.user);
  } else if (cfg.projectDir && truthy(cfg.mountWorkdir)) {
    // Map to host UID so the VM kernel allows writes to the host-owned bind
    // mount. applyHostUser() then remaps the container's existing non-root
    // user to this UID so passwd/sudo stay consistent. If the host user is
    // already root (uid=0) no override is needed.
    const uid = process.getuid?.();
    if (uid != null && uid !== 0) builder.user(String(uid));
  }
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

// ---------------------------------------------------------------------------
// applyHostUser — remap the container's primary non-root user to the host UID.
// Needed when applyUser() maps the sandbox process to the host UID (e.g. 501):
// that UID has no /etc/passwd entry, so tools like sudo fail with "you do not
// exist in the passwd database". Instead of adding a new user, we remap the
// existing main user (e.g. vscode/1000) so its UID, home dir ownership, and
// sudoers entry all stay consistent. Runs once as root via execWith after
// createDetached; the change persists in the overlay across restarts.
// ---------------------------------------------------------------------------
export async function applyHostUser(SandboxClass, cfg) {
  if (cfg.user) return; // explicit user — caller owns the setup
  if (!cfg.projectDir || !truthy(cfg.mountWorkdir)) return;
  const newUid = process.getuid?.();
  if (!newUid || newUid === 0) return; // already root, nothing to remap

  try {
    const handle = await SandboxClass.get(cfg.sandboxName);
    const live = await handle.connect();
    // Use numeric "0" for the user override — more portable than "root" across
    // images where /etc/passwd may not be consulted for the exec user lookup.
    const result = await live.execWith("sh", (b) => b.args(["-c", buildRemapScript(newUid)]).user("0"));
    if (!result.success) {
      process.stderr.write(`[applyHostUser] remap exited ${result.code} for ${cfg.sandboxName}: ${result.stderr()}\n`);
    }
  } catch (e) {
    process.stderr.write(`[applyHostUser] failed for ${cfg.sandboxName}: ${e?.message ?? e}\n`);
  }
}

// Build a shell script that remaps the container's primary non-root user to
// the given UID. Finds the first passwd entry in the 500-60000 range, runs
// usermod to change its UID, then chowns any files that were owned by the old
// UID. Idempotent — exits 0 without changes if the UID is already correct.
export function buildRemapScript(newUid) {
  return `set -e
MAIN_USER=$(getent passwd | awk -F: '$3 >= 500 && $3 < 60000 { print $1; exit }')
[ -z "$MAIN_USER" ] && exit 0
OLD_UID=$(id -u "$MAIN_USER")
[ "$OLD_UID" = "${newUid}" ] && exit 0
usermod -u ${newUid} "$MAIN_USER"
find / -xdev -user "$OLD_UID" -exec chown ${newUid} {} + 2>/dev/null || true`;
}

// ---------------------------------------------------------------------------
// applyGitIdentity — run `git config --global user.name/email` inside the
// guest. Called by create-sandbox.mjs / recreate-sandbox.mjs after
// createDetached, before the process.exit(0) clean-exit bypass. Idempotent:
// re-running on every create overwrites whatever was there. Best-effort:
// silently swallowed if the guest lacks git (rare for our use cases).
// ---------------------------------------------------------------------------
export async function applyGitIdentity(SandboxClass, cfg) {
  const name = cfg.gitUserName ?? "";
  const email = cfg.gitUserEmail ?? "";
  if (!name && !email) return;
  try {
    const handle = await SandboxClass.get(cfg.sandboxName);
    const live = await handle.connect();
    const parts = [];
    if (name) parts.push(`git config --global user.name "${shellEscape(name)}"`);
    if (email) parts.push(`git config --global user.email "${shellEscape(email)}"`);
    await live.exec("sh", ["-c", parts.join(" && ")]);
  } catch {
    // No git in the image, or transient SDK hiccup — non-fatal.
  }
}

function shellEscape(s) {
  // Double-quoted shell strings only need to escape: \  $  `  "
  return String(s).replace(/[\\$`"]/g, "\\$&");
}

function applySecrets(nb, cfg) {
  const entries = (cfg.secrets || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return;

  // Group by (envVar, value) → set of allowed hosts. Required because
  // calling `secretEnvSimple(env, val, host)` multiple times with the
  // same env name overwrites the placeholder behavior on the second
  // call (the env var ends up holding the literal value, not the
  // `$MSB_<env>` placeholder). Using the SecretBuilder with
  // `.allowHost(host)` per host on a single .secret() call keeps the
  // placeholder semantics intact.
  const grouped = new Map();   // key: "ENV\0VALUE" → { envVar, value, hosts: string[] }
  for (const s of entries) {
    // ENV=VALUE@HOST  ($VAR substitution was done bash-side before piping)
    const eq = s.indexOf("=");
    const at = s.lastIndexOf("@");
    if (eq < 0 || at < 0 || at < eq) continue;
    const envVar = s.slice(0, eq);
    const value = s.slice(eq + 1, at);
    const host = s.slice(at + 1);
    const key = `${envVar}\0${value}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { envVar, value, hosts: [] };
      grouped.set(key, entry);
    }
    if (!entry.hosts.includes(host)) entry.hosts.push(host);
  }

  for (const { envVar, value, hosts } of grouped.values()) {
    nb.secret((b) => {
      b.env(envVar).value(value);
      for (const h of hosts) b.allowHost(h);
      return b;
    });
  }
  if (cfg.onSecretViolation) nb.onSecretViolation(cfg.onSecretViolation);
}
