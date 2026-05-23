import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

// End-to-end test for the `git_*` / `github_*` config sections.
//
// `git_user_name` / `git_user_email` are applied via `git config --global`
// inside the guest right after `createDetached`, so the values should be
// readable by any subsequent Bash call.
//
// We use buildpack-deps:noble (curl + git preinstalled) for a fast probe.

describe.concurrent("git + github integration", () => {
  it("git_user_name / git_user_email are visible via `git config --global --get`", async () => {
    const { session, teardown } = await setupScenario("cc-msb-git-id-", {
      fixture: "config-git-identity",
    });
    try {
      const result = await session.run(
        "Run this exact bash command and report the output verbatim, no commentary: " +
        "`bash -c 'git config --global --get user.name; git config --global --get user.email'`"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Probe Bot/);
      expect(result.stdout).toMatch(/probe@example\.com/);
    } finally {
      await teardown();
    }
  });
});
