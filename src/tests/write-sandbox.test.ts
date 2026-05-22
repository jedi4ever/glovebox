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

describe("edit sandboxing", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("bash creates a file, write appends, edit updates, read verifies — all outside workdir", async () => {
    session = await createCleanSession();

    const result = await session.run(
      "Do these 4 steps in order using separate tool calls:\n" +
      "1. Run bash: `echo original-line > /tmp/cc-msb-edit-test.txt`\n" +
      "2. Use the Write tool to write the text 'written-line\\n' to /tmp/cc-msb-edit-test.txt\n" +
      "3. Use the Edit tool to replace 'written-line' with 'edited-line' in /tmp/cc-msb-edit-test.txt\n" +
      "4. Read /tmp/cc-msb-edit-test.txt and report the exact contents.\n" +
      "Label each step's output clearly."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/edited-line/i);
    expect(result.stdout).not.toMatch(/written-line/i);
  });
});

describe("full hook round-trip", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("bash creates, read fetches, write updates, read verifies — all outside workdir", async () => {
    session = await createCleanSession();

    // All four steps in one session so they share the same sandbox.
    // Exercises Bash hook (create), Read hook (shadow sync in), Write hook
    // (shadow sync out via post-tool-use), Read hook again (re-sync).
    const result = await session.run(
      "Do these 4 steps in order, using separate tool calls for each:\n" +
      "1. Run a bash command: `echo initial-value > /tmp/cc-msb-roundtrip.txt`\n" +
      "2. Use the Read tool on /tmp/cc-msb-roundtrip.txt and report the exact contents.\n" +
      "3. Use the Write tool to write the exact text 'updated-value\\n' to /tmp/cc-msb-roundtrip.txt\n" +
      "4. Use the Read tool on /tmp/cc-msb-roundtrip.txt again and report the exact contents.\n" +
      "Label each step's output clearly."
    );

    expect(result.exitCode).toBe(0);
    // Step 2 should show the original content
    expect(result.stdout).toMatch(/initial-value/i);
    // Step 4 should show the updated content
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
