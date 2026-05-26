import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";
import { removeSandbox } from "../helpers/msb-sdk.js";

function dirSandboxName(dir: string): string {
  // Must match the prefix set in createCleanSession (GLOVEBOX_SANDBOX_PREFIX=glovebox-test).
  // Resolve symlinks (e.g. macOS /var → /private/var) to match what the plugin computes.
  let resolved = dir; try { resolved = realpathSync(dir); } catch { /* use raw */ }
  return `glovebox-test-dir-${createHash("sha256").update(resolved).digest("hex").slice(0, 12)}`;
}

let createdDirs: string[] = [];

afterAll(async () => {
  await Promise.all(createdDirs.map((dir) => removeSandbox(dirSandboxName(dir))));
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config — directory scope integration", () => {
  it("state written in session 1 is readable in session 2 (same directory)", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-dir-scope-"));
    await cp(fixturePath("config-scope-directory"), projectDir, { recursive: true });
    createdDirs.push(projectDir);

    // Session 1 — write a marker into the directory-scoped sandbox
    const session1 = await createCleanSession({ cwd: projectDir });
    try {
      const r1 = await session1.run(
        "Run the bash command `echo dir_persist > /tmp/glovebox-dir-marker.txt` and confirm it ran."
      );
      expect(r1.exitCode).toBe(0);
    } finally {
      await session1.dispose();
    }

    // Session 2 — completely separate session, same project dir → same sandbox
    const session2 = await createCleanSession({ cwd: projectDir });
    try {
      const r2 = await session2.run(
        "Run the bash command `cat /tmp/glovebox-dir-marker.txt 2>&1` and report the exact output."
      );
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toMatch(/dir_persist/i);
    } finally {
      await session2.dispose();
    }
  });

  it("two different directories use independent sandboxes", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "glovebox-dir-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "glovebox-dir-b-"));
    for (const d of [dirA, dirB]) {
      await cp(fixturePath("config-scope-directory"), d, { recursive: true });
      createdDirs.push(d);
    }

    // Write a marker only in dirA's sandbox
    const sessionA = await createCleanSession({ cwd: dirA });
    try {
      const r = await sessionA.run(
        "Run the bash command `echo dir_a_only > /tmp/glovebox-dir-ab-marker.txt` and confirm it ran."
      );
      expect(r.exitCode).toBe(0);
    } finally {
      await sessionA.dispose();
    }

    // dirB's sandbox should not have the file
    const sessionB = await createCleanSession({ cwd: dirB });
    try {
      const r = await sessionB.run(
        "Run the bash command `cat /tmp/glovebox-dir-ab-marker.txt 2>&1` and report the exact output."
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toMatch(/dir_a_only/i);
    } finally {
      await sessionB.dispose();
    }
  });
});
