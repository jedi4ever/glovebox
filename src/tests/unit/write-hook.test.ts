import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.sh");
const POST_HOOK = join(PLUGIN_ROOT, "hooks/post-tool-use.sh");

const SESSION_ID = "unit-write-test-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;
const PROJECT_DIR = "/tmp/cc-msb-write-test-project";
const SHADOW_ROOT = `${process.env["HOME"]}/.cache/cc-msb/${SESSION_ID}/shadow`;
const EDIT_TEST_FILE = "/tmp/cc-msb-edit-test.txt";

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
  try { rmSync(EDIT_TEST_FILE); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
  try { rmSync(PROJECT_DIR, { recursive: true }); } catch {}
  try { rmSync(EDIT_TEST_FILE); } catch {}
});

describe("pre-tool-use.sh — Write hook", () => {
  it("redirects VM-only Write to the shadow path", () => {
    const r = runHook(PRE_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: "/tmp/test.txt", content: "hello" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    // Must redirect to shadow so Claude's Write tool can reach it
    expect(out.hookSpecificOutput.updatedInput.file_path).toContain("shadow");
    expect(out.hookSpecificOutput.updatedInput.file_path).toContain("/tmp/test.txt");
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
  it("syncs a shadow-written file into the sandbox", () => {
    const shadowFile = `${SHADOW_ROOT}/tmp/cc-msb-write-post-test.txt`;
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");
    mkdirSync(`${SHADOW_ROOT}/tmp`, { recursive: true });
    writeFileSync(shadowFile, "synced content");

    const r = runHook(POST_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: shadowFile, content: "synced content" },
    });

    expect(r.status).toBe(0);
  });

  it("exits cleanly for project-dir paths (no sandbox sync needed)", () => {
    const r = runHook(POST_HOOK, {
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: join(PROJECT_DIR, "output.txt"), content: "data" },
    });
    expect(r.status).toBe(0);
  });
});

describe("pre-tool-use.sh — Edit hook", () => {
  it("syncs VM-only file from sandbox and allows Edit at the original host path", () => {
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");

    const r = runHook(PRE_HOOK, {
      tool_name: "Edit",
      session_id: SESSION_ID,
      tool_input: { file_path: EDIT_TEST_FILE, old_string: "hello", new_string: "hello\nworld" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    // Edit syncs to the original host path so Claude's Edit tool operates transparently.
    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).toBe(EDIT_TEST_FILE);
    expect(rewrittenPath).not.toContain("shadow");
    // The file must exist at the host path (synced from fake sandbox)
    expect(existsSync(EDIT_TEST_FILE)).toBe(true);
  });

  it("passes a project-dir path through without shadow for Edit", () => {
    const projectFile = join(PROJECT_DIR, "src.ts");
    writeFileSync(projectFile, "const x = 1;");

    const r = runHook(PRE_HOOK, {
      tool_name: "Edit",
      session_id: SESSION_ID,
      tool_input: { file_path: projectFile, old_string: "x", new_string: "y" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.file_path).toBe(projectFile);
    expect(out.hookSpecificOutput.updatedInput.file_path).not.toContain("shadow");
  });
});

describe("post-tool-use.sh — Edit hook", () => {
  it("syncs a file edited at the original host path back into the sandbox", () => {
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");
    writeFileSync(EDIT_TEST_FILE, "hello\nworld");

    const r = runHook(POST_HOOK, {
      tool_name: "Edit",
      session_id: SESSION_ID,
      tool_input: { file_path: EDIT_TEST_FILE, old_string: "hello", new_string: "hello\nworld" },
    });

    expect(r.status).toBe(0);
  });

  it("exits cleanly for project-dir Edit (no sandbox sync needed)", () => {
    const r = runHook(POST_HOOK, {
      tool_name: "Edit",
      session_id: SESSION_ID,
      tool_input: { file_path: join(PROJECT_DIR, "src.ts"), old_string: "x", new_string: "y" },
    });
    expect(r.status).toBe(0);
  });
});
