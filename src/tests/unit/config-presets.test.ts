import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  rmSync, readFileSync, existsSync, readdirSync,
  mkdtempSync, writeFileSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-presets-001";
const SANDBOX_NAME = `glovebox-${SESSION_ID.slice(0, 16)}`;

function bashEvent(agentType?: string) {
  return {
    tool_name: "Bash",
    session_id: SESSION_ID,
    ...(agentType ? { agent_type: agentType } : {}),
    tool_input: { command: "echo hi" },
  };
}

interface CreateConfig {
  sandboxName: string;
  image: string;
  projectDir: string;
  mountWorkdir: boolean;
  network: string;
  ports: string;
  secrets: string;
  tlsIntercept: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
}

function readCreateConfig(name: string = SANDBOX_NAME): CreateConfig | null {
  const f = `/tmp/fake-msb-${name}.create-args`;
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as CreateConfig; } catch { return null; }
}

function runHook(
  projectDir: string,
  extraEnv: Record<string, string> = {},
  agentType?: string
) {
  return spawnSync("node", [PRE_HOOK], {
    input: JSON.stringify(bashEvent(agentType)),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      GLOVEBOX_FAKE_CREATE: "1",
      // Pin scope to `session` so the sandbox name is predictable
      // regardless of what the preset sets (the `dev` preset uses
      // `scope: directory` which would derive a hash-based name).
      // Individual tests can still override via extraEnv.
      GLOVEBOX_MAIN_SCOPE: "session",
      ...extraEnv,
    },
  });
}

function cleanupFakeMsbFiles() {
  readdirSync("/tmp")
    .filter((f) =>
      f.startsWith(`fake-msb-${SANDBOX_NAME}`) &&
      (f.endsWith(".state") || f.endsWith(".create-args")))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

function makeProject(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "glovebox-preset-"));
  writeFileSync(join(dir, ".glovebox.yml"), yaml);
  return dir;
}

// Builds an isolated user-presets directory and returns env vars that
// point the hook at it. Built-in presets remain available via
// CLAUDE_PLUGIN_ROOT (set in runHook above).
function makeUserPresetsDir(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "glovebox-userpresets-"));
  mkdirSync(dir, { recursive: true });
  return { dir, env: { GLOVEBOX_PRESETS_DIR: dir } };
}

describe("config — presets", () => {
  it("built-in preset `dev` provides defaults when main is silent", () => {
    const dir = makeProject("presets: [dev]\n");
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("localhost:5123/devbox");
      expect(cfg?.mountWorkdir).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("user-explicit main: always wins over preset", () => {
    const dir = makeProject(
      "presets: [dev]\n" +
      "main:\n  sandbox_image: alpine\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      // dev preset says localhost:5123/devbox; main: overrides to alpine
      expect(cfg?.image).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("user-explicit defaults: wins over preset (presets are weakest defaults)", () => {
    const dir = makeProject(
      "presets: [dev]\n" +
      "defaults:\n  sandbox_image: debian\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env var still beats preset (top of the chain unchanged)", () => {
    const dir = makeProject("presets: [dev]\n");
    try {
      runHook(dir, { GLOVEBOX_SANDBOX_IMAGE: "alpine" });
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("alpine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inline list syntax `[a, b]` parses correctly", () => {
    const dir = makeProject("presets: [dev, npm]\n");
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      // dev → devbox image; npm (direct + via dev) → registry hosts
      expect(cfg?.image).toBe("localhost:5123/devbox");
      expect(cfg?.network).toContain("registry.npmjs.org");
      expect(cfg?.network).toContain("nodejs.org");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("block list syntax `- a\\n- b` parses correctly", () => {
    const dir = makeProject(
      "presets:\n  - dev\n  - npm\n"
    );
    try {
      runHook(dir);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("localhost:5123/devbox");
      expect(cfg?.network).toContain("registry.npmjs.org");
      expect(cfg?.network).toContain("nodejs.org");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("later preset wins for scalar keys (e.g. sandbox_image)", () => {
    // Two presets set the same SCALAR key. Last-listed wins.
    const { dir: presetsDir, env } = makeUserPresetsDir();
    writeFileSync(join(presetsDir, "first.yml"),  "defaults:\n  sandbox_image: first-img\n");
    writeFileSync(join(presetsDir, "second.yml"), "defaults:\n  sandbox_image: second-img\n");
    const projectDir = makeProject("presets: [first, second]\n");
    try {
      runHook(projectDir, env);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("second-img");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });

  it("user preset dir overrides built-in of the same name", () => {
    const { dir: presetsDir, env } = makeUserPresetsDir();
    writeFileSync(
      join(presetsDir, "dev.yml"),
      "defaults:\n  sandbox_image: customboximage\n"
    );
    const projectDir = makeProject("presets: [dev]\n");
    try {
      runHook(projectDir, env);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("customboximage");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });

  it("unknown preset name is silently skipped (no error, no value contributed)", () => {
    const dir = makeProject("presets: [definitely-not-a-real-preset]\n");
    try {
      const r = runHook(dir);
      // Hook should still succeed; image falls back to built-in default.
      expect(r.status).toBe(0);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("ubuntu");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GLOVEBOX_PRESETS env var overrides the file-declared list", () => {
    const { dir: presetsDir, env: presetsEnv } = makeUserPresetsDir();
    // "custom" preset sets a distinct image so we can prove it was NOT loaded
    writeFileSync(join(presetsDir, "custom.yml"), "defaults:\n  sandbox_image: custom-img\n");
    const dir = makeProject("presets: [custom]\n");  // file says custom
    try {
      runHook(dir, { ...presetsEnv, GLOVEBOX_PRESETS: "dev" });  // env says dev
      const cfg = readCreateConfig();
      // dev's image wins; custom-img must NOT appear → env replaced the list
      expect(cfg?.image).toBe("localhost:5123/devbox");
      expect(cfg?.image).not.toBe("custom-img");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });

});
