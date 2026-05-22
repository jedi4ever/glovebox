import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.sh");
const POST_HOOK = join(PLUGIN_ROOT, "hooks/post-tool-use.sh");

const SESSION_ID = "unit-write-test-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;
const PROJECT_DIR = "/tmp/cc-msb-write-test-project";
const SHADOW_ROOT = `${process.env["HOME"]}/.cache/cc-msb/${SESSION_ID}/shadow`;

function runHook(hook: string, event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bash", [hook], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
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

describe("pre-tool-use.sh — Write hook", () => {
  it("rewrites a VM-only path to a shadow file path", () => {
    const r = runHook(PRE_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: "/tmp/test.txt", content: "hello" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.file_path).toContain(SHADOW_ROOT);
    expect(out.hookSpecificOutput.updatedInput.file_path).toContain("test.txt");
    // Content must be preserved unchanged
    expect(out.hookSpecificOutput.updatedInput.content).toBe("hello");
  });

  it("passes a project-dir path through without shadowing", () => {
    const r = runHook(PRE_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: join(PROJECT_DIR, "output.txt"), content: "data" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.file_path).toBe(join(PROJECT_DIR, "output.txt"));
    expect(out.hookSpecificOutput.updatedInput.file_path).not.toContain("shadow");
  });
});

describe("post-tool-use.sh — Write hook", () => {
  it("syncs a shadow file back into the sandbox after write", () => {
    // Pre-condition: sandbox is running and shadow file was written by the host
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");
    mkdirSync(join(SHADOW_ROOT, "tmp"), { recursive: true });
    const shadowFile = join(SHADOW_ROOT, "tmp/test.txt");
    writeFileSync(shadowFile, "synced content");

    const r = runHook(POST_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: shadowFile, content: "synced content" },
    });

    expect(r.status).toBe(0);
  });

  it("exits cleanly for non-shadow paths", () => {
    const r = runHook(POST_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: join(PROJECT_DIR, "output.txt"), content: "data" },
    });
    expect(r.status).toBe(0);
  });
});
