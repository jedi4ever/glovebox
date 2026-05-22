import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/cc-msb", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.sh");

const SESSION_ID = "unit-config-test-001";
const SANDBOX_NAME = `cc-msb-${SESSION_ID.slice(0, 16)}`;

function runHook(
  hook: string,
  event: object,
  projectDir: string,
  extraEnv: Record<string, string> = {}
) {
  const result = spawnSync("bash", [hook], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
  };
}

function readCreateArgs(sandbox: string): string[] {
  const argsFile = `/tmp/fake-msb-${sandbox}.create-args`;
  if (!existsSync(argsFile)) return [];
  return readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean);
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "cc-msb-config-test-"));
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.create-args`); } catch {}
});

afterEach(() => {
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.state`); } catch {}
  try { rmSync(`/tmp/fake-msb-${SANDBOX_NAME}.create-args`); } catch {}
  try { rmSync(projectDir, { recursive: true }); } catch {}
});

describe("config — mount_workdir", () => {
  it("mounts workdir by default (no config file)", () => {
    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir);

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).toContain("--volume");
  });

  it("mounts workdir when config file sets mount_workdir: true", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: true\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir);

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).toContain("--volume");
  });

  it("does not mount workdir when config file sets mount_workdir: false", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: false\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir);

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).not.toContain("--volume");
  });

  it("env var CC_MSB_MOUNT_WORKDIR=false overrides config file true", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: true\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir, { CC_MSB_MOUNT_WORKDIR: "false" });

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).not.toContain("--volume");
  });

  it("env var CC_MSB_MOUNT_WORKDIR=true overrides config file false", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: false\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir, { CC_MSB_MOUNT_WORKDIR: "true" });

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).toContain("--volume");
  });

  it("config file supports quoted values (mount_workdir: 'false')", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: 'false'\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir);

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).not.toContain("--volume");
  });

  it("config file ignores comments after value", () => {
    writeFileSync(join(projectDir, ".cc-msb.yml"), "mount_workdir: false # disable for CI\n");

    runHook(PRE_HOOK, {
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "echo hi" },
    }, projectDir);

    const args = readCreateArgs(SANDBOX_NAME);
    expect(args).not.toContain("--volume");
  });
});
