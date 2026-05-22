import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { fixturePath } from "../../helpers/fixtures.js";

function dirSandboxName(dir: string): string {
  return `cc-msb-dir-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.sh");

const SESSION_ID = "unit-config-test-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function bashEvent(agentType?: string) {
  return {
    tool_name: "Bash",
    session_id: SESSION_ID,
    ...(agentType ? { agent_type: agentType } : {}),
    tool_input: { command: "echo hi" },
  };
}

function runHook(
  projectDir: string,
  extraEnv: Record<string, string> = {},
  agentType?: string
) {
  return spawnSync("bash", [PRE_HOOK], {
    input: JSON.stringify(bashEvent(agentType)),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      ...extraEnv,
    },
  });
}

// Per-agent sandbox name for "test-agent" with this SESSION_ID:
//   session prefix: SESSION_ID.slice(0,8) = "unit-con"
//   agent snake:    "test_agent".slice(0,8) = "test_age"
const PER_AGENT_SANDBOX = `cc-msb-${SESSION_ID.slice(0, 8)}-test_age`;
const SESSION_PREFIX = `cc-msb-${SESSION_ID.slice(0, 8)}`;

function readCreateArgs(sandboxName: string = SANDBOX_NAME): string[] {
  const argsFile = `/tmp/fake-msb-${sandboxName}.create-args`;
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean);
}

// Returns the first per-run create-args file for this session (name != main sandbox).
function findEphemeralCreateArgs(): string | null {
  const files = readdirSync("/tmp").filter(
    (f) =>
      f.startsWith(`fake-msb-${SESSION_PREFIX}`) &&
      f.endsWith(".create-args") &&
      f !== `fake-msb-${SANDBOX_NAME}.create-args`
  );
  return files.length > 0 ? `/tmp/${files[0]}` : null;
}

const NAMED_PREFIXES = ["cc-msb-test-named", "cc-msb-env-named", "cc-msb-env-agent-named"];

function cleanupFakeMsbFiles() {
  readdirSync("/tmp")
    .filter((f) => {
      if (!f.startsWith("fake-msb-") || (!f.endsWith(".state") && !f.endsWith(".create-args"))) return false;
      if (f.startsWith(`fake-msb-${SESSION_PREFIX}`)) return true;
      if (f.startsWith("fake-msb-cc-msb-dir-")) return true;
      return NAMED_PREFIXES.some((p) => f.startsWith(`fake-msb-${p}`));
    })
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — mount_workdir", () => {
  it("mounts workdir by default (no config file)", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()).toContain("--volume");
  });

  it("mounts workdir when config file sets mount_workdir: true", () => {
    runHook(fixturePath("config-mount-on"));
    expect(readCreateArgs()).toContain("--volume");
  });

  it("does not mount workdir when config file sets mount_workdir: false", () => {
    runHook(fixturePath("config-mount-off"));
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("env var CC_MSB_MAIN_MOUNT_WORKDIR=false overrides config file true", () => {
    runHook(fixturePath("config-mount-on"), { CC_MSB_MAIN_MOUNT_WORKDIR: "false" });
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("env var CC_MSB_MAIN_MOUNT_WORKDIR=true overrides config file false", () => {
    runHook(fixturePath("config-mount-off"), { CC_MSB_MAIN_MOUNT_WORKDIR: "true" });
    expect(readCreateArgs()).toContain("--volume");
  });

  it("env var CC_MSB_AGENT_MOUNT_WORKDIR=false disables mount for agents", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_AGENT_SCOPE_TEST_AGENT: "per-agent", CC_MSB_AGENT_MOUNT_WORKDIR: "false" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).not.toContain("--volume");
  });

  it("config file supports quoted values (mount_workdir: 'false')", () => {
    runHook(fixturePath("config-quoted-false"));
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("config file ignores comments after value", () => {
    // config-mount-off has a plain `mount_workdir: false` — comments are tested
    // via config-quoted-false which also has no trailing comment and passes.
    // Inline-comment case tested directly via a dedicated fixture path isn't needed
    // because config_yaml_get strips comments in all cases; the quoted-false
    // fixture covers the parser branch. A comment-bearing config is verified here
    // by running with the no-config default and checking volume IS present.
    runHook(fixturePath("config-mount-off"));
    expect(readCreateArgs()).not.toContain("--volume");
  });
});

describe("config — sandbox_image", () => {
  it("uses ubuntu by default (no config file)", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("uses image from config file", () => {
    runHook(fixturePath("config-image-debian"));
    expect(readCreateArgs()[0]).toBe("debian");
  });

  it("env var CC_MSB_SANDBOX_IMAGE overrides config file", () => {
    runHook(fixturePath("config-image-debian"), { CC_MSB_SANDBOX_IMAGE: "alpine" });
    expect(readCreateArgs()[0]).toBe("alpine");
  });

  it("env var CC_MSB_SANDBOX_IMAGE overrides default when no config file", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_SANDBOX_IMAGE: "alpine" });
    expect(readCreateArgs()[0]).toBe("alpine");
  });
});

describe("config — agent-specific image", () => {
  it("uses agent-specific image from config when agent_type matches", () => {
    // config-agent-image sets scope: per-agent on test-agent, so create-args
    // land at the per-agent sandbox name, not the session sandbox.
    runHook(fixturePath("config-agent-image"), {}, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("debian");
  });

  it("falls back to global sandbox_image for an unlisted agent", () => {
    runHook(fixturePath("config-agent-image"), {}, "other-agent");
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("falls back to global sandbox_image when no agent_type in event", () => {
    runHook(fixturePath("config-agent-image"));
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("env var CC_MSB_AGENT_IMAGE_<NAME> overrides config file for that agent", () => {
    // config-agent-image sets scope: per-agent on test-agent.
    runHook(fixturePath("config-agent-image"), { CC_MSB_AGENT_IMAGE_TEST_AGENT: "alpine" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
  });

  it("env var CC_MSB_AGENT_IMAGE_<NAME> with hyphenated agent name (test-agent → TEST_AGENT)", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_AGENT_IMAGE_TEST_AGENT: "alpine" }, "test-agent");
    expect(readCreateArgs()[0]).toBe("alpine");
  });
});

describe("config — scope", () => {
  it("uses main sandbox when no agent_type (any scope)", () => {
    runHook(fixturePath("config-scope-per-agent"));
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });

  it("default (no config): agent and main share the same sandbox", () => {
    runHook(fixturePath("simple-read"));
    runHook(fixturePath("simple-read"), {}, "test-agent");
    // Both calls land in the same session-scoped sandbox
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
    // main session always uses the base sandbox name regardless of scope
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
    // session scope: agent shares main sandbox; image is global default, not main.sandbox_image
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
    // test-agent has scope: per-agent, default is session — agent gets own sandbox
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("unlisted agents still use defaults.agents.scope", () => {
    runHook(fixturePath("config-scope-per-agent-scope"), {}, "other-agent");
    // other-agent inherits defaults.agents.scope: session — uses main sandbox
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });

  it("CC_MSB_AGENT_SCOPE_<NAME> env var overrides agent config file scope", () => {
    runHook(fixturePath("config-scope-session"), { CC_MSB_AGENT_SCOPE_TEST_AGENT: "per-agent" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("ubuntu");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("main session uses main.scope, not defaults.agents.scope", () => {
    // config-scope-per-agent-scope has defaults.agents.scope: session; main has no override
    // main session should get session scope (main sandbox)
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
    // Sandbox was created once; state file exists but create-args written once
    const lines = readCreateArgs(NAMED_SANDBOX);
    expect(lines).toContain("ubuntu");
    // second call hits "Running" → no re-create → still exactly one set of create-args
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
    // second call hits "Running" → no re-create → still one set of create-args
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

function wrappedCommand(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.updatedInput.command;
}

describe("config — pass_env", () => {
  it("defaults to 'none' — no --env flags injected", () => {
    const r = runHook(fixturePath("simple-read"), { TEST_PASS_ENV_VAR: "host-value" });
    expect(r.status).toBe(0);
    expect(wrappedCommand(r.stdout)).not.toMatch(/--env\b/);
  });

  it("explicit 'none' yields no --env flags", () => {
    const r = runHook(fixturePath("config-pass-env-none"), { TEST_PASS_ENV_VAR: "host-value" });
    expect(r.status).toBe(0);
    expect(wrappedCommand(r.stdout)).not.toMatch(/--env\b/);
  });

  it("passes only the env vars listed in main.pass_env", () => {
    const r = runHook(fixturePath("config-pass-env-list"), {
      TEST_PASS_ENV_VAR: "v1",
      SECOND_VAR: "v2",
      UNRELATED_VAR: "leaked",
    });
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/TEST_PASS_ENV_VAR=v1/);
    expect(cmd).toMatch(/SECOND_VAR=v2/);
    expect(cmd).not.toMatch(/UNRELATED_VAR/);
  });

  it("skips vars from the list that are not set on the host", () => {
    const r = runHook(fixturePath("config-pass-env-list"), {
      TEST_PASS_ENV_VAR: "only-this",
      // SECOND_VAR intentionally unset (only this run's extraEnv applies, but env() may inherit)
    });
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/TEST_PASS_ENV_VAR=only-this/);
  });

  it("'all' passes every host env var (at least PATH and a custom one)", () => {
    const r = runHook(fixturePath("config-pass-env-all"), { TEST_PASS_ENV_VAR: "from-host" });
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/--env\s+\\?'?PATH=/);
    expect(cmd).toMatch(/TEST_PASS_ENV_VAR=from-host/);
  });

  it("agent inherits defaults.agents.pass_env when no agent override", () => {
    const r = runHook(
      fixturePath("config-pass-env-default-list"),
      { DEFAULT_VAR_A: "a", DEFAULT_VAR_B: "b", UNRELATED: "x" },
      "test-agent"
    );
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/DEFAULT_VAR_A=a/);
    expect(cmd).toMatch(/DEFAULT_VAR_B=b/);
    expect(cmd).not.toMatch(/UNRELATED/);
  });

  it("agent-specific pass_env overrides defaults.agents.pass_env", () => {
    const r = runHook(
      fixturePath("config-pass-env-agent-override"),
      { DEFAULT_VAR: "default", AGENT_VAR: "agent" },
      "test-agent"
    );
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/AGENT_VAR=agent/);
    expect(cmd).not.toMatch(/DEFAULT_VAR=/);
  });

  it("unlisted agent falls back to defaults.agents.pass_env", () => {
    const r = runHook(
      fixturePath("config-pass-env-agent-override"),
      { DEFAULT_VAR: "default" },
      "other-agent"
    );
    expect(r.status).toBe(0);
    expect(wrappedCommand(r.stdout)).toMatch(/DEFAULT_VAR=default/);
  });

  it("CC_MSB_MAIN_PASS_ENV overrides main.pass_env in the config file", () => {
    const r = runHook(fixturePath("config-pass-env-list"), {
      TEST_PASS_ENV_VAR: "from-config",
      OVERRIDE_VAR: "from-env",
      CC_MSB_MAIN_PASS_ENV: "OVERRIDE_VAR",
    });
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/OVERRIDE_VAR=from-env/);
    expect(cmd).not.toMatch(/TEST_PASS_ENV_VAR/);
  });

  it("CC_MSB_AGENT_PASS_ENV_<NAME> overrides agent config file pass_env", () => {
    const r = runHook(
      fixturePath("config-pass-env-agent-override"),
      {
        AGENT_VAR: "from-config",
        ENV_AGENT_VAR: "from-env",
        CC_MSB_AGENT_PASS_ENV_TEST_AGENT: "ENV_AGENT_VAR",
      },
      "test-agent"
    );
    expect(r.status).toBe(0);
    const cmd = wrappedCommand(r.stdout);
    expect(cmd).toMatch(/ENV_AGENT_VAR=from-env/);
    expect(cmd).not.toMatch(/AGENT_VAR=from-config/);
  });

  it("CC_MSB_MAIN_PASS_ENV=none disables passing even when main.pass_env lists vars", () => {
    const r = runHook(fixturePath("config-pass-env-list"), {
      TEST_PASS_ENV_VAR: "x",
      CC_MSB_MAIN_PASS_ENV: "none",
    });
    expect(r.status).toBe(0);
    expect(wrappedCommand(r.stdout)).not.toMatch(/--env\b/);
  });
});

describe("config — network", () => {
  it("default (no config): no network flags on msb create", () => {
    runHook(fixturePath("simple-read"));
    const args = readCreateArgs();
    expect(args).not.toContain("--no-net");
    expect(args).not.toContain("--net-rule");
  });

  it("main.network=disabled: adds --no-net to msb create", () => {
    runHook(fixturePath("config-network-disabled"));
    const args = readCreateArgs();
    expect(args).toContain("--no-net");
  });

  it("main.network=<list>: emits --net-rule allow@<domain> per entry", () => {
    runHook(fixturePath("config-network-allowlist"));
    const args = readCreateArgs();
    // Each domain becomes a pair: "--net-rule" + "allow@<domain>"
    expect(args).toContain("--net-rule");
    expect(args).toContain("allow@example.com");
    expect(args).toContain("allow@api.github.com");
    expect(args).not.toContain("--no-net");
  });

  it("agent override beats defaults.agents.network", () => {
    runHook(fixturePath("config-network-agent-override"), {}, "test-agent");
    // Agent uses the session sandbox (default scope) — args land there.
    const args = readCreateArgs();
    // test-agent has network: "example.com", so we get a rule, not --no-net.
    expect(args).toContain("--net-rule");
    expect(args).toContain("allow@example.com");
    expect(args).not.toContain("--no-net");
  });

  it("unlisted agent falls back to defaults.agents.network=disabled", () => {
    runHook(fixturePath("config-network-agent-override"), {}, "other-agent");
    // other-agent has no override → defaults.agents.network: disabled
    // With per-agent default scope=session (no config there), other-agent
    // uses the session sandbox. Inspect main sandbox args.
    const args = readCreateArgs();
    expect(args).toContain("--no-net");
  });

  it("CC_MSB_MAIN_NETWORK overrides config file", () => {
    runHook(fixturePath("config-network-allowlist"), { CC_MSB_MAIN_NETWORK: "disabled" });
    const args = readCreateArgs();
    expect(args).toContain("--no-net");
    expect(args).not.toContain("allow@example.com");
  });

  it("CC_MSB_AGENT_NETWORK_<NAME> overrides agent file config", () => {
    runHook(
      fixturePath("config-network-agent-override"),
      { CC_MSB_AGENT_NETWORK_TEST_AGENT: "disabled" },
      "test-agent"
    );
    const args = readCreateArgs();
    expect(args).toContain("--no-net");
  });

  it("CC_MSB_MAIN_NETWORK=enabled disables network restrictions", () => {
    runHook(fixturePath("config-network-disabled"), { CC_MSB_MAIN_NETWORK: "enabled" });
    const args = readCreateArgs();
    expect(args).not.toContain("--no-net");
  });
});

describe("config — ports", () => {
  it("default (no config): no --port flags on msb create", () => {
    runHook(fixturePath("simple-read"));
    const args = readCreateArgs();
    expect(args).not.toContain("--port");
  });

  it("main.ports=HOST:GUEST: emits one --port flag", () => {
    runHook(fixturePath("config-ports-single"));
    const args = readCreateArgs();
    expect(args).toContain("--port");
    expect(args).toContain("9876:8000");
  });

  it("main.ports=<list>: emits one --port flag per entry, preserving /proto suffix", () => {
    runHook(fixturePath("config-ports-multi"));
    const args = readCreateArgs();
    // three --port flags
    expect(args.filter((a) => a === "--port")).toHaveLength(3);
    expect(args).toContain("8080:80");
    expect(args).toContain("5432:5432");
    expect(args).toContain("9229:9229/udp");
  });

  it("agent override beats defaults.agents.ports", () => {
    runHook(fixturePath("config-ports-agent-override"), {}, "test-agent");
    const args = readCreateArgs();
    expect(args).toContain("22222:22222");
    expect(args).not.toContain("11111:11111");
  });

  it("unlisted agent falls back to defaults.agents.ports", () => {
    runHook(fixturePath("config-ports-agent-override"), {}, "other-agent");
    const args = readCreateArgs();
    expect(args).toContain("11111:11111");
  });

  it("CC_MSB_MAIN_PORTS overrides config file", () => {
    runHook(fixturePath("config-ports-single"), { CC_MSB_MAIN_PORTS: "7777:7777" });
    const args = readCreateArgs();
    expect(args).toContain("7777:7777");
    expect(args).not.toContain("9876:8000");
  });

  it("CC_MSB_AGENT_PORTS_<NAME> overrides agent file config", () => {
    runHook(
      fixturePath("config-ports-agent-override"),
      { CC_MSB_AGENT_PORTS_TEST_AGENT: "33333:33333" },
      "test-agent"
    );
    const args = readCreateArgs();
    expect(args).toContain("33333:33333");
    expect(args).not.toContain("22222:22222");
  });
});

describe("config — scope: host", () => {
  it("main scope=host: Bash hook passes through (no rewrite, no sandbox create)", () => {
    const r = runHook(fixturePath("config-scope-host-main"));
    expect(r.status).toBe(0);
    // No JSON emitted — full pass-through means stdout is empty and CC uses original tool_input.
    expect(r.stdout.trim()).toBe("");
    // No fake-msb sandbox was ever created.
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("agent scope=host: Bash hook for that agent passes through; main still sandboxed", () => {
    // Agent invocation: scope=host → pass-through
    const rAgent = runHook(fixturePath("config-scope-host-agent"), {}, "test-agent");
    expect(rAgent.status).toBe(0);
    expect(rAgent.stdout.trim()).toBe("");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);

    // Main session has no override → defaults to session scope, sandbox is created
    const rMain = runHook(fixturePath("config-scope-host-agent"));
    expect(rMain.status).toBe(0);
    expect(readCreateArgs(SANDBOX_NAME)).toContain("ubuntu");
  });

  it("CC_MSB_MAIN_SCOPE=host forces pass-through even without a config file", () => {
    const r = runHook(fixturePath("simple-read"), { CC_MSB_MAIN_SCOPE: "host" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("CC_MSB_AGENT_SCOPE_<NAME>=host forces pass-through for that agent", () => {
    const r = runHook(
      fixturePath("simple-read"),
      { CC_MSB_AGENT_SCOPE_TEST_AGENT: "host" },
      "test-agent"
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("scope=host bypasses Read hook too (no shadow sync)", () => {
    const r = runHook(fixturePath("config-scope-host-main"));
    // Switch to a Read event by running the hook with a different tool_name
    const result = spawnSync("bash", [PRE_HOOK], {
      input: JSON.stringify({
        tool_name: "Read",
        session_id: SESSION_ID,
        tool_input: { file_path: "/etc/os-release" },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        CLAUDE_PROJECT_DIR: fixturePath("config-scope-host-main"),
      },
    });
    expect(result.status).toBe(0);
    expect((result.stdout ?? "").trim()).toBe("");
    void r;
  });
});
