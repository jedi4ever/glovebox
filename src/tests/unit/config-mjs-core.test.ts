// Direct unit tests for plugins/glovebox/lib/config.mjs — core settings.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_IMAGE as DEFAULT } from "../../helpers/config-hook.js";

const CONFIG_MJS = fileURLToPath(
  new URL("../../../plugins/glovebox/lib/config.mjs", import.meta.url)
);


const BASE_ENV = {
  ...process.env,
  GLOVEBOX_CONFIG_DIR: "/tmp/glovebox-test-nonexistent-global",
  GLOVEBOX_MAIN_GIT_USER_AUTODETECT: "false",
  GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT: "false",
};

interface CfgResult {
  sandboxName: string; image: string; mountWorkdir: boolean; scope: string;
  passEnv: string; network: string; ports: string; secrets: string;
  onSecretViolation: string; tlsIntercept: boolean; tlsInterceptPort: number | null;
  tlsBypass: string; trustHostCas: boolean; autoRecreate: boolean;
  gitUserName: string; gitUserEmail: string;
}

function runConfig(projectDir: string, agentType = "", extraEnv: Record<string, string> = {}): CfgResult {
  const result = spawnSync("node", [CONFIG_MJS, projectDir, agentType], {
    encoding: "utf8",
    env: { ...BASE_ENV, ...extraEnv },
  });
  if (result.status !== 0) throw new Error(`config.mjs failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout) as CfgResult;
}

function tmpProject(yaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "glovebox-cfg-test-"));
  if (yaml) writeFileSync(join(dir, ".glovebox.yml"), yaml);
  return dir;
}

describe("config.mjs — defaults", () => {
  it("emits all required fields with built-in defaults when no config present", () => {
    const dir = tmpProject();
    try {
      const cfg = runConfig(dir);
      expect(cfg.image).toBe(DEFAULT);
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

describe("config.mjs — agents section", () => {
  it("returns session-scoped defaults when agent not in config", () => {
    const dir = tmpProject("main:\n  scope: named\n");
    try {
      expect(runConfig(dir, "unknown-agent").scope).toBe("session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads agent-specific scope", () => {
    const dir = tmpProject("agents:\n  test-agent:\n    scope: per-run\n");
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

describe("config.mjs — env var overrides", () => {
  it("GLOVEBOX_MAIN_SCOPE short-circuits YAML", () => {
    const dir = tmpProject("main:\n  scope: named\n");
    try {
      expect(runConfig(dir, "", { GLOVEBOX_MAIN_SCOPE: "host" }).scope).toBe("host");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("GLOVEBOX_SANDBOX_IMAGE overrides main image for main session", () => {
    const dir = tmpProject("main:\n  sandbox_image: debian\n");
    try {
      expect(runConfig(dir, "", { GLOVEBOX_SANDBOX_IMAGE: "alpine" }).image).toBe("alpine");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("GLOVEBOX_AGENT_SCOPE_TEST_AGENT overrides for that agent", () => {
    const dir = tmpProject("agents:\n  test-agent:\n    scope: per-run\n");
    try {
      expect(runConfig(dir, "test-agent", { GLOVEBOX_AGENT_SCOPE_TEST_AGENT: "session" }).scope).toBe("session");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

