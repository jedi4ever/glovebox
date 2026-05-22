import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";

// Most tests run concurrently within this file. The "two sessions" test below
// already exercises concurrency internally (Promise.all of two sessions) so we
// run it sequentially to avoid stacking parallelism on top of parallelism.
describe("write-sandbox", () => {
  it.concurrent("writes a VM-only file and reads it back from the sandbox", async () => {
    const session = await createCleanSession();
    try {
      const writeResult = await session.run(
        "Write the text 'cc-msb-write-test' to the file /tmp/cc-msb-write-test.txt"
      );
      expect(writeResult.exitCode).toBe(0);

      const readResult = await session.run(
        "Read the file /tmp/cc-msb-write-test.txt and tell me exactly what it contains. Quote it precisely."
      );
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout).toMatch(/cc-msb-write-test/i);
    } finally {
      await session.dispose();
    }
  });

  // For VM-only path edits, use Bash with sed/echo inside the sandbox instead.
  it.concurrent("write tool creates a VM-only file that bash can then read in the sandbox", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Do these 2 steps in order:\n" +
        "1. Use the Write tool to write the exact text 'hook-written-value\\n' to /tmp/cc-msb-write-sync-test.txt\n" +
        "2. Run bash: `cat /tmp/cc-msb-write-sync-test.txt` and report the exact output.\n" +
        "Label each step's output clearly."
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/hook-written-value/i);
    } finally {
      await session.dispose();
    }
  });

  // Exercises Bash hook (create + update via sandbox), Read hook (shadow sync in both reads).
  // Note: Write-after-Read on the same VM-only path fails CC's "has been read" check because
  // CC tracks the shadow path for Read but checks the original path for Write.
  // The Write hook is exercised separately in the "write hook sync" test.
  it.concurrent("bash creates, read fetches, bash updates, read verifies — all outside workdir", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Do these 4 steps in order, using separate tool calls for each:\n" +
        "1. Run a bash command: `echo initial-value > /tmp/cc-msb-roundtrip.txt`\n" +
        "2. Use the Read tool on /tmp/cc-msb-roundtrip.txt\n" +
        "3. Run a bash command: `echo updated-value > /tmp/cc-msb-roundtrip.txt`\n" +
        "4. Use the Read tool on /tmp/cc-msb-roundtrip.txt again and tell me the exact contents.\n"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/updated-value/i);
    } finally {
      await session.dispose();
    }
  });

  it("two sessions run sandboxes independently without interfering", async () => {
    const [sessionA, sessionB] = await Promise.all([
      createCleanSession(),
      createCleanSession(),
    ]);
    try {
      const [resultA, resultB] = await Promise.all([
        sessionA.run(
          "Write the text 'session-a-value' to /tmp/session-marker.txt, then read it back and tell me what it says."
        ),
        sessionB.run(
          "Write the text 'session-b-value' to /tmp/session-marker.txt, then read it back and tell me what it says."
        ),
      ]);

      expect(resultA.exitCode).toBe(0);
      expect(resultB.exitCode).toBe(0);

      expect(resultA.stdout).toMatch(/session-a-value/i);
      expect(resultB.stdout).toMatch(/session-b-value/i);

      expect(resultA.stdout).not.toMatch(/session-b-value/i);
      expect(resultB.stdout).not.toMatch(/session-a-value/i);
    } finally {
      await Promise.all([sessionA.dispose(), sessionB.dispose()]);
    }
  });
});
