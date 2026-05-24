import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-test-session-001";
const SANDBOX_NAME = `glovebox-${SESSION_ID.slice(0, 16)}`;
const STATE_DIR = join(homedir(), ".cache", "glovebox", SESSION_ID);
const NOTICE_PATH = join(STATE_DIR, "sandbox-notice.json");

function runHook(event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
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
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(NOTICE_PATH); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(NOTICE_PATH); } catch {}
});

describe("pre-tool-use.sh — passthrough tools", () => {
  it("exits 0 silently for WebSearch", () => {
    const r = runHook({ tool_name: "WebSearch", session_id: SESSION_ID, tool_input: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("denies WebFetch with a Bash+curl hint (covered in detail in webfetch-hook.test.ts)", () => {
    const r = runHook({
      tool_name: "WebFetch",
      session_id: SESSION_ID,
      tool_input: { url: "https://example.com", prompt: "summarise" },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/curl/i);
  });

  it("exits 0 silently for mcp__ tools", () => {
    const r = runHook({ tool_name: "mcp__some_tool", session_id: SESSION_ID, tool_input: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("pre-tool-use.sh — Bash sandboxing", () => {
  it("rewrites a Bash command to run in the sandbox", () => {
    const r = runHook({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hello" },
    });
    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.command).toContain(`msb exec '${SANDBOX_NAME}'`);
  });

  it("preserves the original command via base64 encoding", () => {
    const original = "cat /etc/os-release";
    const r = runHook({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: original },
    });
    const wrapped = r.json().hookSpecificOutput.updatedInput.command as string;
    // Extract base64 payload and decode it
    const match = wrapped.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1]!, "base64").toString("utf8");
    expect(decoded).toBe(original);
  });

  it("handles commands containing single quotes", () => {
    const original = "echo 'it works'";
    const r = runHook({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: original },
    });
    expect(r.status).toBe(0);
    const wrapped = r.json().hookSpecificOutput.updatedInput.command as string;
    const match = wrapped.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
    const decoded = Buffer.from(match![1]!, "base64").toString("utf8");
    expect(decoded).toBe(original);
  });

  it("exits 0 silently when session_id is missing", () => {
    const r = runHook({ tool_name: "Bash", session_id: "", tool_input: { command: "echo hi" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 0 silently when command is missing", () => {
    const r = runHook({ tool_name: "Bash", session_id: SESSION_ID, tool_input: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("pre-tool-use.sh — sandbox restart notice", () => {
  it("writes sandbox-notice.json when a stopped sandbox is restarted", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Stopped");

    const r = runHook({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    });

    expect(r.status).toBe(0);
    expect(existsSync(NOTICE_PATH)).toBe(true);
    const notice = JSON.parse(readFileSync(NOTICE_PATH, "utf8"));
    expect(notice.type).toBe("restarted");
    expect(notice.sandbox).toBe(SANDBOX_NAME);
  });

  it("does NOT write a notice when sandbox was already running", () => {
    writeFileSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`, "Running");

    runHook({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    });

    expect(existsSync(NOTICE_PATH)).toBe(false);
  });
});
