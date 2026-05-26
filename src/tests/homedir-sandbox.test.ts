import { describe, it, expect } from "vitest";
import { homedir, userInfo } from "node:os";
import { createCleanSession } from "../helpers/session.js";

// Claude Code's system prompt leaks the host user's name, home directory, and
// working directory. The SessionStart hook injects an override block so
// questions about user / home / cwd resolve to the sandbox's values instead.
// These tests verify the override actually steers Claude's answers — without
// hard-coding any host-specific values.

const HOST_USER = userInfo().username;
const HOST_HOME = homedir();

describe("sandbox home & working directory info", () => {
  it("home directory reported reflects the sandbox, not the host's home", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "What is your home directory? Answer with just the absolute path, no extra commentary. " +
        "Do not run any tool calls — answer from the environment context you already have."
      );
      expect(result.exitCode).toBe(0);
      // Whatever the sandbox reports — explicitly NOT the host's home directory.
      expect(result.stdout).not.toContain(HOST_HOME);
    } finally {
      await session.dispose();
    }
  });

  it("user/name reported is the sandbox user, not the host user", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "What user are you running as? Just the username or UID. " +
        "Do not run any tool calls — answer from the environment context."
      );
      expect(result.exitCode).toBe(0);
      // The sandbox runs as the host UID mapped into the container. The host
      // username (e.g. "patrickdebois") should not appear in Claude's answer
      // because the context override replaces the host environment block.
      if (HOST_USER && HOST_USER !== "root") {
        expect(result.stdout).not.toMatch(new RegExp(HOST_USER, "i"));
      }
    } finally {
      await session.dispose();
    }
  });

  it("working directory reported reflects the sandbox (/workspace), not the host project dir", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "What is your current working directory? Answer with just the absolute path. " +
        "Do not run any tool calls — answer from the environment context."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\/workspace/);
      expect(result.stdout).not.toContain(HOST_HOME);
    } finally {
      await session.dispose();
    }
  });
});
