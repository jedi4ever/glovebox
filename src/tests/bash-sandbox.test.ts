import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";

describe.concurrent("bash sandboxing", () => {
  it("executes bash commands inside an MSB sandbox", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Run this exact bash command and show me the full output: cat /etc/os-release"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/alpine/i);
    } finally {
      await session.dispose();
    }
  });

  it("sandbox is isolated from the host — host-only paths are not accessible", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Run this bash command and tell me what it outputs: ls /Users 2>&1 || echo 'NO_USERS_DIR'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/NO_USERS_DIR|no such file|cannot access/i);
    } finally {
      await session.dispose();
    }
  });
});
