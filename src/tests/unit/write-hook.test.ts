import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");
const POST_HOOK = join(PLUGIN_ROOT, "hooks/post-tool-use.mjs");

const SESSION_ID = "unit-write-test-001";
const SANDBOX_NAME = `glovebox-${SESSION_ID.slice(0, 16)}`;
const PROJECT_DIR = "/tmp/glovebox-write-test-project";
const STATE_DIR = join(homedir(), ".cache", "glovebox", SESSION_ID);
const SHADOW_ROOT = join(STATE_DIR, "shadow");
const NOTICE_PATH = join(STATE_DIR, "sandbox-notice.json");
const EDIT_TEST_FILE = "/tmp/glovebox-edit-test.txt";

function runHook(hook: string, event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [hook], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      GLOVEBOX_FAKE_CREATE: "1",
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
  try { rmSync(NOTICE_PATH); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
  try { rmSync(PROJECT_DIR, { recursive: true }); } catch {}
  try { rmSync(EDIT_TEST_FILE); } catch {}
  try { rmSync(NOTICE_PATH); } catch {}
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
    const shadowFile = `${SHADOW_ROOT}/tmp/glovebox-write-post-test.txt`;
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
  // Empirically, CC's Edit tool checks file existence on the host BEFORE this
  // hook is invoked. For VM-only paths CC denies with "File does not exist"
  // without ever calling us. So the hook just passes through and lets CC do
  // its thing. The unit test below verifies the pass-through behavior — CC's
  // bypass is verified by the integration test in edit-sandbox.test.ts.
  it("passes through Edit on any path without rewriting tool_input", () => {
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");

    const r = runHook(PRE_HOOK, {
      tool_name: "Edit",
      session_id: SESSION_ID,
      tool_input: { file_path: EDIT_TEST_FILE, old_string: "hello", new_string: "world" },
    });

    // exit 0 with no stdout → CC proceeds with the original tool_input
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("passes through MultiEdit the same way", () => {
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");

    const r = runHook(PRE_HOOK, {
      tool_name: "MultiEdit",
      session_id: SESSION_ID,
      tool_input: {
        file_path: EDIT_TEST_FILE,
        edits: [{ old_string: "hello", new_string: "world" }],
      },
    });

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
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

describe("post-tool-use.sh — sandbox restart notice", () => {
  it("emits additionalContext and deletes the notice file when type=restarted", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(NOTICE_PATH, JSON.stringify({ type: "restarted", sandbox: SANDBOX_NAME }));

    const r = runHook(POST_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/restarted/i);
    expect(out.hookSpecificOutput.additionalContext).toContain(SANDBOX_NAME);
    expect(existsSync(NOTICE_PATH)).toBe(false);
  });

  it("emits additionalContext and deletes the notice file when type=recreated", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(NOTICE_PATH, JSON.stringify({ type: "recreated", sandbox: SANDBOX_NAME }));

    const r = runHook(POST_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/recreated/i);
    expect(existsSync(NOTICE_PATH)).toBe(false);
  });

  it("emits nothing when no notice file exists", () => {
    const r = runHook(POST_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    });

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
