import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession } from "../helpers/session.js";
import { removeSandbox, removeSnapshot, getSandboxConfigJson } from "../helpers/msb-sdk.js";

// End-to-end test for the `auto_recreate: true` config drift handling.
//
// Flow:
//   1. Open a CC session against a fresh project dir with auto_recreate=true
//      and a named sandbox (so it persists across config edits).
//   2. Ask Claude to write a marker file. Sync.
//   3. Edit .glovebox.yml to flip a network setting (drift).
//   4. Open a SECOND CC session in the same project. The first tool call
//      detects drift; auto_recreate kicks in and snapshots → recreates the
//      sandbox with the new network policy.
//   5. Verify the marker file is STILL there (state preserved) AND the new
//      network rule is reflected in the sandbox config.

const SANDBOX_NAME = "glovebox-test-autorec-it";

beforeAll(async () => {
  await removeSandbox(SANDBOX_NAME);
  await removeSnapshot(`${SANDBOX_NAME}--glovebox-pending`);
});
afterAll(async () => {
  await removeSandbox(SANDBOX_NAME);
  await removeSnapshot(`${SANDBOX_NAME}--glovebox-pending`);
});

async function writeConfig(projectDir: string, networkLine: string) {
  await writeFile(
    join(projectDir, ".glovebox.yml"),
    [
      "main:",
      `  sandbox_image: buildpack-deps:noble`,
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

    // Ensure clean state at test start (belt-and-suspenders on top of beforeAll).
    await removeSandbox(SANDBOX_NAME);

    // --- session 1: write marker -----------------------------------------
    await writeConfig(projectDir, "\"github.com\"");
    const s1 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
    try {
      const r = await s1.run(
        "Run this bash command and report 'OK' when it finishes: " +
        "`echo GLOVEBOX_STATE_BEFORE > /etc/glovebox-mark && sync && echo OK`"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    } finally {
      await s1.dispose();
    }

    // --- edit config to trigger drift ------------------------------------
    await writeConfig(projectDir, "\"example.com\"");

    // --- session 2: auto_recreate fires ---------------------------------
    const s2 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
    try {
      const r = await s2.run(
        "Run this bash command and report its exact output: `cat /etc/glovebox-mark`"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/GLOVEBOX_STATE_BEFORE/);
    } finally {
      await s2.dispose();
    }

    // Verify the recreated sandbox now has example.com in its network policy.
    const cfgJson = await getSandboxConfigJson(SANDBOX_NAME);
    const cfg = cfgJson ? JSON.parse(cfgJson) : null;
    const domains: string[] = (cfg?.network?.policy?.rules ?? [])
      .map((r: { destination?: { domain?: string } }) => r.destination?.domain)
      .filter((d: string | undefined): d is string => !!d);
    expect(domains).toContain("example.com");
    expect(domains).not.toContain("github.com");

    await rm(projectDir, { recursive: true, force: true });
  }, 180_000);
});
