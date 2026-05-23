import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  rmSync, readFileSync, existsSync, readdirSync,
  mkdtempSync, writeFileSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-pres-nst-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function bashEvent() {
  return { tool_name: "Bash", session_id: SESSION_ID, tool_input: { command: "echo hi" } };
}

interface CreateConfig { image: string; network: string; }

function readCreateConfig(): CreateConfig | null {
  const f = `/tmp/fake-msb-${SANDBOX_NAME}.create-args`;
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as CreateConfig; } catch { return null; }
}

function runHook(projectDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("node", [PRE_HOOK], {
    input: JSON.stringify(bashEvent()),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      CC_MSB_FAKE_CREATE: "1",
      CC_MSB_MAIN_SCOPE: "session",
      ...extraEnv,
    },
  });
}

function cleanupFakeMsbFiles() {
  readdirSync("/tmp")
    .filter((f) => f.startsWith(`fake-msb-${SANDBOX_NAME}`) &&
      (f.endsWith(".state") || f.endsWith(".create-args")))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

function makeProject(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-msb-pnst-"));
  writeFileSync(join(dir, ".cc-msb.yml"), yaml);
  return dir;
}

function makeUserPresetsDir(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "cc-msb-pnst-up-"));
  mkdirSync(dir, { recursive: true });
  return { dir, env: { CC_MSB_PRESETS_DIR: dir } };
}

describe("config — presets: network hosts", () => {
  it("github preset sets the standard GitHub network hosts", () => {
    const dir = makeProject("presets: [github]\n");
    try {
      runHook(dir, { CC_MSB_MAIN_GIT_TOKEN_AUTODETECT: "" });
      const cfg = readCreateConfig();
      expect(cfg?.network).toContain("github.com");
      expect(cfg?.network).toContain("api.github.com");
      expect(cfg?.network).toContain("objects.githubusercontent.com");
      expect(cfg?.network).toContain("npm.pkg.github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("npm + github presets union their network hosts", () => {
    const dir = makeProject("presets: [npm, github]\n");
    try {
      runHook(dir, { CC_MSB_MAIN_GIT_TOKEN_AUTODETECT: "" });
      const cfg = readCreateConfig();
      expect(cfg?.network).toContain("registry.npmjs.org");
      expect(cfg?.network).toContain("nodejs.org");
      expect(cfg?.network).toContain("github.com");
      expect(cfg?.network).toContain("npm.pkg.github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dev preset transitively includes npm and github hosts", () => {
    const dir = makeProject("presets: [dev]\n");
    try {
      runHook(dir, { CC_MSB_MAIN_GIT_TOKEN_AUTODETECT: "" });
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("localhost:5123/devbox");
      expect(cfg?.network).toContain("registry.npmjs.org");
      expect(cfg?.network).toContain("nodejs.org");
      expect(cfg?.network).toContain("github.com");
      expect(cfg?.network).toContain("npm.pkg.github.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config — presets: nesting and cycles", () => {
  it("nested preset: parent scalar wins over sub-preset scalar", () => {
    const { dir: presetsDir, env } = makeUserPresetsDir();
    writeFileSync(join(presetsDir, "base.yml"), "defaults:\n  sandbox_image: base-img\n");
    writeFileSync(join(presetsDir, "top.yml"),  "presets: [base]\ndefaults:\n  sandbox_image: top-img\n");
    const dir = makeProject("presets: [top]\n");
    try {
      runHook(dir, env);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("top-img");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });

  it("sub-preset network hosts are merged with parent's own hosts", () => {
    const { dir: presetsDir, env } = makeUserPresetsDir();
    writeFileSync(join(presetsDir, "sub.yml"), "defaults:\n  network: sub.example.com\n");
    writeFileSync(join(presetsDir, "par.yml"), "presets: [sub]\ndefaults:\n  network: par.example.com\n");
    const dir = makeProject("presets: [par]\n");
    try {
      runHook(dir, env);
      const cfg = readCreateConfig();
      expect(cfg?.network).toContain("sub.example.com");
      expect(cfg?.network).toContain("par.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });

  it("cycle in nested presets does not hang (each preset loaded once)", () => {
    const { dir: presetsDir, env } = makeUserPresetsDir();
    writeFileSync(join(presetsDir, "a.yml"), "presets: [b]\ndefaults:\n  sandbox_image: a-img\n");
    writeFileSync(join(presetsDir, "b.yml"), "presets: [a]\ndefaults:\n  network: b.example.com\n");
    const dir = makeProject("presets: [a]\n");
    try {
      runHook(dir, env);
      const cfg = readCreateConfig();
      expect(cfg?.image).toBe("a-img");
      expect(cfg?.network).toContain("b.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(presetsDir, { recursive: true, force: true });
    }
  });
});
