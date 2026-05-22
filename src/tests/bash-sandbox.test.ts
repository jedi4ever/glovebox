import { describe, it, expect, afterEach } from "vitest";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

describe("bash sandboxing", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("executes bash commands inside an MSB sandbox", async () => {
    session = await createCleanSession();
    const result = await session.run(
      "Run this exact bash command and show me the full output: cat /etc/os-release"
    );
    expect(result.exitCode).toBe(0);
    // /etc/os-release inside the ubuntu MSB sandbox differs from macOS host
    expect(result.stdout).toMatch(/ubuntu/i);
  });

  it("sandbox is isolated from the host — host-only paths are not accessible", async () => {
    session = await createCleanSession();
    const result = await session.run(
      "Run this bash command and tell me what it outputs: ls /Users 2>&1 || echo 'NO_USERS_DIR'"
    );
    expect(result.exitCode).toBe(0);
    // /Users does not exist inside a Linux MSB sandbox
    expect(result.stdout).toMatch(/NO_USERS_DIR|no such file|cannot access/i);
  });
});
