import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";

// Verifies the SessionStart `session-start.sh` hook actually shapes Claude's
// notion of its environment. After the hook runs, when asked about the OS,
// Claude should report Linux/Ubuntu (the sandbox), not Darwin (the host).

describe.concurrent("session-start integration", () => {
  it("OS-level info (operating system) reflects the sandbox, not the host", async () => {
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
