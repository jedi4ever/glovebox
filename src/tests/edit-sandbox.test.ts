import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession } from "../helpers/session.js";

// The glovebox hook blocks Edit and MultiEdit for ALL files — even bind-mounted
// project-dir files — and redirects the agent to use Bash instead.  This keeps
// every write inside the sandbox's filesystem view.
//
// CC's own "File does not exist" guard fires for VM-only paths (/tmp/, /etc/,
// etc.) BEFORE our hook is invoked, so the block comes from CC there.
// For project-dir files the block comes from our PreToolUse deny.

describe("edit sandboxing", () => {
  it("Edit on a project-dir (bind-mounted) file is blocked — agent falls back to Bash", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "glovebox-edit-proj-"));
    const session = await createCleanSession({ cwd: projectDir });
    try {
      const result = await session.run(
        "Do these 3 steps in order, using separate tool calls:\n" +
        "1. Run a bash command: `echo original > ./glovebox-edit-probe-proj.txt`\n" +
        "2. Use the Edit tool on ./glovebox-edit-probe-proj.txt to replace 'original' with 'edited'. " +
        "If it fails, note the error and use Bash to make the change instead.\n" +
        "3. Run a bash command: `cat ./glovebox-edit-probe-proj.txt` and report the exact output.\n" +
        "Clean up at the end with: `rm -f ./glovebox-edit-probe-proj.txt`."
      );

      expect(result.exitCode).toBe(0);
      // The agent must have fallen back to Bash — the file should contain 'edited'.
      expect(result.stdout).toMatch(/edited/i);
    } finally {
      await session.dispose();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("VM-only Edit is blocked by CC with 'File does not exist'", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Do these 3 steps in order, using separate tool calls:\n" +
        "1. Run a bash command: `echo original-vm-content > /tmp/glovebox-edit-vm-only.txt`\n" +
        "2. Use the Edit tool on /tmp/glovebox-edit-vm-only.txt to replace 'original-vm-content' with 'edited-vm-content'. " +
        "If it fails, quote the exact error message verbatim and continue.\n" +
        "3. Run a bash command: `cat /tmp/glovebox-edit-vm-only.txt` and report the exact output."
      );

      expect(result.exitCode).toBe(0);
      // Edit must not have applied — the sandbox file is unchanged.
      expect(result.stdout).toMatch(/original-vm-content/);
      expect(result.stdout).not.toMatch(/edited-vm-content/);
      // CC's standard "File does not exist" should appear in step 2's quoted output.
      expect(result.stdout).toMatch(/file does not exist/i);
    } finally {
      await session.dispose();
    }
  });

  // Without an explicit instruction to use any specific tool, the SessionStart
  // hint ("Edit is not available for files inside the sandbox — use Bash to edit
  // them.") should steer the agent to use Bash and succeed on the first try.
  it("with the hint, an agent modifies a sandbox file successfully", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Run these 3 steps in order:\n" +
        "1. Create /tmp/glovebox-hint-probe.txt containing exactly 'initial-value'.\n" +
        "2. Change the file's contents to 'final-value'.\n" +
        "3. Run a bash command to cat /tmp/glovebox-hint-probe.txt and report the exact output."
      );

      expect(result.exitCode).toBe(0);
      // The agent successfully modified the sandbox file — step 3's cat shows the new content.
      expect(result.stdout).toMatch(/final-value/);
    } finally {
      await session.dispose();
    }
  });
});
