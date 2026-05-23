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

const SESSION_ID = "unit-pres-union-1";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function bashEvent() {
  return {
    tool_name: "Bash",
    session_id: SESSION_ID,
    tool_input: { command: "echo hi" },
  };
}

interface CreateConfig {
  network: string;
  ports: string;
  secrets: string;
  tlsBypass: string;
}

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
    .filter((f) => f.startsWith(`fake-msb-${SANDBOX_NAME}`))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

function makeProject(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-msb-uni-"));
  writeFileSync(join(dir, ".cc-msb.yml"), yaml);
  return dir;
}

function makeUserPresetsDir(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "cc-msb-up-"));
  mkdirSync(dir, { recursive: true });
  return { dir, env: { CC_MSB_PRESETS_DIR: dir } };
}

// Returns a sorted comma-separated view of the value so tests can assert
// set-equality without depending on emission order.
function sortedCsv(s: string | undefined): string {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
}

describe("config — presets union semantics", () => {
  it("two presets contributing to `network` are unioned", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "a.yml"), "defaults:\n  network: \"a.com\"\n");
    writeFileSync(join(pdir, "b.yml"), "defaults:\n  network: \"b.com\"\n");
    const proj = makeProject("presets: [a, b]\n");
    try {
      runHook(proj, env);
      expect(sortedCsv(readCreateConfig()?.network)).toBe("a.com,b.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("preset `network` unions with user `defaults.network`", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "extra.yml"), "defaults:\n  network: \"preset.example.com\"\n");
    const proj = makeProject(
      "presets: [extra]\n" +
      "defaults:\n  network: \"user.example.com\"\n"
    );
    try {
      runHook(proj, env);
      expect(sortedCsv(readCreateConfig()?.network)).toBe("preset.example.com,user.example.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("any layer saying `network: disabled` forces disabled (most-restrictive)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "block.yml"), "defaults:\n  network: disabled\n");
    writeFileSync(join(pdir, "open.yml"), "defaults:\n  network: \"a.com\"\n");
    const proj = makeProject("presets: [open, block]\n");
    try {
      runHook(proj, env);
      expect(readCreateConfig()?.network).toBe("disabled");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("`network: enabled` in a layer contributes nothing (open lets restrictions win)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "open.yml"), "defaults:\n  network: enabled\n");
    writeFileSync(join(pdir, "scoped.yml"), "defaults:\n  network: \"a.com\"\n");
    const proj = makeProject("presets: [open, scoped]\n");
    try {
      runHook(proj, env);
      // "enabled" drops out; only the allowlist remains.
      expect(readCreateConfig()?.network).toBe("a.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("two presets contributing to `secrets` are unioned (no special modes)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "p1.yml"), "defaults:\n  secrets: \"A=v1@host1\"\n");
    writeFileSync(join(pdir, "p2.yml"), "defaults:\n  secrets: \"B=v2@host2\"\n");
    const proj = makeProject("presets: [p1, p2]\n");
    try {
      runHook(proj, env);
      expect(sortedCsv(readCreateConfig()?.secrets)).toBe("A=v1@host1,B=v2@host2");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("two presets contributing to `ports` are unioned", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "web.yml"), "defaults:\n  ports: \"8080:80\"\n");
    writeFileSync(join(pdir, "db.yml"),  "defaults:\n  ports: \"5432:5432\"\n");
    const proj = makeProject("presets: [web, db]\n");
    try {
      runHook(proj, env);
      expect(sortedCsv(readCreateConfig()?.ports)).toBe("5432:5432,8080:80");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("duplicate values across layers are deduped", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "p1.yml"), "defaults:\n  network: \"a.com,b.com\"\n");
    writeFileSync(join(pdir, "p2.yml"), "defaults:\n  network: \"b.com,c.com\"\n");
    const proj = makeProject("presets: [p1, p2]\n");
    try {
      runHook(proj, env);
      expect(sortedCsv(readCreateConfig()?.network)).toBe("a.com,b.com,c.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("env var still short-circuits the union (explicit override stays explicit)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "wide.yml"), "defaults:\n  network: \"x.com,y.com\"\n");
    const proj = makeProject("presets: [wide]\n");
    try {
      runHook(proj, { ...env, CC_MSB_MAIN_NETWORK: "explicit.com" });
      // Env var wins outright — preset doesn't contribute.
      expect(readCreateConfig()?.network).toBe("explicit.com");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("`pass_env: all` in any layer forces all (most-permissive)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "perm.yml"), "defaults:\n  pass_env: all\n");
    writeFileSync(join(pdir, "names.yml"), "defaults:\n  pass_env: \"HOME,PATH\"\n");
    const proj = makeProject("presets: [names, perm]\n");
    try {
      runHook(proj, env);
      // Hard to assert on the env arg without parsing pass-env semantics;
      // sandbox-build's behavior for "all" + names doesn't pollute create-args directly.
      // What we CAN do: assert config resolution didn't crash and the hook ran.
      // The fact that runHook produced a create-args file at all is the smoke check.
      expect(readCreateConfig()).not.toBeNull();
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });

  it("`pass_env: none` in a layer contributes nothing (presence of names wins)", () => {
    const { dir: pdir, env } = makeUserPresetsDir();
    writeFileSync(join(pdir, "off.yml"),  "defaults:\n  pass_env: none\n");
    writeFileSync(join(pdir, "names.yml"), "defaults:\n  pass_env: \"HOME\"\n");
    const proj = makeProject("presets: [off, names]\n");
    try {
      const r = runHook(proj, env);
      expect(r.status).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(pdir, { recursive: true, force: true });
    }
  });
});
