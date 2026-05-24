import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

const NAMED_SANDBOX = "glovebox-test-named";
const NAMED_AGENT_SANDBOX = "glovebox-test-named-agent";

// Remove the named sandboxes after all tests so they don't pollute other runs.
afterAll(() => {
  for (const name of [NAMED_SANDBOX, "glovebox-test-named-main", NAMED_AGENT_SANDBOX]) {
    spawnSync("msb", ["stop", name, "--quiet"], { encoding: "utf8" });
    spawnSync("msb", ["remove", name, "--quiet"], { encoding: "utf8" });
  }
});

describe.concurrent("config — named scope integration", () => {
  it("named sandbox persists across sessions: state written in session 1 is readable in session 2", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-named-"));
    try {
      await cp(fixturePath("config-named-sandbox"), projectDir, { recursive: true });

      // Session 1 — write a marker into the named sandbox
      const session1 = await createCleanSession({ cwd: projectDir });
      try {
        const r1 = await session1.run(
          "Run the bash command `echo named_persist > /tmp/glovebox-named-marker.txt` and confirm it ran."
        );
        expect(r1.exitCode).toBe(0);
      } finally {
        await session1.dispose();
      }

      // Session 2 — a completely separate session; reads the marker from the same named sandbox
      const session2 = await createCleanSession({ cwd: projectDir });
      try {
        const r2 = await session2.run(
          "Run the bash command `cat /tmp/glovebox-named-marker.txt 2>&1` and report the exact output."
        );
        expect(r2.exitCode).toBe(0);
        expect(r2.stdout).toMatch(/named_persist/i);
      } finally {
        await session2.dispose();
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("agent uses its own named sandbox separate from the main session", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-named-agent-"));
    try {
      await cp(fixturePath("config-named-agent-sandbox"), projectDir, { recursive: true });

      // Write a marker into the agent's named sandbox via session 1
      const session1 = await createCleanSession({ cwd: projectDir });
      try {
        const r1 = await session1.run(
          "Use the test-agent to run the bash command " +
          "`echo named_agent_persist > /tmp/glovebox-named-agent-marker.txt` and confirm it ran."
        );
        expect(r1.exitCode).toBe(0);
      } finally {
        await session1.dispose();
      }

      // Session 2 — test-agent reads the marker from the same named agent sandbox
      const session2 = await createCleanSession({ cwd: projectDir });
      try {
        const r2 = await session2.run(
          "Use the test-agent to check the marker file. It will run " +
          "`cat /tmp/glovebox-named-agent-marker.txt 2>&1` and report the output."
        );
        expect(r2.exitCode).toBe(0);
        expect(r2.stdout).toMatch(/named_agent_persist/i);
      } finally {
        await session2.dispose();
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
