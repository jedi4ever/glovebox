import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";

// Verifies that OS-level info Claude reports reflects the sandbox, not the
// host. The SessionStart hook (scripts/session-start.sh) introspects the
// sandbox and injects an additionalContext block; the assertion below is the
// end-to-end check that the block actually steers Claude's answer.

describe.concurrent("sandbox OS-level info", () => {
  it("operating system reported reflects the sandbox, not the host", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "What operating system are you running on? Answer in one short sentence. " +
        "Do not run any tool calls — just tell me based on the environment context you already have."
      );
      expect(result.exitCode).toBe(0);
      // Sandbox is Ubuntu/Linux → answer should reflect that.
      expect(result.stdout).toMatch(/ubuntu|linux/i);
      // Not the host (Darwin/macOS).
      expect(result.stdout).not.toMatch(/darwin|macos/i);
    } finally {
      await session.dispose();
    }
  });
});
