import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.sh");

const SESSION_ID = "unit-read-test-0001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;
const PROJECT_DIR = "/tmp/cc-msb-read-test-project";
const SHADOW_ROOT = `${process.env["HOME"]}/.cache/cc-msb/${SESSION_ID}/shadow`;

function runHook(event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
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

beforeEach(() => {
  mkdirSync(PROJECT_DIR, { recursive: true });
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
  try { rmSync(PROJECT_DIR, { recursive: true }); } catch {}
});

describe("pre-tool-use.sh — Read hook", () => {
  it("rewrites a VM-only path to a shadow file populated from the sandbox", () => {
    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: { file_path: "/etc/os-release" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");

    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).toContain(SHADOW_ROOT);
    expect(rewrittenPath).toContain("os-release");

    // Shadow file must exist and contain content from the fake sandbox
    expect(existsSync(rewrittenPath)).toBe(true);
    const content = readFileSync(rewrittenPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("passes a project-dir path through without shadowing", () => {
    const projectFile = join(PROJECT_DIR, "README.md");
    writeFileSync(projectFile, "# test");

    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: { file_path: projectFile },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");

    // Path should be unchanged (or translated to same host path)
    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).toBe(projectFile);
    expect(rewrittenPath).not.toContain("shadow");
  });

  it("exits 0 silently when file_path is missing", () => {
    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: {},
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
