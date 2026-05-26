import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";

// Regression test for the uid/passwd issue: when the default Microsoft
// devcontainer image is used with no config, the sandbox process runs as the
// host UID (e.g. 501). applyHostUser() remaps the container's primary
// non-root user to that UID so /etc/passwd has an entry for it — without
// which sudo fails with "you do not exist in the passwd database".

describe("default image — sudo and package manager access", () => {
  it("sudo apt-get update succeeds with no .glovebox.yml config", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Run the bash command `sudo apt-get update -qq 2>&1 | tail -3` and report the exact output."
      );
      expect(result.exitCode).toBe(0);
      // Should not see the passwd/sudo error.
      expect(result.stdout).not.toMatch(/do not exist in the passwd/i);
      expect(result.stdout).not.toMatch(/Permission denied/i);
    } finally {
      await session.dispose();
    }
  });

  it("id command shows a named user (not just a numeric uid)", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Run the bash command `id` and report the exact output."
      );
      expect(result.exitCode).toBe(0);
      // When the UID is in /etc/passwd the username appears; if not, id shows
      // just the number with no parenthesised name for uid=.
      expect(result.stdout).toMatch(/uid=\d+\(\w/);
    } finally {
      await session.dispose();
    }
  });
});
