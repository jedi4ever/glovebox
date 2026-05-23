import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, rmSync } from "node:fs";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext, dirSandboxName } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, SANDBOX_NAME, PER_AGENT_SANDBOX, findEphemeralCreateArgs, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-scp-spe-001");

const SCOPE_NAMED_PREFIXES = ["cc-msb-test-named", "cc-msb-env-named", "cc-msb-env-agent-named"];
function cleanupScopeNamedFiles() {
  readdirSync("/tmp")
    .filter((f) => (f.endsWith(".state") || f.endsWith(".create-args")) &&
      (f.startsWith("fake-msb-cc-msb-dir-") ||
       SCOPE_NAMED_PREFIXES.some((p) => f.startsWith(`fake-msb-${p}`))))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => { cleanupFakeMsbFiles(); cleanupScopeNamedFiles(); });
afterEach(() => { cleanupFakeMsbFiles(); cleanupScopeNamedFiles(); });

describe("config — scope", () => {
  it("uses main sandbox when no agent_type (any scope)", () => {
    runHook(fixturePath("config-scope-per-agent"));
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });

  it("default (no config): agent and main share the same sandbox", () => {
    runHook(fixturePath("simple-read"));
    runHook(fixturePath("simple-read"), {}, "test-agent");
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("session scope: agent uses the same (main) sandbox", () => {
    runHook(fixturePath("config-scope-session"), {}, "test-agent");
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("per-agent scope: agent gets its own sandbox", () => {
    runHook(fixturePath("config-scope-per-agent"), {}, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("per-run scope: agent gets a unique sandbox (not the main one)", () => {
    runHook(fixturePath("config-scope-per-run"), {}, "test-agent");
    expect(findEphemeralCreateArgs()).not.toBeNull();
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("per-run scope: two calls produce different sandbox names", () => {
    runHook(fixturePath("config-scope-per-run"), {}, "test-agent");
    const first = findEphemeralCreateArgs();
    cleanupFakeMsbFiles();
    runHook(fixturePath("config-scope-per-run"), {}, "test-agent");
    const second = findEphemeralCreateArgs();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("CC_MSB_AGENT_SCOPE_<NAME> env var overrides config file for that agent", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_AGENT_SCOPE_TEST_AGENT: "per-agent" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("CC_MSB_MAIN_SCOPE env var sets scope for the main session", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_MAIN_SCOPE: "per-agent" });
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });
});

describe("config — main section", () => {
  it("main.sandbox_image overrides global for the main session", () => {
    runHook(fixturePath("config-main-image"));
    expect(readCreateArgs()[0]).toBe("debian");
  });

  it("agents fall back to global sandbox_image, ignoring main.sandbox_image", () => {
    runHook(fixturePath("config-main-image"), {}, "test-agent");
    expect(readCreateArgs(SANDBOX_NAME)[0]).toBe("ubuntu");
  });

  it("CC_MSB_SANDBOX_IMAGE env var overrides main.sandbox_image", () => {
    runHook(fixturePath("config-main-image"), { CC_MSB_SANDBOX_IMAGE: "alpine" });
    expect(readCreateArgs()[0]).toBe("alpine");
  });
});

describe("config — per-agent scope override", () => {
  it("agent scope overrides defaults.agents.scope for that agent", () => {
    runHook(fixturePath("config-scope-per-agent-scope"), {}, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("unlisted agents still use defaults.agents.scope", () => {
    runHook(fixturePath("config-scope-per-agent-scope"), {}, "other-agent");
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });

  it("CC_MSB_AGENT_SCOPE_<NAME> env var overrides agent config file scope", () => {
    runHook(fixturePath("config-scope-session"), { CC_MSB_AGENT_SCOPE_TEST_AGENT: "per-agent" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("main session uses main.scope, not defaults.agents.scope", () => {
    runHook(fixturePath("config-scope-per-agent-scope"));
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });
});

describe("config — scope: named", () => {
  const NAMED_SANDBOX = "cc-msb-test-named";
  const NAMED_AGENT_SANDBOX = "cc-msb-test-named-agent";

  it("uses the configured sandbox_name as the sandbox", () => {
    runHook(fixturePath("config-named-sandbox"));
    expect(readCreateArgs(NAMED_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("two calls to the hook reuse the same named sandbox (not re-created)", () => {
    runHook(fixturePath("config-named-sandbox"));
    runHook(fixturePath("config-named-sandbox"));
    const lines = readCreateArgs(NAMED_SANDBOX);
    expect(lines).toContain("ubuntu");
    expect(lines.filter((l) => l === "ubuntu")).toHaveLength(1);
  });

  it("agent uses its own named sandbox from agent_sandbox_name_<agent>", () => {
    runHook(fixturePath("config-named-agent-sandbox"), {}, "test-agent");
    expect(readCreateArgs(NAMED_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs("cc-msb-test-named-main")).toHaveLength(0);
  });

  it("main session uses sandbox_name when no agent_type", () => {
    runHook(fixturePath("config-named-agent-sandbox"));
    expect(readCreateArgs("cc-msb-test-named-main")).toContain("ubuntu");
    expect(readCreateArgs(NAMED_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("env var CC_MSB_SANDBOX_NAME overrides config file", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_MAIN_SCOPE: "named", CC_MSB_SANDBOX_NAME: "cc-msb-env-named" });
    expect(readCreateArgs("cc-msb-env-named")).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("env var CC_MSB_AGENT_SANDBOX_NAME_<NAME> overrides config for that agent", () => {
    runHook(fixturePath("config-named-agent-sandbox"), { CC_MSB_AGENT_SANDBOX_NAME_TEST_AGENT: "cc-msb-env-agent-named" }, "test-agent");
    expect(readCreateArgs("cc-msb-env-agent-named")).toContain("ubuntu");
    expect(readCreateArgs(NAMED_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("named scope with no sandbox_name falls back to the session sandbox", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_MAIN_SCOPE: "named" });
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });
});

describe("config — scope: directory", () => {
  it("uses a sandbox name derived from the project directory", () => {
    const dir = fixturePath("config-scope-directory");
    runHook(dir);
    expect(readCreateArgs(dirSandboxName(dir))).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("two calls from the same directory reuse the same sandbox (not re-created)", () => {
    const dir = fixturePath("config-scope-directory");
    runHook(dir);
    runHook(dir);
    const lines = readCreateArgs(dirSandboxName(dir));
    expect(lines).toContain("ubuntu");
    expect(lines.filter((l) => l === "ubuntu")).toHaveLength(1);
  });

  it("two different directories produce different sandbox names", () => {
    const dirA = fixturePath("config-scope-directory");
    const dirB = fixturePath("simple-read");
    expect(dirSandboxName(dirA)).not.toBe(dirSandboxName(dirB));
  });

  it("CC_MSB_MAIN_SCOPE=directory uses a directory-derived sandbox", () => {
    const dir = fixturePath("simple-read");
    runHook(dir, { CC_MSB_MAIN_SCOPE: "directory" });
    expect(readCreateArgs(dirSandboxName(dir))).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });
});
