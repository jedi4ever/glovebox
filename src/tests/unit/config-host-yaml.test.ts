import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext, PLUGIN_ROOT, FAKE_MSB_DIR, PRE_HOOK, wrappedCommand, DEFAULT_IMAGE as DEFAULT } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, SANDBOX_NAME, PER_AGENT_SANDBOX, SESSION_ID, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-hst-yml-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — scope: host", () => {
  it("main scope=host: Bash hook passes through (no rewrite, no sandbox create)", () => {
    const r = runHook(fixturePath("config-scope-host-main"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("agent scope=host: Bash hook for that agent passes through; main still sandboxed", () => {
    const rAgent = runHook(fixturePath("config-scope-host-agent"), {}, "test-agent");
    expect(rAgent.status).toBe(0);
    expect(rAgent.stdout.trim()).toBe("");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);

    const rMain = runHook(fixturePath("config-scope-host-agent"));
    expect(rMain.status).toBe(0);
    expect(readCreateArgs(SANDBOX_NAME)).toContain(DEFAULT);
  });

  it("GLOVEBOX_MAIN_SCOPE=host forces pass-through even without a config file", () => {
    const r = runHook(fixturePath("simple-read"), { GLOVEBOX_MAIN_SCOPE: "host" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
  });

  it("GLOVEBOX_AGENT_SCOPE_<NAME>=host forces pass-through for that agent", () => {
    const r = runHook(
      fixturePath("simple-read"),
      { GLOVEBOX_AGENT_SCOPE_TEST_AGENT: "host" },
      "test-agent"
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).toHaveLength(0);
  });

  it("scope=host bypasses Read hook too (no shadow sync)", () => {
    const result = spawnSync("node", [PRE_HOOK], {
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
  });
});

describe("config — YAML block-list syntax", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "glovebox-list-"));
    writeFileSync(join(dir, ".glovebox.yml"), yaml);
    return dir;
  }

  it("main.network accepts a YAML list", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  network:\n" +
      "    - example.com\n" +
      "    - api.github.com\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@example.com");
      expect(args).toContain("allow@api.github.com");
      expect(args.filter((a) => a === "--net-rule")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.network list with quoted items strips the quotes", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  network:\n" +
      '    - "example.com"\n' +
      "    - 'api.github.com'\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@example.com");
      expect(args).toContain("allow@api.github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.network list ignores inline comments on item lines", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  network:\n" +
      "    - example.com  # primary\n" +
      "    - api.github.com\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@example.com");
      expect(args).toContain("allow@api.github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.agents.network accepts a YAML list", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  agents:\n" +
      "    network:\n" +
      "      - allowed-a.example.com\n" +
      "      - allowed-b.example.com\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@allowed-a.example.com");
      expect(args).toContain("allow@allowed-b.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agents.<name>.network accepts a YAML list", () => {
    const dir = makeLocalConfig(
      "agents:\n" +
      "  test-agent:\n" +
      "    network:\n" +
      "      - agent-only.example.com\n" +
      "      - shared.example.com\n"
    );
    try {
      runHook(dir, {}, "test-agent");
      const args = readCreateArgs();
      expect(args).toContain("allow@agent-only.example.com");
      expect(args).toContain("allow@shared.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.pass_env accepts a YAML list", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  pass_env:\n" +
      "    - LIST_VAR_A\n" +
      "    - LIST_VAR_B\n"
    );
    try {
      const r = runHook(dir, { LIST_VAR_A: "alpha", LIST_VAR_B: "beta", UNRELATED: "gamma" });
      expect(r.status).toBe(0);
      const cmd = wrappedCommand(r.stdout);
      expect(cmd).toMatch(/LIST_VAR_A=alpha/);
      expect(cmd).toMatch(/LIST_VAR_B=beta/);
      expect(cmd).not.toMatch(/UNRELATED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.ports accepts a YAML list with quoted items preserving colons", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  ports:\n" +
      '    - "8080:80"\n' +
      "    - 5432:5432/tcp\n" +
      "    - 9229:9229/udp\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args.filter((a) => a === "--port")).toHaveLength(3);
      expect(args).toContain("8080:80");
      expect(args).toContain("5432:5432/tcp");
      expect(args).toContain("9229:9229/udp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inline string and list forms produce identical network rules", () => {
    const inlineDir = makeLocalConfig(
      'main:\n  network: "one.example.com,two.example.com"\n'
    );
    const listDir = makeLocalConfig(
      "main:\n  network:\n    - one.example.com\n    - two.example.com\n"
    );
    const netRulesOnly = (args: string[]) =>
      args.filter((a) => a === "--net-rule" || a.startsWith("allow@"));
    try {
      runHook(inlineDir);
      const inlineRules = netRulesOnly(readCreateArgs());
      cleanupFakeMsbFiles();
      runHook(listDir);
      const listRules = netRulesOnly(readCreateArgs());
      expect(listRules).toEqual(inlineRules);
      expect(listRules).toEqual([
        "--net-rule", "allow@one.example.com",
        "--net-rule", "allow@two.example.com",
      ]);
    } finally {
      rmSync(inlineDir, { recursive: true, force: true });
      rmSync(listDir, { recursive: true, force: true });
    }
  });

  it("list tolerates blank lines and comment-only lines between items", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  network:\n" +
      "    # Ubuntu / Debian apt\n" +
      "    - archive.ubuntu.com\n" +
      "    - deb.debian.org\n" +
      "\n" +
      "    # GitHub\n" +
      "    - github.com\n" +
      "    - api.github.com   # REST API\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@archive.ubuntu.com");
      expect(args).toContain("allow@deb.debian.org");
      expect(args).toContain("allow@github.com");
      expect(args).toContain("allow@api.github.com");
      expect(args.filter((a) => a === "--net-rule")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list with no items (key on its own line, nothing follows) falls back to default", () => {
    const dir = makeLocalConfig(
      "main:\n" +
      "  network:\n" +
      "  sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).not.toContain("--no-net");
      expect(args).not.toContain("--net-rule");
      expect(args[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
