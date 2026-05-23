import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readdirSync, rmSync } from "node:fs";
import { fixturePath } from "../../helpers/fixtures.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const HOOK = join(PLUGIN_ROOT, "scripts/session-start.sh");

const SESSION_ID = "unit-session-start-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function runHook(projectDir: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: SESSION_ID }),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      CC_MSB_FAKE_CREATE: "1",
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
    json: () => JSON.parse(result.stdout),
  };
}

function cleanupFakeMsb() {
  readdirSync("/tmp")
    .filter((f) => f.startsWith("fake-msb-cc-msb-unit-session-start") || f === `fake-msb-${SANDBOX_NAME}.state` || f === `fake-msb-${SANDBOX_NAME}.create-args`)
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(cleanupFakeMsb);
afterEach(cleanupFakeMsb);

describe("session-start.sh — SessionStart hook", () => {
  it("emits an additionalContext block describing the sandbox environment", () => {
    const r = runHook(fixturePath("simple-read"));
    expect(r.status).toBe(0);
    const ctx = r.json().hookSpecificOutput.additionalContext as string;
    expect(r.json().hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(ctx).toMatch(/sandbox environment/i);
    expect(ctx).toMatch(/OVERRIDES host/i);
    expect(ctx).toMatch(/Sandbox name: cc-msb-unit-session-st/);
    expect(ctx).toMatch(/Scope: session/);
    // New fields that override the host's identity-leaking values.
    expect(ctx).toMatch(/User:/);
    expect(ctx).toMatch(/Home directory:/);
    expect(ctx).toMatch(/Working directory:/);
    // Explicit instruction to ignore host-side paths.
    expect(ctx).toMatch(/\/Users\/\*/);
  });

  it("scope=host: emits a 'tools run on host' note, does not create a sandbox", () => {
    const r = runHook(fixturePath("config-scope-host-main"));
    expect(r.status).toBe(0);
    const ctx = r.json().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/main scope is .host/i);
    // No sandbox should have been created.
    const created = readdirSync("/tmp").filter((f) => f.startsWith("fake-msb-cc-msb-unit-session-start"));
    expect(created).toHaveLength(0);
  });

  it("exits silently when session_id is missing", () => {
    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({}),
      encoding: "utf8",
      env: { ...process.env, PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: fixturePath("simple-read") },
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "").trim()).toBe("");
  });
});
