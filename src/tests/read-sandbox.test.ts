import { describe, it, expect, afterEach } from "vitest";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe("read sandboxing", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("reads a file in the project workdir without going through the sandbox", async () => {
    const file = fixturePath("simple-read", "file.txt");
    session = await createCleanSession();
    const result = await session.run(
      `Read the file ${file} and tell me exactly what it contains. Quote it precisely.`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/hello from fixture/i);
  });

  it("reads a VM-only file from inside the sandbox, not from the host", async () => {
    session = await createCleanSession();
    const result = await session.run(
      "Read the file /etc/os-release and tell me exactly what NAME= and VERSION_ID= say."
    );
    expect(result.exitCode).toBe(0);
    // /etc/os-release does not exist on macOS; if we see Ubuntu it came from the sandbox
    expect(result.stdout).toMatch(/ubuntu/i);
  });
});
