import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe("config — agent-specific image integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("uses agent-specific image when test-agent subagent is invoked", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-agent-image-"));
    await cp(fixturePath("config-agent-image"), projectDir, { recursive: true });

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Use the test-agent to check what OS its sandbox is running. " +
      "Ask it to run `cat /etc/os-release` and report what the NAME= line says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/debian/i);
  });

  it("falls back to global sandbox_image when no agent-specific image is configured", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-agent-image-fallback-"));

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ubuntu/i);
  });
});
