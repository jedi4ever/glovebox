// Direct unit tests for plugins/glovebox/lib/config.mjs — advanced features.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";

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

describe("config.mjs — network merge semantics", () => {
  it("disabled beats any allowlist", () => {
    const dir = tmpProject('main:\n  network: "example.com"\n');
    try {
      expect(runConfig(dir, "", { GLOVEBOX_MAIN_NETWORK: "disabled" }).network).toBe("disabled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("config.mjs — pass_env semantics", () => {
  it("all beats any variable list", () => {
    const dir = tmpProject('main:\n  pass_env: "HOME,PATH"\n');
    try {
      expect(runConfig(dir, "", { GLOVEBOX_MAIN_PASS_ENV: "all" }).passEnv).toBe("all");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

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

describe("config.mjs — GitHub token expansion", () => {
  it("expands literal github_token into secrets + forces tls, network stays enabled", () => {
    const dir = tmpProject("main:\n  github_token: tok123\n  github_hosts: github.com\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.secrets).toContain("GH_TOKEN=tok123@github.com");
      expect(cfg.network).toBe("enabled");
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

describe("config.mjs — presets", () => {
  it("loads builtin npm preset and unions network", () => {
    const dir = tmpProject("presets:\n  - npm\n");
    try {
      const cfg = runConfig(dir);
      expect(cfg.network).toContain("registry.npmjs.org");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("later preset image wins over earlier (scalar last-wins)", () => {
    const presetDir = mkdtempSync(join(tmpdir(), "glovebox-presets-"));
    writeFileSync(join(presetDir, "first.yml"), "defaults:\n  agents:\n    scope: per-agent\n");
    writeFileSync(join(presetDir, "second.yml"), "defaults:\n  agents:\n    scope: per-run\n");
    const dir = tmpProject("presets:\n  - first\n  - second\n");
    try {
      const cfg = runConfig(dir, "", { GLOVEBOX_PRESETS_DIR: presetDir });
      expect(cfg.scope).toBe("per-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetDir, { recursive: true, force: true });
    }
  });
});

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
