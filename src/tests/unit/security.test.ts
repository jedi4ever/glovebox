import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-sec-test-00001";
const PROJECT_DIR = "/tmp/glovebox-sec-test-project";
const SHADOW_ROOT = `${process.env["HOME"]}/.cache/glovebox/${SESSION_ID}/shadow`;

function runHook(event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [PRE_HOOK], {
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
  const sandboxName = `glovebox-${SESSION_ID.slice(0, 16)}`;
  try { rmSync(`/tmp/fake-msb-${sandboxName}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
});

afterEach(() => {
  const sandboxName = `glovebox-${SESSION_ID.slice(0, 16)}`;
  try { rmSync(`/tmp/fake-msb-${sandboxName}.state`); } catch {}
  try { rmSync(SHADOW_ROOT, { recursive: true }); } catch {}
  try { rmSync(PROJECT_DIR, { recursive: true }); } catch {}
});

describe("path traversal prevention", () => {
  it("Read: traversal path does not bypass to host — goes to shadow instead", () => {
    // /tmp/glovebox-sec-test-project/../../etc/passwd normalizes to /etc/passwd
    const traversal = `${PROJECT_DIR}/../../etc/passwd`;
    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: { file_path: traversal },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    // Must NOT be the original traversal path (which would read host /etc/passwd)
    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).not.toBe(traversal);
    // Must redirect to shadow, not expose host path
    expect(rewrittenPath).toContain(SHADOW_ROOT);
    expect(rewrittenPath).not.toContain("..");
  });

  it("Read: deep traversal escaping project dir goes to shadow", () => {
    const traversal = `${PROJECT_DIR}/../../../tmp/secret`;
    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: { file_path: traversal },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).toContain(SHADOW_ROOT);
    expect(rewrittenPath).not.toContain("..");
  });

  it("Read: legitimate project-dir path still passes through (no regression)", () => {
    const projectFile = join(PROJECT_DIR, "src/index.ts");
    mkdirSync(join(PROJECT_DIR, "src"), { recursive: true });
    writeFileSync(projectFile, "// code");

    const r = runHook({
      tool_name: "Read",
      session_id: SESSION_ID,
      tool_input: { file_path: projectFile },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.file_path).toBe(projectFile);
    expect(out.hookSpecificOutput.updatedInput.file_path).not.toContain("shadow");
  });

  it("Write: traversal path redirects to shadow, not host", () => {
    const traversal = `${PROJECT_DIR}/../../etc/cron.d/evil`;
    const r = runHook({
      tool_name: "Write",
      session_id: SESSION_ID,
      tool_input: { file_path: traversal, content: "bad" },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    const rewrittenPath = out.hookSpecificOutput.updatedInput.file_path as string;
    expect(rewrittenPath).toContain(SHADOW_ROOT);
    expect(rewrittenPath).not.toContain("..");
  });
});

describe("session ID validation", () => {
  it("Read: exits silently for session_id with path traversal chars", () => {
    const r = runHook({
      tool_name: "Read",
      session_id: "../../etc/shadow",
      tool_input: { file_path: "/etc/os-release" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("Bash: exits silently for session_id with shell metacharacters", () => {
    const r = runHook({
      tool_name: "Bash",
      session_id: "id; rm -rf /",
      tool_input: { command: "echo hello" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("Write: exits silently for session_id with path traversal chars", () => {
    const r = runHook({
      tool_name: "Write",
      session_id: "../escape",
      tool_input: { file_path: "/tmp/test.txt", content: "x" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("Read: accepts valid UUID-style session_id", () => {
    const r = runHook({
      tool_name: "Read",
      session_id: "abc123-def456-0001",
      tool_input: { file_path: "/etc/os-release" },
    });
    expect(r.status).toBe(0);
    // Should produce output (either allow or deny, not silent)
    expect(r.stdout.trim()).not.toBe("");
  });
});
