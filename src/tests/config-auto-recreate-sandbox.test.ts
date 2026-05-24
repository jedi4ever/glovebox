import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCleanSession } from "../helpers/session.js";

// End-to-end test for the `auto_recreate: true` config drift handling.
//
// Flow:
//   1. Open a CC session against a fresh project dir with auto_recreate=true
//      and a named sandbox (so it persists across config edits).
//   2. Ask Claude to install a marker package + write a marker file. Sync.
//   3. Edit .glovebox.yml to flip a network setting (drift).
//   4. Open a SECOND CC session in the same project. The first tool call
//      detects drift; auto_recreate kicks in and snapshots → recreates the
//      sandbox with the new network policy.
//   5. Verify the marker package + file are STILL there (state preserved)
//      AND a subsequent inspect shows the new network rule.

const SANDBOX_NAME = "glovebox-autorec-it";

afterAll(() => {
  // Belt-and-suspenders cleanup of the named sandbox.
  spawnSync("msb", ["stop", SANDBOX_NAME, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", SANDBOX_NAME, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["snapshot", "remove", `${SANDBOX_NAME}--glovebox-pending`, "--force", "--quiet"], { encoding: "utf8" });
});

async function writeConfig(projectDir: string, networkLine: string) {
  await writeFile(
    join(projectDir, ".glovebox.yml"),
    [
      "main:",
      `  sandbox_image: buildpack-deps:noble`,  // has bash + apt
      `  scope: named`,
      `  sandbox_name: ${SANDBOX_NAME}`,
      `  auto_recreate: true`,
      `  network: ${networkLine}`,
      "",
    ].join("\n")
  );
}

describe.concurrent("config — auto_recreate integration", () => {
  it("on drift: snapshots + recreates with new flags, preserves filesystem state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-autorec-"));

    // Belt-and-suspenders: kill any leftover sandbox from a previous run.
    spawnSync("msb", ["stop", SANDBOX_NAME, "--quiet"], { encoding: "utf8" });
    spawnSync("msb", ["remove", SANDBOX_NAME, "--quiet"], { encoding: "utf8" });

    // --- session 1: install marker + write file -----------------------
    await writeConfig(projectDir, "\"github.com\"");
    const s1 = await createCleanSession({ cwd: projectDir });
    try {
      // buildpack-deps:noble already has many packages preinstalled. We just
      // need a state marker on the filesystem that we can observe surviving
      // the recreate. `sync` is critical — see comment in recreate-sandbox.mjs.
      const r = await s1.run(
        "Run this bash command and report 'OK' when it finishes: " +
        "`echo GLOVEBOX_STATE_BEFORE > /etc/glovebox-mark && sync && echo OK`"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    } finally {
      await s1.dispose();
    }

    // --- edit config to flip network (drift trigger) ------------------
    await writeConfig(projectDir, "\"example.com\"");

    // --- session 2: triggers drift → auto_recreate ----------------------
    const s2 = await createCleanSession({ cwd: projectDir });
    try {
      const r = await s2.run(
        "Run this bash command and report its exact output: " +
        "`cat /etc/glovebox-mark`"
      );
      expect(r.exitCode).toBe(0);
      // State must have survived the recreate.
      expect(r.stdout).toMatch(/GLOVEBOX_STATE_BEFORE/);
    } finally {
      await s2.dispose();
    }

    // The recreated sandbox should now have example.com allowed.
    const inspect = spawnSync("msb", ["inspect", SANDBOX_NAME, "--format", "json"], { encoding: "utf8" });
    expect(inspect.status).toBe(0);
    const parsed = JSON.parse(inspect.stdout);
    const domains: string[] = (parsed?.config?.network?.policy?.rules ?? [])
      .map((r: { destination?: { domain?: string } }) => r.destination?.domain)
      .filter((d: string | undefined): d is string => !!d);
    expect(domains).toContain("example.com");
    expect(domains).not.toContain("github.com");

    await rm(projectDir, { recursive: true, force: true });
  }, 180_000);
});
