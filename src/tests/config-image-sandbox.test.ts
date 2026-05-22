import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe("config — sandbox_image integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("sandbox runs on the default ubuntu image when no config file is present", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-image-default-"));

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ubuntu/i);
  });

  it("sandbox runs on the image specified in the config file (debian)", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-image-config-"));
    await copyFile(
      fixturePath("config-image-debian", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/debian/i);
  });

  it("sandbox runs on the image specified in the config file (alpine)", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-image-alpine-"));
    await copyFile(
      fixturePath("config-image-alpine", ".cc-msb.yml"),
      join(projectDir, ".cc-msb.yml")
    );

    session = await createCleanSession({ cwd: projectDir });
    const result = await session.run(
      "Run a bash command to read /etc/os-release and tell me what NAME= says."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/alpine/i);
  });
});
