import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

async function copyFixture(name: string, dest: string) {
  await cp(fixturePath(name), dest, { recursive: true });
}

describe("config — scope integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  // default: no config → session scope → main and agents share the same sandbox

  it("default (no config): main and agent share the same sandbox", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-default-"));

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Do these steps in order. " +
      "Step 1: run a bash command `echo shared_sandbox_test > /tmp/cc-msb-shared.txt`. " +
      "Step 2: use the test-agent to run `cat /tmp/cc-msb-shared.txt 2>&1` and report the exact output."
    );

    expect(result.exitCode).toBe(0);
    // The agent can read the file written by main — they share the same sandbox
    expect(result.stdout).toMatch(/shared_sandbox_test/i);
  });

  // per-agent: each agent type gets its own sandbox, verified via distinct OS images

  it("per-agent: main session uses the global sandbox image (ubuntu)", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-pa-main-"));
    await copyFixture("config-scope-per-agent-image", projectDir);

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ubuntu/i);
  });

  it("per-agent: test-agent subagent gets its own sandbox with its configured image (debian)", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-pa-agent-"));
    await copyFixture("config-scope-per-agent-image", projectDir);

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Use the test-agent to check what OS its sandbox is running. " +
      "Ask it to run `cat /etc/os-release` and report what the NAME= line says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/debian/i);
  });

  // session: state persists between bash calls (baseline for ephemeral comparison)

  it("session scope: file written in one bash call is readable in the next", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-sess-"));
    await copyFixture("config-scope-session", projectDir);

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Execute these as two separate bash tool calls. " +
      "First: `echo scope_test > /tmp/cc-msb-marker.txt`. " +
      "Second: `cat /tmp/cc-msb-marker.txt 2>&1`. " +
      "Report the exact output of the second command."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/scope_test/i);
  });

  // per-run: each agent bash call gets a fresh sandbox — no state carries over

  it("per-run scope: file written in one agent bash call is gone in the next", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-perrun-"));
    await copyFixture("config-scope-per-run", projectDir);

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Use the test-agent. It will make two separate bash calls and report " +
      "the output of the second one."
    );

    expect(result.exitCode).toBe(0);
    // In per-run mode each bash call gets a fresh sandbox, so the file is gone
    expect(result.stdout).not.toMatch(/scope_test/i);
  });
});
