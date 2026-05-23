import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, PER_AGENT_SANDBOX, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-dfb-bar-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — bare defaults.<key> (shared baseline)", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-msb-bared-"));
    writeFileSync(join(dir, ".cc-msb.yml"), yaml);
    return dir;
  }

  it("defaults.sandbox_image applies to main session", () => {
    const dir = makeLocalConfig("defaults:\n  sandbox_image: debian\n");
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.sandbox_image applies to agents", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  sandbox_image: debian\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir, {}, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.network applies to both main and agents", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  network: disabled\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()).toContain("--no-net");
      cleanupFakeMsbFiles();
      runHook(dir, {}, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)).toContain("--no-net");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.agents.X beats defaults.X for agents", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  sandbox_image: debian\n" +
      "  agents:\n" +
      "    sandbox_image: alpine\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir, {}, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main.X beats defaults.X for main session", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  sandbox_image: debian\n" +
      "  main:\n" +
      "    sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main.X still beats defaults.X", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  sandbox_image: debian\n" +
      "main:\n" +
      "  sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parser ignores keys nested under defaults.main/defaults.agents when reading defaults.X", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  main:\n" +
      "    sandbox_image: debian\n" +
      "  agents:\n" +
      "    sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.network accepts a YAML list", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  network:\n" +
      "    - one.example.com\n" +
      "    - two.example.com\n" +
      "  main:\n" +
      "    sandbox_image: ubuntu\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args).toContain("allow@one.example.com");
      expect(args).toContain("allow@two.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts `default:` (singular) as a friendly alias for `defaults:`", () => {
    const dir = makeLocalConfig(
      "default:\n" +
      "  sandbox_image: debian\n" +
      "  network:\n" +
      "    - example.com\n"
    );
    try {
      runHook(dir);
      const args = readCreateArgs();
      expect(args[0]).toBe("debian");
      expect(args).toContain("allow@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`default:` alias also works under defaults.main / defaults.agents subsections", () => {
    const dir = makeLocalConfig(
      "default:\n" +
      "  main:\n" +
      "    sandbox_image: debian\n" +
      "  agents:\n" +
      "    sandbox_image: alpine\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("debian");
      cleanupFakeMsbFiles();
      runHook(dir, {}, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.sandbox_image: alpine overrides the built-in ubuntu for both main and agents", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  sandbox_image: alpine\n" +
      "agents:\n" +
      "  test-agent:\n" +
      "    scope: per-agent\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("alpine");
      expect(readCreateArgs()[0]).not.toBe("ubuntu");

      cleanupFakeMsbFiles();
      runHook(dir, {}, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("global defaults.X applies when local file is silent", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "cc-msb-global-"));
    writeFileSync(join(globalDir, "config.yml"), "defaults:\n  sandbox_image: debian\n");
    try {
      runHook(fixturePath("simple-read"), { CC_MSB_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
