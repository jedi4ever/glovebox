import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, readCreateConfig, PER_AGENT_SANDBOX, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-gts-sec-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — git + github sections", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-msb-git-gh-"));
    writeFileSync(join(dir, ".cc-msb.yml"), yaml);
    return dir;
  }

  it("git_user_name and git_user_email land in the JSON payload as gitUserName / gitUserEmail", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      '  git_user_name: "Probe Bot"\n' +
      '  git_user_email: "probe@example.com"\n'
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.gitUserName).toBe("Probe Bot");
      expect(cfg?.gitUserEmail).toBe("probe@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing git_* keys → empty strings in the payload (no `git config` run later)", () => {
    runHook(fixturePath("simple-read"));
    const cfg = readCreateConfig();
    expect(cfg?.gitUserName).toBe("");
    expect(cfg?.gitUserEmail).toBe("");
  });

  it("github_token with $VAR → one secret per default host + hosts added to network", () => {
    const dir = makeLocalConfig(
      "main:\n  github_token: $PROBE_GH_TOKEN\n"
    );
    try {
      runHook(dir, { PROBE_GH_TOKEN: "ghp_xyz" });
      const cfg = readCreateConfig();
      const netDomains = (cfg?.network ?? "").split(",");
      expect(netDomains).toContain("github.com");
      expect(netDomains).toContain("api.github.com");
      expect(netDomains).toContain("codeload.github.com");
      expect(netDomains).toContain("objects.githubusercontent.com");
      expect(netDomains).toContain("raw.githubusercontent.com");
      const secretEntries = (cfg?.secrets ?? "").split(",");
      expect(secretEntries).toContain("GH_TOKEN=ghp_xyz@github.com");
      expect(secretEntries).toContain("GH_TOKEN=ghp_xyz@api.github.com");
      expect(secretEntries.length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("github_token with unset $VAR → expansion silently skipped (no secrets, no network change)", () => {
    const dir = makeLocalConfig(
      "main:\n  github_token: $PROBE_GH_TOKEN_DEFINITELY_UNSET\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.secrets).toBe("");
      expect(cfg?.network).toBe("enabled");
      expect(cfg?.tlsIntercept).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("github_token expansion forces tlsIntercept=true (secrets need MITM on HTTPS)", () => {
    const dir = makeLocalConfig(
      "main:\n  github_token: literal_tok\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.tlsIntercept).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("literal github_token (not $VAR) is used as-is", () => {
    const dir = makeLocalConfig(
      "main:\n  github_token: literal_token_value\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      const secretEntries = (cfg?.secrets ?? "").split(",");
      expect(secretEntries).toContain("GH_TOKEN=literal_token_value@github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("github_hosts overrides the default host list", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  github_token: $PROBE_GH_TOKEN\n" +
      "  github_hosts:\n" +
      "    - github.com\n" +
      "    - api.github.com\n"
    );
    try {
      runHook(dir, { PROBE_GH_TOKEN: "tok" });
      const cfg = readCreateConfig();
      expect((cfg?.network ?? "").split(",")).toEqual(["github.com", "api.github.com"]);
      const secretEntries = (cfg?.secrets ?? "").split(",");
      expect(secretEntries).toEqual([
        "GH_TOKEN=tok@github.com",
        "GH_TOKEN=tok@api.github.com",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("existing network allowlist gets the github hosts unioned in (no duplicates)", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  github_token: $T\n" +
      "  github_hosts:\n" +
      "    - github.com\n" +
      "    - api.github.com\n" +
      "  network: \"github.com,extra.example.com\"\n"
    );
    try {
      runHook(dir, { T: "tok" });
      const cfg = readCreateConfig();
      const domains = (cfg?.network ?? "").split(",");
      expect(domains).toEqual(["github.com", "extra.example.com", "api.github.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("network: disabled + github_token → leaves network disabled (user opted out)", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  github_token: $T\n" +
      "  network: disabled\n"
    );
    try {
      runHook(dir, { T: "tok" });
      const cfg = readCreateConfig();
      expect(cfg?.network).toBe("disabled");
      const secretEntries = (cfg?.secrets ?? "").split(",");
      expect(secretEntries.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-level git_user_name / github_token are respected", () => {
    const dir = makeLocalConfig(
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n" +
      '    git_user_name: "Agent Bot"\n' +
      "    github_token: agent_tok\n"
    );
    try {
      runHook(dir, {}, "test-agent");
      const cfg = readCreateConfig(PER_AGENT_SANDBOX);
      expect(cfg?.gitUserName).toBe("Agent Bot");
      expect((cfg?.secrets ?? "")).toContain("GH_TOKEN=agent_tok@github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env var CC_MSB_MAIN_GIT_USER_NAME overrides the config file", () => {
    const dir = makeLocalConfig(
      "main:\n  git_user_name: \"From File\"\n"
    );
    try {
      runHook(dir, { CC_MSB_MAIN_GIT_USER_NAME: "From Env" });
      const cfg = readCreateConfig();
      expect(cfg?.gitUserName).toBe("From Env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
