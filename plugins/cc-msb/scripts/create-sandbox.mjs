#!/usr/bin/env node
// Create a fresh msb sandbox from the canonical cc-msb JSON payload.
// Single source of truth for "translate cc-msb config → sandbox create" —
// see scripts/lib/sandbox-build.mjs::applyConfig.
//
// Input: JSON on stdin (same schema as recreate-sandbox.mjs):
//   { sandboxName, image, projectDir, mountWorkdir, network, ports,
//     secrets, onSecretViolation, tlsIntercept, tlsInterceptPort,
//     tlsBypass, trustHostCas }
//
// Output (stdout):
//   { "ok": true }                                     on success
//   { "ok": false, "error": "<msg>" }                  on failure
// Exit: 0 / 1 respectively.

import { readFileSync } from "node:fs";
import { applyConfig, applyGitIdentity, dumpFake, loadSdk } from "./lib/sandbox-build.mjs";

function fatal(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  fatal(`bad JSON on stdin: ${e.message}`);
}
if (!cfg.sandboxName) fatal("sandboxName is required");
if (!cfg.image) fatal("image is required");

// Unit-test seam: dump the payload, skip the SDK call.
if (dumpFake(cfg)) {
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
  process.exit(0);
}

const { Sandbox } = await loadSdk();
const builder = Sandbox.builder(cfg.sandboxName).image(cfg.image).replace();
try {
  applyConfig(builder, cfg);
} catch (e) {
  fatal(`config error: ${e.message}`);
}

try {
  // createDetached so the sandbox keeps running after we exit. The
  // process.exit(0) below bypasses the SDK's clean-exit hook that would
  // otherwise stop it.
  await builder.createDetached();
} catch (e) {
  fatal(`create failed: ${e.message}`);
}

// Apply git identity inside the sandbox (best-effort).
await applyGitIdentity(Sandbox, cfg);

process.stdout.write(JSON.stringify({ ok: true }) + "\n");
process.exit(0);
