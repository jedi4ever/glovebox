import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

describe.concurrent("config — agent-specific image integration", () => {
  it("uses agent-specific image when test-agent subagent is invoked", async () => {
    const { session, teardown } = await setupScenario("cc-msb-agent-image-", { fixture: "config-agent-image" });
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

  it("falls back to global sandbox_image when no agent-specific image is configured", async () => {
    const { session, teardown } = await setupScenario("cc-msb-agent-image-fallback-");
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
});
