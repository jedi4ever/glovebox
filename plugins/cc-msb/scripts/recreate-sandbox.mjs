#!/usr/bin/env node
// Recreate a long-lived msb sandbox in place, preserving the writable
// overlay (apt installs, /etc edits, etc.) but applying new create-time
// flags (network, ports, secrets, tls). Uses the SDK's `fromSnapshot()`
// to compose base + overlay properly — the CLI's `msb create <snap-path>`
// can't do this.
//
// Input/output schema is identical to scripts/create-sandbox.mjs, except
// the response can also signal `imageChanged: true` when the desired
// image differs from the snapshot's pinned base image (the caller falls
// back to a regular drift deny in that case — image swaps require a
// full recreate with state loss).

import { readFileSync } from "node:fs";
import { applyConfig, applyGitIdentity, dumpFake, loadSdk } from "./lib/sandbox-build.mjs";

function fatal(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }) + "\n");
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  fatal(`bad JSON on stdin: ${e.message}`);
}
if (!cfg.sandboxName) fatal("sandboxName is required");

// Unit-test seam: dump and bail before any SDK work.
if (dumpFake(cfg)) {
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
  process.exit(0);
}

const { Sandbox, Snapshot } = await loadSdk();
const name = cfg.sandboxName;
const snapName = `${name}--cc-msb-pending`;

const handle = await Sandbox.get(name).catch(() => null);
if (!handle) fatal(`sandbox not found: ${name}`);

// 1. Flush pending writes, then stop cleanly. `stopAndWait` blocks until
//    the sandbox has actually exited — `snapshot create` rejects running
//    sandboxes. The `sync` is critical: apk/apt run sync internally but
//    raw `echo > /etc/foo` does not, so without it the overlay can miss
//    in-flight writes at snapshot time.
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

// 2. Snapshot the writable overlay.
let snap;
try {
  try { await Snapshot.remove(snapName, { force: true }); } catch {}
  snap = await handle.snapshot(snapName);
} catch (e) {
  fatal(`snapshot failed: ${e.message}`);
}

// 3. Image change → snapshot can't honor it (base image+digest are pinned).
//    Caller falls back to a full-recreate prompt.
if (cfg.image && snap.imageRef && cfg.image !== snap.imageRef) {
  try { await Snapshot.remove(snapName, { force: true }); } catch {}
  fatal(
    `image changed from ${snap.imageRef} to ${cfg.image}; snapshot pins the old image, full recreate needed`,
    { imageChanged: true }
  );
}

// 4. Remove the old sandbox so we can claim its name.
try {
  await handle.remove();
} catch {
  // Already gone? Continue.
}

// 5. Build the fresh sandbox from the snapshot, applying the new flags
//    via the centralized translator.
const builder = Sandbox.builder(name).fromSnapshot(snapName).replace();
try {
  applyConfig(builder, cfg);
} catch (e) {
  fatal(`config error: ${e.message}`);
}

try {
  await builder.createDetached();
} catch (e) {
  fatal(`recreate failed: ${e.message}`);
}

// Apply git identity inside the freshly-restored sandbox (best-effort).
await applyGitIdentity(Sandbox, cfg);

// 6. Snapshot served its purpose; drop it.
try {
  await Snapshot.remove(snapName, { force: true });
} catch {
  // Non-critical.
}

process.stdout.write(JSON.stringify({ ok: true }) + "\n");
// IMPORTANT: process.exit(0) bypasses the SDK's clean-exit hook that
// would otherwise stop our freshly-detached sandbox.
process.exit(0);
