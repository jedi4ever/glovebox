import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";
import { removeSandbox } from "../helpers/msb-sdk.js";

const NAMED_SANDBOX = "glovebox-test-named";
const NAMED_AGENT_SANDBOX = "glovebox-test-named-agent";
const NAMED_MAIN_SANDBOX = "glovebox-test-named-main";
const ALL_NAMED = [NAMED_SANDBOX, NAMED_MAIN_SANDBOX, NAMED_AGENT_SANDBOX];

// Clean slate before and after to avoid cross-run interference.
beforeAll(async () => { await Promise.all(ALL_NAMED.map(removeSandbox)); });
afterAll(async () => { await Promise.all(ALL_NAMED.map(removeSandbox)); });

describe.concurrent("config — named scope integration", () => {
  it("named sandbox persists across sessions: state written in session 1 is readable in session 2", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-named-"));
    try {
      await cp(fixturePath("config-named-sandbox"), projectDir, { recursive: true });

      // keepSandbox: true — the named sandbox must survive session1.dispose()
      // so session2 can read from it. afterAll handles the final removal.
      const session1 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
      try {
        const r1 = await session1.run(
          "Run the bash command `echo named_persist > /tmp/glovebox-named-marker.txt` and confirm it ran."
        );
        expect(r1.exitCode).toBe(0);
      } finally {
        await session1.dispose();
      }

      const session2 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
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

      const session1 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
      try {
        const r1 = await session1.run(
          "Use the test-agent to run the bash command " +
          "`echo named_agent_persist > /tmp/glovebox-named-agent-marker.txt` and confirm it ran."
        );
        expect(r1.exitCode).toBe(0);
      } finally {
        await session1.dispose();
      }

      const session2 = await createCleanSession({ cwd: projectDir, keepSandbox: true });
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
