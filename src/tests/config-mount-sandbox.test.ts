import { describe, it, expect } from "vitest";
import { writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { setupScenario } from "../helpers/scenario.js";
import { fixturePath } from "../helpers/fixtures.js";

describe.concurrent("config — mount_workdir integration", () => {
  it("project files are visible inside the sandbox by default", async () => {
    const { projectDir, session, teardown } = await setupScenario("glovebox-mount-on-");
    try {
      await writeFile(join(projectDir, "marker.txt"), "project-marker-content");
      const result = await session.run(
        "Run a bash command to print the contents of /workspace/marker.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/project-marker-content/i);
    } finally {
      await teardown();
    }
  });

  it("project files are not visible when mount_workdir: false", async () => {
    const { projectDir, session, teardown } = await setupScenario("glovebox-mount-off-");
    try {
      await writeFile(join(projectDir, "marker.txt"), "project-marker-content");
      await copyFile(fixturePath("config-mount-off", ".glovebox.yml"), join(projectDir, ".glovebox.yml"));
      const result = await session.run(
        "Run a bash command: does /workspace/marker.txt exist? Answer yes or no."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(/project-marker-content/i);
      expect(result.stdout).toMatch(/no|not exist|cannot|doesn.t exist/i);
    } finally {
      await teardown();
    }
  });
});
