import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

describe.concurrent("config — scope integration", () => {
  it("default (no config): main and agent share the same sandbox", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-default-", { fixture: "config-scope-default" });
    try {
      const result = await session.run(
        "Do these steps in order. " +
        "Step 1: run a bash command `echo shared_sandbox_test > /tmp/glovebox-shared.txt`. " +
        "Step 2: use the test-agent to run `cat /tmp/glovebox-shared.txt 2>&1` and report the exact output."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/shared_sandbox_test/i);
    } finally {
      await teardown();
    }
  });

  it("per-agent: main session uses the global sandbox image (ubuntu)", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-pa-main-", { fixture: "config-scope-per-agent-image" });
    try {
      const result = await session.run(
        "Run a bash command to read /etc/os-release and tell me what NAME= says."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ubuntu/i);
    } finally {
      await teardown();
    }
  });

  it("per-agent: test-agent subagent gets its own sandbox with its configured image (debian)", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-pa-agent-", { fixture: "config-scope-per-agent-image" });
    try {
      const result = await session.run(
        "Use the test-agent to check what OS its sandbox is running. " +
        "Ask it to run `cat /etc/os-release` and report what the NAME= line says."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/debian/i);
    } finally {
      await teardown();
    }
  });

  it("session scope: file written in one bash call is readable in the next", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-sess-", { fixture: "config-scope-session" });
    try {
      const result = await session.run(
        "Execute these as two separate bash tool calls. " +
        "First: `echo scope_test > /tmp/glovebox-marker.txt`. " +
        "Second: `cat /tmp/glovebox-marker.txt 2>&1`. " +
        "Report the exact output of the second command."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/scope_test/i);
    } finally {
      await teardown();
    }
  });

  it("per-run scope: file written in one agent bash call is gone in the next", async () => {
    const { session, teardown } = await setupScenario("glovebox-scope-perrun-", { fixture: "config-scope-per-run" });
    try {
      const result = await session.run(
        "Use the test-agent. It will make two separate bash calls and report " +
        "the output of the second one."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(/scope_test/i);
    } finally {
      await teardown();
    }
  });
});
