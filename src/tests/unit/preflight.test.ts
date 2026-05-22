import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const PREFLIGHT = join(PLUGIN_ROOT, "scripts/preflight.sh");

function runPreflight(extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [PREFLIGHT], {
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

describe("preflight.sh — SessionStart hook", () => {
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
});
