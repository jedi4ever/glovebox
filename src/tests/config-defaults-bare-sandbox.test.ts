import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

// Regression test for the reported issue: a `defaults:` block with bare
// `sandbox_image:` + `scope: directory` should be honored by the main
// session. Earlier the user reported seeing `ubuntu` despite setting
// `defaults.sandbox_image: debian`. The hook probe showed the parser was
// correct — the symptom was a stale directory-scoped sandbox left over
// from an earlier ubuntu config. This test exercises a clean run on a
// fresh project dir, so the new image actually takes effect.

function dirSandboxName(dir: string): string {
  return `glovebox-dir-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    const name = dirSandboxName(dir);
    spawnSync("msb", ["stop", name, "--quiet"], { encoding: "utf8" });
    spawnSync("msb", ["remove", name, "--quiet"], { encoding: "utf8" });
  }
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe.concurrent("config — bare defaults.<key> integration", () => {
  it("main session picks up `defaults.sandbox_image: debian` + `defaults.scope: directory`", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-bare-defaults-"));
    await cp(fixturePath("config-defaults-bare"), projectDir, { recursive: true });
    createdDirs.push(projectDir);

    const session = await createCleanSession({ cwd: projectDir });
    try {
      // /etc/os-release on debian contains `ID=debian` and "Debian GNU/Linux".
      // Ubuntu's contains `ID=ubuntu` instead — so the response distinguishes them.
      const r = await session.run(
        "Run the bash command `cat /etc/os-release` and report the exact output verbatim."
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Debian/i);
      expect(r.stdout).not.toMatch(/Ubuntu/i);
    } finally {
      await session.dispose();
    }
  });
});
