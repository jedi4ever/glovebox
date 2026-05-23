// Direct unit tests for plugins/cc-msb/lib/config.mjs.
// These call `node config.mjs <dir> [agentType]` and assert on JSON output,
// giving fast focused coverage without going through the full hook pipeline.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";

const CONFIG_MJS = fileURLToPath(
  new URL("../../../plugins/cc-msb/lib/config.mjs", import.meta.url)
);

const BASE_ENV = {
  ...process.env,
  CC_MSB_CONFIG_DIR: "/tmp/cc-msb-test-nonexistent-global",
  CC_MSB_MAIN_GIT_USER_AUTODETECT: "false",
  CC_MSB_MAIN_GIT_TOKEN_AUTODETECT: "false",
};

interface CfgResult {
  sandboxName: string;
  image: string;
  mountWorkdir: boolean;
  scope: string;
  passEnv: string;
  network: string;
  ports: string;
  secrets: string;
  onSecretViolation: string;
  tlsIntercept: boolean;
  tlsInterceptPort: number | null;
  tlsBypass: string;
  trustHostCas: boolean;
  autoRecreate: boolean;
  gitUserName: string;
  gitUserEmail: string;
}

function runConfig(
  projectDir: string,
  agentType = "",
  extraEnv: Record<string, string> = {}
): CfgResult {
  const result = spawnSync("node", [CONFIG_MJS, projectDir, agentType], {
    encoding: "utf8",
    env: { ...BASE_ENV, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`config.mjs failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as CfgResult;
}

function tmpProject(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-msb-cfg-test-"));
  if (yaml) writeFileSync(join(dir, ".cc-msb.yml"), yaml);
  return dir;
}

// ---------------------------------------------------------------------------
describe("config.mjs — defaults", () => {
  it("emits all required fields with built-in defaults when no config present", () => {
    const dir = tmpProject();
    try {
      const cfg = runConfig(dir);
      expect(cfg.image).toBe("ubuntu");
      expect(cfg.scope).toBe("session");
      expect(cfg.mountWorkdir).toBe(true);
      expect(cfg.passEnv).toBe("none");
      expect(cfg.network).toBe("enabled");
      expect(cfg.tlsIntercept).toBe(false);
      expect(cfg.trustHostCas).toBe(false);
      expect(cfg.autoRecreate).toBe(false);
      expect(cfg.tlsInterceptPort).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — main section", () => {
  it("reads scope from main:", () => {
    const dir = tmpProject("main:\n  scope: named\n  sandbox_name: my-box\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.scope).toBe("named");
      expect(cfg.sandboxName).toBe("my-box");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads image from main:", () => {
    const dir = tmpProject("main:\n  sandbox_image: alpine\n");
    try {
      expect(runConfig(dir).image).toBe("alpine");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads network from main:", () => {
    const dir = tmpProject('main:\n  network: "example.com,api.example.com"\n');
    try {
      expect(runConfig(dir).network).toBe("example.com,api.example.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads block-list secrets from main:", () => {
    const dir = tmpProject("main:\n  secrets:\n    - KEY=literal@host.com\n");
    try {
      expect(runConfig(dir).secrets).toBe("KEY=literal@host.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — defaults section", () => {
  it("reads scope from defaults.agents for main session", () => {
    const dir = tmpProject("defaults:\n  agents:\n    scope: per-run\n");
    try {
      expect(runConfig(dir).scope).toBe("per-run");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("main.scope overrides defaults.agents.scope", () => {
    const dir = tmpProject(
      "main:\n  scope: session\ndefaults:\n  agents:\n    scope: per-run\n"
    );
    try {
      expect(runConfig(dir).scope).toBe("session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads image from defaults.agents for main session", () => {
    const dir = tmpProject("defaults:\n  agents:\n    sandbox_image: debian\n");
    try {
      expect(runConfig(dir).image).toBe("debian");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads image from bare defaults: key", () => {
    const dir = tmpProject("defaults:\n  sandbox_image: alpine\n");
    try {
      expect(runConfig(dir).image).toBe("alpine");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — agents section", () => {
  it("returns session-scoped defaults when agent not in config", () => {
    const dir = tmpProject("main:\n  scope: named\n");
    try {
      expect(runConfig(dir, "unknown-agent").scope).toBe("session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads agent-specific scope", () => {
    const dir = tmpProject(
      "agents:\n  test-agent:\n    scope: per-run\n"
    );
    try {
      expect(runConfig(dir, "test-agent").scope).toBe("per-run");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("agent-specific scope overrides defaults.agents", () => {
    const dir = tmpProject(
      "defaults:\n  agents:\n    scope: session\nagents:\n  test-agent:\n    scope: per-run\n"
    );
    try {
      expect(runConfig(dir, "test-agent").scope).toBe("per-run");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defaults.agents.scope applies to named agent when no agent override", () => {
    const dir = tmpProject("defaults:\n  agents:\n    scope: per-agent\n");
    try {
      expect(runConfig(dir, "test-agent").scope).toBe("per-agent");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — env var overrides", () => {
  it("CC_MSB_MAIN_SCOPE short-circuits YAML", () => {
    const dir = tmpProject("main:\n  scope: named\n");
    try {
      expect(runConfig(dir, "", { CC_MSB_MAIN_SCOPE: "host" }).scope).toBe("host");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("CC_MSB_SANDBOX_IMAGE overrides main image for main session", () => {
    const dir = tmpProject("main:\n  sandbox_image: debian\n");
    try {
      expect(runConfig(dir, "", { CC_MSB_SANDBOX_IMAGE: "alpine" }).image).toBe("alpine");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("CC_MSB_AGENT_SCOPE_TEST_AGENT overrides for that agent", () => {
    const dir = tmpProject("agents:\n  test-agent:\n    scope: per-run\n");
    try {
      expect(runConfig(dir, "test-agent", { CC_MSB_AGENT_SCOPE_TEST_AGENT: "session" }).scope).toBe("session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — network merge semantics", () => {
  it("disabled beats any allowlist", () => {
    const dir = tmpProject('main:\n  network: "example.com"\n');
    try {
      expect(runConfig(dir, "", { CC_MSB_MAIN_NETWORK: "disabled" }).network).toBe("disabled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — pass_env semantics", () => {
  it("all beats any variable list", () => {
    const dir = tmpProject('main:\n  pass_env: "HOME,PATH"\n');
    try {
      expect(runConfig(dir, "", { CC_MSB_MAIN_PASS_ENV: "all" }).passEnv).toBe("all");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — $VAR expansion in secrets", () => {
  it("expands $VAR references from env", () => {
    const dir = tmpProject("main:\n  secrets:\n    - MY_KEY=$MY_SECRET@host.com\n");
    try {
      const cfg = runConfig(dir, "", { MY_SECRET: "tok123" });
      expect(cfg.secrets).toBe("MY_KEY=tok123@host.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops entries where $VAR is unset", () => {
    const dir = tmpProject("main:\n  secrets:\n    - MY_KEY=$UNSET_VAR@host.com\n");
    try {
      const cfg = runConfig(dir, "", { UNSET_VAR: "" });
      expect(cfg.secrets).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — GitHub token expansion", () => {
  it("expands literal github_token into secrets + network + forces tls", () => {
    const dir = tmpProject("main:\n  github_token: tok123\n  github_hosts: github.com\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.secrets).toContain("GH_TOKEN=tok123@github.com");
      expect(cfg.network).toContain("github.com");
      expect(cfg.tlsIntercept).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("expands $VAR github_token from env", () => {
    const dir = tmpProject("main:\n  github_token: $GH_TOK\n  github_hosts: github.com\n");
    try {
      const cfg = runConfig(dir, "", { GH_TOK: "real-token" });
      expect(cfg.secrets).toContain("GH_TOKEN=real-token@github.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips expansion when $VAR github_token is unset", () => {
    const dir = tmpProject("main:\n  github_token: $UNSET_GH_TOKEN\n  github_hosts: github.com\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.secrets).toBe("");
      expect(cfg.tlsIntercept).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — presets", () => {
  it("loads builtin npm preset and unions network", () => {
    const dir = tmpProject("presets:\n  - npm\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.network).toContain("registry.npmjs.org");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("later preset image wins over earlier (scalar last-wins)", () => {
    // Create two minimal user presets in a temp dir
    const presetDir = mkdtempSync(join(tmpdir(), "cc-msb-presets-"));
    writeFileSync(join(presetDir, "first.yml"), "defaults:\n  agents:\n    scope: per-agent\n");
    writeFileSync(join(presetDir, "second.yml"), "defaults:\n  agents:\n    scope: per-run\n");
    const dir = tmpProject("presets:\n  - first\n  - second\n");
    try {
      const cfg = runConfig(dir, "", { CC_MSB_PRESETS_DIR: presetDir });
      expect(cfg.scope).toBe("per-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe("config.mjs — fixture compatibility", () => {
  it("config-scope-per-run fixture resolves scope=per-run", () => {
    const cfg = runConfig(fixturePath("config-scope-per-run"));
    expect(cfg.scope).toBe("per-run");
  });

  it("config-network-allowlist fixture resolves network correctly", () => {
    const cfg = runConfig(fixturePath("config-network-allowlist"));
    expect(cfg.network).toContain("example.com");
  });

  it("config-network-disabled fixture resolves network=disabled", () => {
    const cfg = runConfig(fixturePath("config-network-disabled"));
    expect(cfg.network).toBe("disabled");
  });

  it("config-tls fixture sets tlsIntercept=true", () => {
    const cfg = runConfig(fixturePath("config-tls"));
    expect(cfg.tlsIntercept).toBe(true);
  });
});
