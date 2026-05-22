import { describe, it, expect, afterEach } from "vitest";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

describe("write sandboxing", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("writes a VM-only file and reads it back from the sandbox", async () => {
    session = await createCleanSession();

    const writeResult = await session.run(
      "Write the text 'cc-msb-write-test' to the file /tmp/cc-msb-write-test.txt"
    );
    expect(writeResult.exitCode).toBe(0);

    const readResult = await session.run(
      "Read the file /tmp/cc-msb-write-test.txt and tell me exactly what it contains. Quote it precisely."
    );
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stdout).toMatch(/cc-msb-write-test/i);
  });
});

describe("write hook sync", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  // CC's Edit tool checks file existence on the host BEFORE the PreToolUse hook fires,
  // so Edit on VM-only paths (/tmp, /etc, ...) cannot be hook-redirected.
  // For VM-only path edits, use Bash with sed/echo inside the sandbox instead.
  it("write tool creates a VM-only file that bash can then read in the sandbox", async () => {
    session = await createCleanSession();

    const result = await session.run(
      "Do these 2 steps in order:\n" +
      "1. Use the Write tool to write the exact text 'hook-written-value\\n' to /tmp/cc-msb-write-sync-test.txt\n" +
      "2. Run bash: `cat /tmp/cc-msb-write-sync-test.txt` and report the exact output.\n" +
      "Label each step's output clearly."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/hook-written-value/i);
  });
});

describe("full hook round-trip", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  // Exercises Bash hook (create + update via sandbox), Read hook (shadow sync in both reads).
  // Note: Write-after-Read on the same VM-only path fails CC's "has been read" check because
  // CC tracks the shadow path for Read but checks the original path for Write.
  // The Write hook is exercised separately in the "write hook sync" test.
  it("bash creates, read fetches, bash updates, read verifies — all outside workdir", async () => {
    session = await createCleanSession();

    const result = await session.run(
      "Do these 4 steps in order, using separate tool calls for each:\n" +
      "1. Run a bash command: `echo initial-value > /tmp/cc-msb-roundtrip.txt`\n" +
      "2. Use the Read tool on /tmp/cc-msb-roundtrip.txt\n" +
      "3. Run a bash command: `echo updated-value > /tmp/cc-msb-roundtrip.txt`\n" +
      "4. Use the Read tool on /tmp/cc-msb-roundtrip.txt again and tell me the exact contents.\n"
    );

    expect(result.exitCode).toBe(0);
    // Step 4 must show the updated content — proving Bash hook (×2) + Read hook (×2) all fired
    expect(result.stdout).toMatch(/updated-value/i);
  });
});

describe("concurrent sessions", () => {
  let sessionA: CleanSession | undefined;
  let sessionB: CleanSession | undefined;

  afterEach(async () => {
    await Promise.all([sessionA?.dispose(), sessionB?.dispose()]);
  });

  it("two sessions run sandboxes independently without interfering", async () => {
    [sessionA, sessionB] = await Promise.all([
      createCleanSession(),
      createCleanSession(),
    ]);

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

    // Each session should see only its own value
    expect(resultA.stdout).toMatch(/session-a-value/i);
    expect(resultB.stdout).toMatch(/session-b-value/i);

    // Sessions must not bleed into each other
    expect(resultA.stdout).not.toMatch(/session-b-value/i);
    expect(resultB.stdout).not.toMatch(/session-a-value/i);
  });
});
