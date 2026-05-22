import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

function dirSandboxName(dir: string): string {
  return `cc-msb-dir-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

let createdDirs: string[] = [];

afterAll(async () => {
  // Remove any directory-scoped sandboxes created during the tests
  for (const dir of createdDirs) {
    const name = dirSandboxName(dir);
    spawnSync("msb", ["stop", name, "--quiet"], { encoding: "utf8" });
    spawnSync("msb", ["remove", name, "--quiet"], { encoding: "utf8" });
  }
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe.concurrent("config — directory scope integration", () => {
  it("state written in session 1 is readable in session 2 (same directory)", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cc-msb-dir-scope-"));
    await cp(fixturePath("config-scope-directory"), projectDir, { recursive: true });
    createdDirs.push(projectDir);

    // Session 1 — write a marker into the directory-scoped sandbox
    const session1 = await createCleanSession({ cwd: projectDir });
    try {
      const r1 = await session1.run(
        "Run the bash command `echo dir_persist > /tmp/cc-msb-dir-marker.txt` and confirm it ran."
      );
      expect(r1.exitCode).toBe(0);
    } finally {
      await session1.dispose();
    }

    // Session 2 — completely separate session, same project dir → same sandbox
    const session2 = await createCleanSession({ cwd: projectDir });
    try {
      const r2 = await session2.run(
        "Run the bash command `cat /tmp/cc-msb-dir-marker.txt 2>&1` and report the exact output."
      );
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toMatch(/dir_persist/i);
    } finally {
      await session2.dispose();
    }
  });

  it("two different directories use independent sandboxes", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "cc-msb-dir-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "cc-msb-dir-b-"));
    for (const d of [dirA, dirB]) {
      await cp(fixturePath("config-scope-directory"), d, { recursive: true });
      createdDirs.push(d);
    }

    // Write a marker only in dirA's sandbox
    const sessionA = await createCleanSession({ cwd: dirA });
    try {
      const r = await sessionA.run(
        "Run the bash command `echo dir_a_only > /tmp/cc-msb-dir-ab-marker.txt` and confirm it ran."
      );
      expect(r.exitCode).toBe(0);
    } finally {
      await sessionA.dispose();
    }

    // dirB's sandbox should not have the file
    const sessionB = await createCleanSession({ cwd: dirB });
    try {
      const r = await sessionB.run(
        "Run the bash command `cat /tmp/cc-msb-dir-ab-marker.txt 2>&1` and report the exact output."
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toMatch(/dir_a_only/i);
    } finally {
      await sessionB.dispose();
    }
  });
});
