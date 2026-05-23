import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext, wrappedCommand } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-env-net-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

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
    });
    expect(r.status).toBe(0);
    expect(wrappedCommand(r.stdout)).toMatch(/TEST_PASS_ENV_VAR=only-this/);
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
    expect(readCreateArgs()).toContain("--no-net");
  });

  it("main.network=<list>: emits --net-rule allow@<domain> per entry", () => {
    runHook(fixturePath("config-network-allowlist"));
    const args = readCreateArgs();
    expect(args).toContain("--net-rule");
    expect(args).toContain("allow@example.com");
    expect(args).toContain("allow@api.github.com");
    expect(args).not.toContain("--no-net");
  });

  it("agent override beats defaults.agents.network", () => {
    runHook(fixturePath("config-network-agent-override"), {}, "test-agent");
    const args = readCreateArgs();
    expect(args).toContain("--net-rule");
    expect(args).toContain("allow@example.com");
    expect(args).not.toContain("--no-net");
  });

  it("unlisted agent falls back to defaults.agents.network=disabled", () => {
    runHook(fixturePath("config-network-agent-override"), {}, "other-agent");
    expect(readCreateArgs()).toContain("--no-net");
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
    expect(readCreateArgs()).toContain("--no-net");
  });

  it("CC_MSB_MAIN_NETWORK=enabled disables network restrictions", () => {
    runHook(fixturePath("config-network-disabled"), { CC_MSB_MAIN_NETWORK: "enabled" });
    expect(readCreateArgs()).not.toContain("--no-net");
  });
});

describe("config — ports", () => {
  it("default (no config): no --port flags on msb create", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()).not.toContain("--port");
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
    expect(readCreateArgs()).toContain("11111:11111");
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
