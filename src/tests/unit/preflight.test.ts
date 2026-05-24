import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_BUN_DIR    = fileURLToPath(new URL("../fixtures/fake-bun", import.meta.url));
const FAKE_NO_BUN_DIR = fileURLToPath(new URL("../fixtures/fake-no-bun", import.meta.url));
const PREFLIGHT = join(PLUGIN_ROOT, "scripts/preflight.mjs");

function runPreflight(extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [PREFLIGHT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
    json: () => JSON.parse(result.stdout),
  };
}

describe("preflight.mjs — SessionStart hook", () => {
  it("emits the Edit-not-available and WebFetch-intercepted hints when all required tools are present", () => {
    const r = runPreflight();
    expect(r.status).toBe(0);
    const ctx = r.json().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/sandbox is active/i);
    expect(ctx).toMatch(/edit is not available/i);
    expect(ctx).toMatch(/webfetch is also intercepted/i);
    expect(ctx).toMatch(/use bash/i);
    expect(ctx).toMatch(/curl/i);
  });

  it("reports node= in versions when bun is not available", () => {
    // fake-no-bun/bun shadows any real bun installation and exits with code 1
    const r = runPreflight({ PATH: `${FAKE_NO_BUN_DIR}:${process.env["PATH"]}` });
    expect(r.status).toBe(0);
    const ctx = r.json().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/node=/i);
    expect(ctx).not.toMatch(/bun=/i);
  });

  it("reports bun= in versions when bun is available on PATH", () => {
    const r = runPreflight({ PATH: `${FAKE_BUN_DIR}:${process.env["PATH"]}` });
    expect(r.status).toBe(0);
    const ctx = r.json().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/bun=/i);
    expect(ctx).not.toMatch(/node=/i);
  });
});
