import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { rmSync } from "node:fs";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-test-session-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function runHook(event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
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
  // Clean up any leftover fake sandbox state
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
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
