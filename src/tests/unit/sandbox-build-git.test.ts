import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";

const MODULE_URL = new URL(
  "../../../plugins/glovebox/scripts/lib/sandbox-build.mjs",
  import.meta.url
).href;

/* eslint-disable @typescript-eslint/no-explicit-any */
const baseCfg = {
  sandboxName: "test-sb",
  image: "ubuntu",
  projectDir: "/tmp/proj",
  mountWorkdir: true,
  network: "enabled",
  ports: "",
  secrets: "",
  onSecretViolation: "",
  tlsIntercept: false,
  tlsInterceptPort: null as number | null,
  tlsBypass: "",
  trustHostCas: false,
};

describe("sandbox-build.mjs — applyGitIdentity", () => {
  function makeMockSandboxClass(): { Sandbox: any; lastExec: () => unknown[] | null } {
    const calls: unknown[][] = [];
    const live = {
      exec: async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: () => "" };
      },
    };
    const handle = { connect: async () => live };
    const Sandbox = { get: async () => handle };
    return { Sandbox, lastExec: () => (calls.length ? calls[calls.length - 1]! : null) };
  }

  it("no-op when neither gitUserName nor gitUserEmail is set", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, { sandboxName: "test", gitUserName: "", gitUserEmail: "" });
    expect(lastExec()).toBeNull();
  });

  it("execs `git config --global user.name` when only name is set", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, { sandboxName: "test", gitUserName: "Alice", gitUserEmail: "" });
    const call = lastExec();
    expect(call).not.toBeNull();
    expect(call?.[0]).toBe("sh");
    const script = (call?.[1] as string[])[1];
    expect(script).toMatch(/git config --global user\.name "Alice"/);
    expect(script).not.toMatch(/user\.email/);
  });

  it("execs both user.name and user.email when both set, AND-chained", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, {
      sandboxName: "test",
      gitUserName: "Alice",
      gitUserEmail: "alice@example.com",
    });
    const script = ((lastExec()?.[1] as string[]) || [])[1] || "";
    expect(script).toMatch(/git config --global user\.name "Alice"/);
    expect(script).toMatch(/&& git config --global user\.email "alice@example\.com"/);
  });

  it("shell-escapes quotes / backslashes / `$` / backticks in the values", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, {
      sandboxName: "test",
      gitUserName: 'Bob "the Builder" $WHO',
      gitUserEmail: "bob`echo`@host",
    });
    const script = ((lastExec()?.[1] as string[]) || [])[1] || "";
    expect(script).toContain('user.name "Bob \\"the Builder\\" \\$WHO"');
    expect(script).toContain('user.email "bob\\`echo\\`@host"');
  });

  it("swallows SDK errors silently (best-effort)", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const Sandbox = { get: async () => { throw new Error("sandbox vanished"); } };
    await expect(applyGitIdentity(Sandbox, {
      sandboxName: "test", gitUserName: "x", gitUserEmail: "y@z",
    })).resolves.toBeUndefined();
  });
});

describe("sandbox-build.mjs — dumpFake", () => {
  const NAME = "glovebox-sandbox-build-test";
  const FAKE_FILE = `/tmp/fake-msb-${NAME}.create-args`;
  const STATE_FILE = `/tmp/fake-msb-${NAME}.state`;

  beforeEach(() => {
    try { rmSync(FAKE_FILE); } catch { /* ignore */ }
    try { rmSync(STATE_FILE); } catch { /* ignore */ }
  });
  afterEach(() => {
    try { rmSync(FAKE_FILE); } catch { /* ignore */ }
    try { rmSync(STATE_FILE); } catch { /* ignore */ }
  });

  it("returns false when GLOVEBOX_FAKE_CREATE is unset", async () => {
    delete process.env["GLOVEBOX_FAKE_CREATE"];
    const { dumpFake } = await import(MODULE_URL);
    expect(dumpFake({ sandboxName: NAME })).toBe(false);
    expect(existsSync(FAKE_FILE)).toBe(false);
  });

  it("writes the JSON payload + state file when GLOVEBOX_FAKE_CREATE=1", async () => {
    process.env["GLOVEBOX_FAKE_CREATE"] = "1";
    try {
      const { dumpFake } = await import(MODULE_URL);
      const cfg = { ...baseCfg, sandboxName: NAME };
      expect(dumpFake(cfg)).toBe(true);
      expect(existsSync(FAKE_FILE)).toBe(true);
      expect(existsSync(STATE_FILE)).toBe(true);
      const dumped = JSON.parse(readFileSync(FAKE_FILE, "utf8"));
      expect(dumped.sandboxName).toBe(NAME);
      expect(dumped.image).toBe("ubuntu");
      expect(readFileSync(STATE_FILE, "utf8").trim()).toBe("Running");
    } finally {
      delete process.env["GLOVEBOX_FAKE_CREATE"];
    }
  });
});
