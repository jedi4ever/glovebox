import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

// scope=host should bypass the sandbox entirely — tool calls execute on the
// real host. Verified by hitting paths that only exist on the host (macOS)
// and not in the Linux MSB sandbox (e.g. `/Users`).

describe("config — scope=host integration", () => {
  it("main scope=host: bash sees host filesystem (e.g. /Users exists)", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-host-main-", {
      fixture: "config-scope-host-main",
    });
    try {
      const result = await session.run(
        "Run this bash command and report the exact output: `ls /Users 2>&1 | head -1`"
      );
      expect(result.exitCode).toBe(0);
      // The user's home dir name should appear in /Users on macOS host.
      // In a Linux sandbox /Users does not exist (returns "No such file or directory").
      expect(result.stdout).not.toMatch(/no such file|cannot access/i);
    } finally {
      await teardown();
    }
  });

  it("main scope=host: bash uname reports the host OS, not Linux", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-host-uname-", {
      fixture: "config-scope-host-main",
    });
    try {
      const result = await session.run(
        "Run this bash command and report the exact output verbatim: `uname -s`"
      );
      expect(result.exitCode).toBe(0);
      // macOS host reports "Darwin"; the Linux sandbox would report "Linux".
      expect(result.stdout).toMatch(/Darwin/i);
      expect(result.stdout).not.toMatch(/Linux/);
    } finally {
      await teardown();
    }
  });

  it("agent scope=host: the test-agent runs on host while main stays sandboxed", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-host-agent-", {
      fixture: "config-scope-host-agent",
    });
    try {
      const result = await session.run(
        "Use the test-agent to run `uname -s` and report what it says. " +
        "Then run `uname -s` yourself (without the agent) and report what you get. " +
        "Label each output clearly so I can see both."
      );
      expect(result.exitCode).toBe(0);
      // The test-agent (scope=host) reports Darwin.
      // The main session (default scope=session) is in the sandbox → Linux.
      expect(result.stdout).toMatch(/Darwin/i);
      expect(result.stdout).toMatch(/Linux/);
    } finally {
      await teardown();
    }
  });
});
