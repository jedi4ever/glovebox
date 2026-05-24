import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConfigTestContext, FAKE_MSB_DIR } from "../../helpers/config-hook.js";

const { runHook, readCreateConfig, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-gad-adt-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — git autodetect (host fallbacks)", () => {
  // Each test uses a temp GIT_CONFIG_GLOBAL and a fake `gh` binary.
  // setup.ts globally disables both autodetect flags; this block re-enables them per-test.
  const AUTODETECT_ON = {
    GLOVEBOX_MAIN_GIT_USER_AUTODETECT: "true",
    GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT: "true",
  };

  function makeHostGitconfig(name?: string, email?: string): string {
    const f = mkdtempSync(join(tmpdir(), "glovebox-host-gc-"));
    const lines = ["[user]"];
    if (name) lines.push(`  name = ${name}`);
    if (email) lines.push(`  email = ${email}`);
    writeFileSync(join(f, "config"), lines.join("\n") + "\n");
    return join(f, "config");
  }

  function makeFakeGh(token: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "glovebox-fake-gh-"));
    const script = token == null
      ? "#!/usr/bin/env bash\nexit 1\n"
      : `#!/usr/bin/env bash\n[[ "$1" == "auth" && "$2" == "token" ]] && echo "${token}"\n`;
    writeFileSync(join(dir, "gh"), script);
    spawnSync("chmod", ["+x", join(dir, "gh")]);
    return dir;
  }

  function emptyConfigDir(): string {
    return mkdtempSync(join(tmpdir(), "glovebox-empty-cfg-"));
  }

  it("default: git_user_autodetect=true picks up host's user.name + user.email", () => {
    const gitConf = makeHostGitconfig("Autodetected User", "auto@example.com");
    const dir = emptyConfigDir();
    try {
      runHook(dir, { ...AUTODETECT_ON, GIT_CONFIG_GLOBAL: gitConf });
      const cfg = readCreateConfig();
      expect(cfg?.gitUserName).toBe("Autodetected User");
      expect(cfg?.gitUserEmail).toBe("auto@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(gitConf, { force: true });
    }
  });

  it("explicit git_user_name config wins over autodetected host value", () => {
    const gitConf = makeHostGitconfig("Should Not Win", "should-not-win@x");
    const dir = mkdtempSync(join(tmpdir(), "glovebox-git-auto-"));
    writeFileSync(join(dir, ".glovebox.yml"), "main:\n  git_user_name: \"Config Wins\"\n");
    try {
      runHook(dir, { ...AUTODETECT_ON, GIT_CONFIG_GLOBAL: gitConf });
      const cfg = readCreateConfig();
      expect(cfg?.gitUserName).toBe("Config Wins");
      expect(cfg?.gitUserEmail).toBe("should-not-win@x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(gitConf, { force: true });
    }
  });

  it("git_user_autodetect: false leaves the fields empty even if host has them", () => {
    const gitConf = makeHostGitconfig("Should Not Appear", "no@x");
    const dir = mkdtempSync(join(tmpdir(), "glovebox-git-auto-off-"));
    writeFileSync(join(dir, ".glovebox.yml"), "main:\n  git_user_autodetect: false\n");
    try {
      runHook(dir, {
        GLOVEBOX_MAIN_GIT_USER_AUTODETECT: "",
        GIT_CONFIG_GLOBAL: gitConf,
      });
      const cfg = readCreateConfig();
      expect(cfg?.gitUserName).toBe("");
      expect(cfg?.gitUserEmail).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(gitConf, { force: true });
    }
  });

  it("default: git_token_autodetect=true picks up `gh auth token` output", () => {
    const ghDir = makeFakeGh("ghp_from_gh_auth_token");
    const dir = emptyConfigDir();
    try {
      runHook(dir, {
        ...AUTODETECT_ON,
        PATH: `${ghDir}:${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      });
      const cfg = readCreateConfig();
      expect((cfg?.secrets ?? "")).toContain("GH_TOKEN=ghp_from_gh_auth_token@github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  it("explicit github_token config wins over `gh auth token`", () => {
    const ghDir = makeFakeGh("ghp_should_not_win");
    const dir = mkdtempSync(join(tmpdir(), "glovebox-token-auto-"));
    writeFileSync(join(dir, ".glovebox.yml"), "main:\n  github_token: ghp_config_wins\n");
    try {
      runHook(dir, {
        ...AUTODETECT_ON,
        PATH: `${ghDir}:${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      });
      const cfg = readCreateConfig();
      expect((cfg?.secrets ?? "")).toContain("GH_TOKEN=ghp_config_wins@github.com");
      expect((cfg?.secrets ?? "")).not.toContain("ghp_should_not_win");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  it("git_token_autodetect: false skips the `gh auth token` fallback", () => {
    const ghDir = makeFakeGh("ghp_should_not_appear");
    const dir = mkdtempSync(join(tmpdir(), "glovebox-token-auto-off-"));
    writeFileSync(join(dir, ".glovebox.yml"), "main:\n  git_token_autodetect: false\n");
    try {
      runHook(dir, {
        GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT: "",
        PATH: `${ghDir}:${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      });
      const cfg = readCreateConfig();
      expect(cfg?.secrets).toBe("");
      expect(cfg?.network).toBe("enabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  it("`gh auth token` failing (not authenticated) → token autodetect silently no-ops", () => {
    const ghDir = makeFakeGh(null);
    const dir = emptyConfigDir();
    try {
      runHook(dir, {
        ...AUTODETECT_ON,
        PATH: `${ghDir}:${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      });
      const cfg = readCreateConfig();
      expect(cfg?.secrets).toBe("");
      expect(cfg?.network).toBe("enabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });
});
