import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
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

  it("uses agent-specific image when agent_type matches config", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-agent-image-"));
    await copyFile(
      fixturePath("config-agent-image", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir, agentType: "test-agent" });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/debian/i);
  });

  it("falls back to global sandbox_image for an unlisted agent type", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-agent-image-fallback-"));
    await copyFile(
      fixturePath("config-agent-image", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir, agentType: "other-agent" });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ubuntu/i);
  });
});
