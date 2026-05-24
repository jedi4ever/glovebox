import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, SANDBOX_NAME, PER_AGENT_SANDBOX, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-dfm-mna-001");

const DEFAULTS_NAMED_PREFIXES = ["glovebox-global-named", "glovebox-local-named", "glovebox-global-agent"];
function cleanupDefaultsNamedFiles() {
  readdirSync("/tmp")
    .filter((f) => (f.endsWith(".state") || f.endsWith(".create-args")) &&
      DEFAULTS_NAMED_PREFIXES.some((p) => f.startsWith(`fake-msb-${p}`)))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => { cleanupFakeMsbFiles(); cleanupDefaultsNamedFiles(); });
afterEach(() => { cleanupFakeMsbFiles(); cleanupDefaultsNamedFiles(); });

describe("config — defaults.main block", () => {
  function makeLocalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "glovebox-defmain-"));
    writeFileSync(join(dir, ".glovebox.yml"), yaml);
    return dir;
  }

  it("defaults.main.sandbox_image applies to main when main.sandbox_image is unset", () => {
    const dir = makeLocalConfig("defaults:\n  main:\n    sandbox_image: debian\n");
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main does NOT apply to agents", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  main:\n" +
      "    sandbox_image: debian\n" +
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

  it("main.X overrides defaults.main.X", () => {
    const dir = makeLocalConfig(
      "defaults:\n  main:\n    sandbox_image: debian\n" +
      "main:\n  sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main.X beats defaults.agents.X for main session", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  main:\n    sandbox_image: debian\n" +
      "  agents:\n    sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main works for network setting", () => {
    const dir = makeLocalConfig(
      "defaults:\n" +
      "  main:\n    network: disabled\n" +
      "  agents:\n    network: enabled\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs()).toContain("--no-net");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main.sandbox_name + main.scope=named work together", () => {
    const dir = makeLocalConfig(
      "defaults:\n  main:\n    sandbox_name: glovebox-global-named\n" +
      "main:\n  scope: named\n"
    );
    try {
      runHook(dir);
      expect(readCreateArgs("glovebox-global-named")).toContain("ubuntu");
      expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults.main in global file applies when local is silent", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "glovebox-global-"));
    writeFileSync(join(globalDir, "config.yml"), "defaults:\n  main:\n    sandbox_image: debian\n");
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("local main.X overrides global defaults.main.X", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "glovebox-global-"));
    writeFileSync(join(globalDir, "config.yml"), "defaults:\n  main:\n    sandbox_image: debian\n");
    const localDir = makeLocalConfig("main:\n  sandbox_image: alpine\n");
    try {
      runHook(localDir, { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("alpine");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});

describe("config — global config file", () => {
  function makeGlobalConfig(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "glovebox-global-"));
    writeFileSync(join(dir, "config.yml"), yaml);
    return dir;
  }

  it("reads settings from the global config when no local file exists", () => {
    const globalDir = makeGlobalConfig("main:\n  sandbox_image: debian\n");
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("local config file overrides the global file", () => {
    const globalDir = makeGlobalConfig("main:\n  sandbox_image: alpine\n");
    try {
      runHook(fixturePath("config-image-debian"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("env var beats both local and global config", () => {
    const globalDir = makeGlobalConfig("main:\n  sandbox_image: alpine\n");
    try {
      runHook(
        fixturePath("config-image-debian"),
        { GLOVEBOX_CONFIG_DIR: globalDir, GLOVEBOX_SANDBOX_IMAGE: "node:20" }
      );
      expect(readCreateArgs()[0]).toBe("node:20");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("global defaults.agents.X applies when local file is silent", () => {
    const globalDir = makeGlobalConfig(
      "defaults:\n  agents:\n    mount_workdir: false\n"
    );
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()).not.toContain("--volume");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("local defaults.agents.X wins over global main.X (local file is a full layer)", () => {
    const globalDir = makeGlobalConfig("main:\n  sandbox_image: alpine\n");
    const localDir = mkdtempSync(join(tmpdir(), "glovebox-local-"));
    writeFileSync(join(localDir, ".glovebox.yml"), "defaults:\n  agents:\n    sandbox_image: debian\n");
    try {
      runHook(localDir, { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()[0]).toBe("debian");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("global main.sandbox_name + main.scope=named is honored when local is silent", () => {
    const globalDir = makeGlobalConfig(
      "main:\n  scope: named\n  sandbox_name: glovebox-global-named\n"
    );
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs("glovebox-global-named")).toContain("ubuntu");
      expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("local main.sandbox_name overrides global main.sandbox_name", () => {
    const globalDir = makeGlobalConfig(
      "main:\n  scope: named\n  sandbox_name: glovebox-global-named\n"
    );
    const localDir = mkdtempSync(join(tmpdir(), "glovebox-local-"));
    writeFileSync(join(localDir, ".glovebox.yml"), "main:\n  scope: named\n  sandbox_name: glovebox-local-named\n");
    try {
      runHook(localDir, { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs("glovebox-local-named")).toContain("ubuntu");
      expect(readCreateArgs("glovebox-global-named")).toHaveLength(0);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("global agents.<name>.X applies when no local override", () => {
    const globalDir = makeGlobalConfig(
      "agents:\n  test-agent:\n    scope: per-agent\n    sandbox_image: alpine\n"
    );
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir }, "test-agent");
      expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
      expect(readCreateArgs(SANDBOX_NAME)).toHaveLength(0);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("global agents.<name>.sandbox_name is honored for named scope", () => {
    const globalDir = makeGlobalConfig(
      "agents:\n  test-agent:\n    scope: named\n    sandbox_name: glovebox-global-agent\n"
    );
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir }, "test-agent");
      expect(readCreateArgs("glovebox-global-agent")).toContain("ubuntu");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("missing global config dir is a no-op (defaults still apply)", () => {
    runHook(fixturePath("simple-read"), {
      GLOVEBOX_CONFIG_DIR: join(tmpdir(), "glovebox-does-not-exist-xyz"),
    });
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("global main.network=disabled applies when local is silent", () => {
    const globalDir = makeGlobalConfig("main:\n  network: disabled\n");
    try {
      runHook(fixturePath("simple-read"), { GLOVEBOX_CONFIG_DIR: globalDir });
      expect(readCreateArgs()).toContain("--no-net");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("local main.network overrides global main.network", () => {
    const globalDir = makeGlobalConfig("main:\n  network: disabled\n");
    try {
      runHook(fixturePath("config-network-allowlist"), { GLOVEBOX_CONFIG_DIR: globalDir });
      const args = readCreateArgs();
      expect(args).not.toContain("--no-net");
      expect(args).toContain("allow@example.com");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
