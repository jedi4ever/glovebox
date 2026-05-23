import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, readCreateConfig, PER_AGENT_SANDBOX, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-sec-tls-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — secrets", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-msb-secrets-"));
    writeFileSync(join(dir, ".cc-msb.yml"), yaml);
    return dir;
  }

  it("default (no config): no --secret flags", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()).not.toContain("--secret");
  });

  it("main.secrets list emits --secret entries with $VAR substitution", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  secrets:\n" +
      '    - "GITHUB_TOKEN=$TEST_PROBE_GH@github.com"\n'
    );
    try {
      runHook(dir, { TEST_PROBE_GH: "ghp_x" });
      const args = readCreateArgs();
      expect(args).toContain("--secret");
      expect(args).toContain("GITHUB_TOKEN=ghp_x@github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("literal VALUE (no leading $) is passed through verbatim", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  secrets:\n" +
      '    - "LITERAL=plainvalue@example.com"\n'
    );
    try {
      runHook(dir);
      expect(readCreateArgs()).toContain("LITERAL=plainvalue@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("$VAR with unset host env var is silently skipped", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  secrets:\n" +
      '    - "TOKEN_A=$TEST_PROBE_PRESENT@host.example"\n' +
      '    - "TOKEN_B=$TEST_PROBE_DEFINITELY_UNSET_XYZ@host.example"\n'
    );
    try {
      runHook(dir, { TEST_PROBE_PRESENT: "set-value" });
      const args = readCreateArgs();
      expect(args).toContain("TOKEN_A=set-value@host.example");
      expect(args.find((a) => a.startsWith("TOKEN_B="))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed entry (missing @HOST) is silently dropped", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  secrets:\n" +
      '    - "BAD=valueonly"\n' +
      '    - "GOOD=value@host"\n'
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("GOOD=value@host");
      expect(args.find((a) => a.includes("BAD="))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("on_secret_violation lands as --on-secret-violation", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  on_secret_violation: block-and-log\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("--on-secret-violation");
      expect(args).toContain("block-and-log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-specific secrets are picked up for an agent call", () => {
    const dir = makeLocalConfig(
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n" +
      "    secrets:\n" +
      '      - "AGENT_TOKEN=$TEST_AGENT_VAL@agent.example"\n'
    );
    try {
      runHook(dir, { TEST_AGENT_VAL: "agent-secret" }, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("AGENT_TOKEN=agent-secret@agent.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CC_MSB_MAIN_SECRETS env var overrides config file", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  secrets:\n" +
      '    - "FROM_FILE=$X@host\n'
    );
    try {
      runHook(dir, {
        CC_MSB_MAIN_SECRETS: "FROM_ENV=literal@override.host",
      });
      const args = readCreateArgs();
      expect(args).toContain("FROM_ENV=literal@override.host");
      expect(args.find((a) => a.startsWith("FROM_FILE="))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config — TLS interception", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-msb-tls-"));
    writeFileSync(join(dir, ".cc-msb.yml"), yaml);
    return dir;
  }

  it("default (no config): no TLS flags", () => {
    runHook(fixturePath("simple-read"));
    const args = readCreateArgs();
    expect(args).not.toContain("--tls-intercept");
    expect(args).not.toContain("--trust-host-cas");
  });

  it("tls_intercept: true adds --tls-intercept", () => {
    const dir = makeLocalConfig("main:\n  tls_intercept: true\n");
    try {
      runHook(dir);
      expect(readCreateArgs()).toContain("--tls-intercept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tls_intercept_port is forwarded as --tls-intercept-port", () => {
    const dir = makeLocalConfig(
      "main:\n  tls_intercept: true\n  tls_intercept_port: 8443\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("--tls-intercept-port");
      expect(args).toContain("8443");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tls_bypass list emits one --tls-bypass per domain", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  tls_intercept: true\n" +
      "  tls_bypass:\n" +
      "    - \"*.internal.com\"\n" +
      "    - intranet.corp\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args.filter((a) => a === "--tls-bypass")).toHaveLength(2);
      expect(args).toContain("*.internal.com");
      expect(args).toContain("intranet.corp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trust_host_cas: true adds --trust-host-cas", () => {
    const dir = makeLocalConfig("main:\n  trust_host_cas: true\n");
    try {
      runHook(dir);
      expect(readCreateArgs()).toContain("--trust-host-cas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CC_MSB_MAIN_TLS_INTERCEPT env var overrides config file (env=true wins over file=false default)", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_MAIN_TLS_INTERCEPT: "true" });
    expect(readCreateArgs()).toContain("--tls-intercept");
  });

  it("defaults.X bare key applies TLS settings to both main and an agent", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  tls_intercept: true\n" +
      "  trust_host_cas: true\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir);
      const mainArgs = readCreateArgs();
      expect(mainArgs).toContain("--tls-intercept");
      expect(mainArgs).toContain("--trust-host-cas");

      cleanupFakeMsbFiles();
      runHook(dir, {}, "test-agent");
      const agentArgs = readCreateArgs(PER_AGENT_SANDBOX);
      expect(agentArgs).toContain("--tls-intercept");
      expect(agentArgs).toContain("--trust-host-cas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
