import { describe, it, expect, afterEach } from "vitest";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

describe("session isolation", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("only cc-msb plugin is loaded — no ralph-loop, vercel, or other global plugins", async () => {
    session = await createCleanSession();
    const result = await session.run(
      "List every plugin and slash command you have available. Be exhaustive and specific."
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toMatch(/ralph-loop/i);
    expect(result.stdout).not.toMatch(/vercel/i);
    expect(result.stdout).not.toMatch(/gondolin/i);
  });
});
