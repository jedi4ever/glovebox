import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

describe("config — mount_workdir integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("project files are visible inside the sandbox by default", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-mount-on-"));
    await writeFile(join(projectDir, "marker.txt"), "project-marker-content");

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to print the contents of /workspace/marker.txt"
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/project-marker-content/i);
  });

  it("project files are not visible when mount_workdir: false", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-mount-off-"));
    await writeFile(join(projectDir, "marker.txt"), "project-marker-content");
    await writeFile(join(projectDir, ".cc-msb.yml"), "mount_workdir: false\n");

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command: does /workspace/marker.txt exist? Answer yes or no."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/project-marker-content/i);
    expect(result.stdout).toMatch(/no|not exist|cannot|doesn.t exist/i);
  });
});
