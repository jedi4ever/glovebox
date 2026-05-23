import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFileSync, readdirSync, rmSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const SHIM = join(PLUGIN_ROOT, "skills/shell/cc-msb-bash.mjs");

const RUNNING_SANDBOX = "cc-msb-shim-test-001";

function runShim(args: string[], opts: { withMsb?: boolean } = {}) {
  const withMsb = opts.withMsb !== false;
  const PATH = withMsb
    ? `${FAKE_MSB_DIR}:${process.env["PATH"]}`
    : (process.env["PATH"] ?? "");
  return spawnSync("node", [SHIM, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}

function cleanupFakeState() {
  readdirSync("/tmp")
    .filter((f) => f.startsWith("fake-msb-cc-msb-shim-test-"))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(cleanupFakeState);
afterEach(cleanupFakeState);

describe("cc-msb-bash.mjs — shell shim", () => {
  it("with NO running cc-msb sandbox: falls back to /bin/bash for -c <cmd>", () => {
    const r = runShim(["-c", "echo shim-fallback-ok"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("shim-fallback-ok");
  });

  it("with a running cc-msb sandbox: routes through msb exec", () => {
    // Mark a fake sandbox as Running. fake-msb's `exec ... -- bash -c <cmd>` will run the cmd directly.
    writeFileSync(`/tmp/fake-msb-${RUNNING_SANDBOX}.state`, "Running");
    const r = runShim(["-c", "echo via-sandbox-ok"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("via-sandbox-ok");
  });

  it("already-wrapped command (looks like the PreToolUse rewrite) is NOT double-wrapped", () => {
    writeFileSync(`/tmp/fake-msb-${RUNNING_SANDBOX}.state`, "Running");
    // Simulate what cc-msb's Bash hook produces — a string containing `| msb exec ... -- bash`.
    // The shim should detect this and pass through to real bash unchanged.
    const wrapped = "printf '%s' 'ZWNobyBkb3VibGUtd3JhcC1jaGVjaw==' | base64 -d | msb exec 'cc-msb-shim-test-001' -- bash";
    const r = runShim(["-c", wrapped]);
    expect(r.status).toBe(0);
    // The base64 decodes to `echo double-wrap-check` and real bash runs it through fake-msb once.
    expect(r.stdout.trim()).toBe("double-wrap-check");
  });

  it("zero-arg invocation defers to host bash (interactive form)", () => {
    // We can't run interactive bash in a test, but we can verify the shim doesn't try to exec msb.
    // Pass `true` (resolved via PATH) via CC_MSB_HOST_BASH so the zero-arg branch exits cleanly.
    const r = spawnSync("node", [SHIM], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`, CC_MSB_HOST_BASH: "true" },
    });
    expect(r.status).toBe(0);
  });

  it("bash flag argument (-l, --version) is forwarded to host bash unchanged", () => {
    writeFileSync(`/tmp/fake-msb-${RUNNING_SANDBOX}.state`, "Running");
    const r = runShim(["--version"]);
    expect(r.status).toBe(0);
    // /bin/bash --version prints something containing "GNU bash" or "version"
    expect(r.stdout).toMatch(/bash/i);
  });
});
