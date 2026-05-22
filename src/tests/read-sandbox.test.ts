import { describe, it, expect } from "vitest";
import { createCleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe.concurrent("read sandboxing", () => {
  it("reads a file in the project workdir without going through the sandbox", async () => {
    const file = fixturePath("simple-read", "file.txt");
    const session = await createCleanSession();
    try {
      const result = await session.run(
        `Read the file ${file} and tell me exactly what it contains. Quote it precisely.`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/hello from fixture/i);
    } finally {
      await session.dispose();
    }
  });

  it("reads a VM-only file from inside the sandbox, not from the host", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Read the file /etc/os-release and tell me exactly what NAME= and VERSION_ID= say."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ubuntu/i);
    } finally {
      await session.dispose();
    }
  });
});
