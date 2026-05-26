// Unit tests for plugins/glovebox/lib/sandbox.mjs pure functions.
// These don't spawn subprocesses — they call the JS functions directly.

import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";

const SANDBOX_MJS = fileURLToPath(
  new URL("../../../plugins/glovebox/lib/sandbox.mjs", import.meta.url)
);

const {
  sandboxNameFor,
  sandboxNameForFileOp,
  sandboxPrefix,
  sandboxEnvArgs,
  sandboxWrapCommand,
  sandboxWrapCommandEphemeral,
  sandboxConfigFingerprint,
  sandboxResolvePath,
} = await import(SANDBOX_MJS);

// ---------------------------------------------------------------------------
describe("sandboxPrefix — GLOVEBOX_SANDBOX_PREFIX env var", () => {
  afterEach(() => { delete process.env["GLOVEBOX_SANDBOX_PREFIX"]; });

  it("defaults to 'glovebox' when env var is unset", () => {
    expect(sandboxPrefix()).toBe("glovebox");
  });

  it("returns the env var value when set", () => {
    process.env["GLOVEBOX_SANDBOX_PREFIX"] = "glovebox-test";
    expect(sandboxPrefix()).toBe("glovebox-test");
  });

  it("sandboxNameFor uses the prefix for session scope", () => {
    process.env["GLOVEBOX_SANDBOX_PREFIX"] = "glovebox-test";
    expect(sandboxNameFor("abc123", "", "", "session")).toBe("glovebox-test-abc123");
  });

  it("sandboxNameFor uses the prefix for directory scope", () => {
    process.env["GLOVEBOX_SANDBOX_PREFIX"] = "glovebox-test";
    const name = sandboxNameFor("sid", "", "", "directory", "/home/user/project");
    expect(name).toMatch(/^glovebox-test-dir-[0-9a-f]{12}$/);
  });

  it("named scope with explicit name ignores the prefix (caller owns the name)", () => {
    process.env["GLOVEBOX_SANDBOX_PREFIX"] = "glovebox-test";
    expect(sandboxNameFor("abc", "agent", "my-box", "named")).toBe("my-box");
  });
});

// ---------------------------------------------------------------------------
describe("sandboxNameFor — scope variants", () => {
  it("session scope uses first 16 chars of session_id", () => {
    expect(sandboxNameFor("abc123", "", "", "session")).toBe("glovebox-abc123");
    expect(sandboxNameFor("averylongsessionidentifier", "", "", "session"))
      .toBe("glovebox-averylongsession");
  });

  it("session scope: no agent_type → same as main sandbox", () => {
    expect(sandboxNameFor("abc123", "", "", "session")).toBe("glovebox-abc123");
  });

  it("session scope with agent_type still uses main sandbox", () => {
    expect(sandboxNameFor("abc123", "my-agent", "", "session")).toBe("glovebox-abc123");
  });

  it("per-agent scope uses 8+8 pattern", () => {
    const name = sandboxNameFor("abcdefgh", "test-agent", "", "per-agent");
    expect(name).toBe("glovebox-abcdefgh-test_age");
  });

  it("per-run scope produces random 8-hex suffix", () => {
    const a = sandboxNameFor("abcdefgh", "my-agent", "", "per-run");
    const b = sandboxNameFor("abcdefgh", "my-agent", "", "per-run");
    expect(a).toMatch(/^glovebox-abcdefgh-[0-9a-f]{8}$/);
    expect(b).toMatch(/^glovebox-abcdefgh-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it("per-run scope with no agent falls back to session-style", () => {
    expect(sandboxNameFor("abc123", "", "", "per-run")).toBe("glovebox-abc123");
  });

  it("named scope with explicit name uses it (stripped)", () => {
    expect(sandboxNameFor("abc", "agent", "my-box", "named")).toBe("my-box");
  });

  it("named scope strips dangerous chars from explicit name", () => {
    expect(sandboxNameFor("abc", "", "my'; evil", "named")).toBe("myevil");
  });

  it("named scope with empty explicit name falls back to session sandbox", () => {
    expect(sandboxNameFor("abc123", "", "", "named")).toBe("glovebox-abc123");
  });

  it("directory scope produces stable hash-based name", () => {
    const a = sandboxNameFor("sid1", "", "", "directory", "/home/user/project");
    const b = sandboxNameFor("sid2", "", "", "directory", "/home/user/project");
    expect(a).toBe(b);
    expect(a).toMatch(/^glovebox-dir-[0-9a-f]{12}$/);
  });

  it("directory scope differs for different project dirs", () => {
    const a = sandboxNameFor("sid", "", "", "directory", "/projects/alpha");
    const b = sandboxNameFor("sid", "", "", "directory", "/projects/beta");
    expect(a).not.toBe(b);
  });

  it("strips unsafe chars from agent_type", () => {
    const name = sandboxNameFor("abcdefgh", "evil'; inject", "", "per-agent");
    expect(name).not.toContain("'");
    expect(name).not.toContain(";");
  });
});

// ---------------------------------------------------------------------------
describe("sandboxNameForFileOp — per-run coercion", () => {
  it("per-run with agent → per-agent style (stable)", () => {
    const a = sandboxNameForFileOp("abcdefgh", "my-agent", "", "per-run");
    const b = sandboxNameForFileOp("abcdefgh", "my-agent", "", "per-run");
    expect(a).toBe(b);
    expect(a).toBe("glovebox-abcdefgh-my_agent");
  });

  it("per-run without agent → session style", () => {
    expect(sandboxNameForFileOp("abcdefgh12345678", "", "", "per-run")).toBe("glovebox-abcdefgh12345678");
  });

  it("non-per-run delegates to sandboxNameFor", () => {
    expect(sandboxNameForFileOp("abc123", "", "", "session")).toBe("glovebox-abc123");
  });
});

// ---------------------------------------------------------------------------
describe("sandboxEnvArgs", () => {
  it("none/empty returns empty array", () => {
    expect(sandboxEnvArgs("none")).toEqual([]);
    expect(sandboxEnvArgs("")).toEqual([]);
    expect(sandboxEnvArgs("NONE")).toEqual([]);
  });

  it("all returns --env pairs for every process.env entry", () => {
    const args = sandboxEnvArgs("all");
    expect(args.includes("--env")).toBe(true);
    expect(args.length % 2).toBe(0);
    expect(args[0]).toBe("--env");
  });

  it("comma-separated list returns only set vars", () => {
    const args = sandboxEnvArgs("HOME,PATH,GLOVEBOX_NONEXISTENT_9999");
    expect(args).toContain("--env");
    const keys = args.filter((_: string, i: number) => args[i - 1] === "--env").map((kv: string) => kv.split("=")[0]);
    expect(keys).toContain("HOME");
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("GLOVEBOX_NONEXISTENT_9999");
  });
});

// ---------------------------------------------------------------------------
describe("sandboxWrapCommand", () => {
  it("wraps command in base64 + msb exec", () => {
    const wrapped = sandboxWrapCommand("my-box", "echo hello");
    const encoded = Buffer.from("echo hello").toString("base64");
    expect(wrapped).toContain(encoded);
    expect(wrapped).toContain("msb exec");
    expect(wrapped).toContain("'my-box'");
    expect(wrapped).toContain("-- bash");
  });

  it("includes --env args when provided", () => {
    const wrapped = sandboxWrapCommand("box", "ls", ["--env", "FOO=bar"]);
    expect(wrapped).toContain("--env");
    expect(wrapped).toContain("FOO=bar");
  });
});

describe("sandboxWrapCommandEphemeral", () => {
  it("includes stop and remove cleanup", () => {
    const wrapped = sandboxWrapCommandEphemeral("eph-box", "echo hi");
    expect(wrapped).toContain("msb stop 'eph-box'");
    expect(wrapped).toContain("msb remove 'eph-box'");
    expect(wrapped).toContain("exit $_ec");
  });
});

// ---------------------------------------------------------------------------
describe("sandboxConfigFingerprint", () => {
  const fp = (...args: string[]) => sandboxConfigFingerprint(...args);

  it("returns 16-char hex string", () => {
    const f = fp("ubuntu","true","enabled","","","","false","","","false","","");
    expect(f).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for same inputs", () => {
    const a = fp("ubuntu","true","enabled","","","","false","","","false","","");
    const b = fp("ubuntu","true","enabled","","","","false","","","false","","");
    expect(a).toBe(b);
  });

  it("changes when image changes", () => {
    const a = fp("ubuntu","true","enabled","","","","false","","","false","","");
    const b = fp("alpine","true","enabled","","","","false","","","false","","");
    expect(a).not.toBe(b);
  });

  it("changes when network changes", () => {
    const a = fp("ubuntu","true","enabled","","","","false","","","false","","");
    const b = fp("ubuntu","true","disabled","","","","false","","","false","","");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
describe("sandboxResolvePath — path traversal prevention", () => {
  const proj = "/tmp/my-project";
  const stateDir = "/tmp/.cache/glovebox/sess1";
  const shadowRoot = `${stateDir}/shadow`;

  it("project-dir file passes through unchanged", () => {
    const r = sandboxResolvePath(`${proj}/src/index.ts`, proj, stateDir);
    expect(r.needsSync).toBe(false);
    expect(r.hostPath).toBe(`${proj}/src/index.ts`);
  });

  it("/workspace path maps to project dir", () => {
    const r = sandboxResolvePath("/workspace/src/index.ts", proj, stateDir);
    expect(r.needsSync).toBe(false);
    expect(r.hostPath).toContain(proj);
  });

  it("VM-only absolute path goes to shadow", () => {
    const r = sandboxResolvePath("/etc/hosts", proj, stateDir);
    expect(r.needsSync).toBe(true);
    expect(r.hostPath).toBe(`${shadowRoot}/etc/hosts`);
  });

  it("traversal path escaping project dir goes to shadow", () => {
    const traversal = `${proj}/../../etc/passwd`;
    const r = sandboxResolvePath(traversal, proj, stateDir);
    expect(r.needsSync).toBe(true);
    expect(r.hostPath).toContain(shadowRoot);
    expect(r.hostPath).not.toContain("..");
  });

  it("deep traversal goes to shadow, not host", () => {
    const traversal = `${proj}/../../../tmp/secret`;
    const r = sandboxResolvePath(traversal, proj, stateDir);
    expect(r.needsSync).toBe(true);
    expect(r.hostPath).toContain(shadowRoot);
  });
});
