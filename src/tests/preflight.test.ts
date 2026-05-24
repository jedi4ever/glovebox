import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

function pathWithout(binary: string): string {
  let binaryPath: string;
  try {
    binaryPath = execSync(`which ${binary}`, { encoding: "utf8" }).trim();
  } catch {
    return process.env["PATH"] ?? "";
  }
  const binaryDir = binaryPath.split("/").slice(0, -1).join("/");
  return (process.env["PATH"] ?? "")
    .split(":")
    .filter((dir) => dir !== binaryDir)
    .join(":");
}

describe("preflight — required software check", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("starts successfully when node, jq, and msb are all installed", async () => {
    session = await createCleanSession();
    const result = await session.run("say hello");
    expect(result.exitCode).toBe(0);
  });

  it("warns in session context when msb is not on PATH", async () => {
    session = await createCleanSession({ env: { PATH: pathWithout("msb") } });
    const result = await session.run(
      "What does glovebox say about its sandbox status? Just report what you see in context."
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/missing|disabled|WARNING/i);
  });
});
