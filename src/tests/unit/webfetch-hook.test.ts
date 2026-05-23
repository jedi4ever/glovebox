import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-webfetch-test-001";

function runHook(event: object, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [PRE_HOOK], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: PLUGIN_ROOT, // any dir; no config file there → defaults apply
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

describe("pre-tool-use.sh — WebFetch hook", () => {
  it("denies WebFetch with a hint to use Bash + curl, echoing url and prompt", () => {
    const r = runHook({
      tool_name: "WebFetch",
      session_id: SESSION_ID,
      tool_input: {
        url: "https://example.com",
        prompt: "what is on this page?",
      },
    });

    expect(r.status).toBe(0);
    const out = r.json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toMatch(/curl/i);
    expect(reason).toMatch(/Use Bash/i);
    expect(reason).toContain("https://example.com");
    expect(reason).toContain("what is on this page?");
  });

  it("URL with single-quote is percent-encoded in deny message (no shell injection)", () => {
    const r = runHook({
      tool_name: "WebFetch",
      session_id: SESSION_ID,
      tool_input: {
        url: "https://evil.com/'$(id)",
        prompt: "summarise",
      },
    });

    expect(r.status).toBe(0);
    const reason = r.json().hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).not.toContain("'$(id)");
    expect(reason).toContain("%27$(id)");
  });

  it("passes WebFetch through unmodified when scope=host (no sandbox)", () => {
    const r = runHook(
      {
        tool_name: "WebFetch",
        session_id: SESSION_ID,
        tool_input: { url: "https://example.com", prompt: "summarise" },
      },
      { CC_MSB_MAIN_SCOPE: "host" }
    );

    expect(r.status).toBe(0);
    // scope=host short-circuits at the top of the hook with `exit 0`, so no JSON emitted.
    expect(r.stdout.trim()).toBe("");
  });

  it("WebSearch is still passed through (not affected by the WebFetch interception)", () => {
    const r = runHook({
      tool_name: "WebSearch",
      session_id: SESSION_ID,
      tool_input: { query: "anything" },
    });

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
