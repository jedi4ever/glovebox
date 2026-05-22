import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe("config — scope integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  // per-agent: each agent type gets its own sandbox (verified via distinct OS images)

  it("per-agent: main session uses the global sandbox image", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-pa-main-"));
    await copyFile(
      fixturePath("config-scope-per-agent-image", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ubuntu/i);
  });

  it("per-agent: agent gets its own sandbox with its configured image", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-pa-agent-"));
    await copyFile(
      fixturePath("config-scope-per-agent-image", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir, agentType: "test-agent" });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/debian/i);
  });

  // session: bash state persists between calls (baseline for ephemeral comparison)

  it("session scope: file written in one bash call is readable in the next", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-sess-"));
    await copyFile(
      fixturePath("config-scope-session", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir, agentType: "test-agent" });
    const result = await session.run(
      "Execute these as two separate bash tool calls. " +
      "First: `echo scope_test > /tmp/cc-msb-marker.txt`. " +
      "Second: `cat /tmp/cc-msb-marker.txt 2>&1`. " +
      "Report the exact output of the second command."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/scope_test/i);
  });

  // ephemeral: each agent bash call gets a fresh sandbox — no state carries over

  it("ephemeral scope: file written in one bash call is gone in the next", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-scope-ephem-"));
    await copyFile(
      fixturePath("config-scope-ephemeral", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir, agentType: "test-agent" });
    const result = await session.run(
      "Execute these as two separate bash tool calls. " +
      "First: `echo scope_test > /tmp/cc-msb-marker.txt`. " +
      "Second: `cat /tmp/cc-msb-marker.txt 2>&1`. " +
      "Report the exact output of the second command."
    );

    expect(result.exitCode).toBe(0);
    // In ephemeral mode the second sandbox is fresh — the file does not exist
    expect(result.stdout).not.toMatch(/scope_test/i);
  });
});
