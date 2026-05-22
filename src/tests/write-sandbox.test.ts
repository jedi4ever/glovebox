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
