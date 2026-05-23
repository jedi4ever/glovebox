import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { setupScenario } from "../helpers/scenario.js";

// Probe the developer's host once at module load: is `gh` logged in
// AND is there a `git config --global user.name/email`? Used to skip
// the autodetect-driven test on machines that lack these prerequisites
// (CI, fresh laptops). We don't care about the token VALUE here — only
// that the host *has* one we can later autodetect.
function hostReadyForAutodetect(): { ready: boolean; reason: string } {
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status !== 0 || !(gh.stdout || "").trim()) {
    return { ready: false, reason: "no `gh auth token` on host" };
  }
  const name = spawnSync("git", ["config", "--global", "--get", "user.name"], { encoding: "utf8" });
  if (name.status !== 0 || !(name.stdout || "").trim()) {
    return { ready: false, reason: "no `git config --global user.name`" };
  }
  const email = spawnSync("git", ["config", "--global", "--get", "user.email"], { encoding: "utf8" });
  if (email.status !== 0 || !(email.stdout || "").trim()) {
    return { ready: false, reason: "no `git config --global user.email`" };
  }
  return { ready: true, reason: "" };
}
const host = hostReadyForAutodetect();

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

  // Autodetect path — host's `gh auth token` should reach the sandbox via
  // msb's secret proxy, and host's `git config --global` should be applied
  // inside the guest. Skipped automatically on machines without those.
  (host.ready ? it.concurrent : it.concurrent.skip)(
    `autodetect (host has gh+git config): GH_TOKEN proxies to api.github.com, git identity applies inside${host.ready ? "" : ` — SKIPPED: ${host.reason}`}`,
    async () => {
      const { session, teardown } = await setupScenario("cc-msb-gh-host-auth-", {
        fixture: "config-git-autodetect-probe",
        // setup.ts globally disables autodetect for unit-test stability.
        // Re-enable here so this integration probe actually exercises it.
        env: {
          CC_MSB_MAIN_GIT_USER_AUTODETECT: "true",
          CC_MSB_MAIN_GIT_TOKEN_AUTODETECT: "true",
        },
      });
      try {
        // 1. Verify the plumbing end-to-end: the secret-proxy substituted
        //    GH_TOKEN with *some* real value before the request hit
        //    api.github.com. We DON'T assert that the auth succeeds —
        //    the token's validity is a host-side `gh` concern, not the
        //    plugin's. What we DO assert:
        //      (a) curl reached api.github.com and got a JSON response
        //          (proves network allowlist worked).
        //      (b) the response does NOT contain the literal placeholder
        //          string `$MSB_GH_TOKEN` (proves msb substituted —
        //          GitHub would echo it back in some error responses if
        //          we'd sent it verbatim).
        //      (c) the response isn't the auth-header-missing error
        //          ("Requires authentication") — that would mean nothing
        //          got injected into the Authorization header.
        const r1 = await session.run(
          "Run this exact bash command and report only the JSON body, no commentary, " +
          "don't print the bearer token value: " +
          "`curl -sS -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/user 2>&1 | head -40`"
        );
        expect(r1.exitCode).toBe(0);
        expect(r1.stdout).toMatch(/"(?:login|message)":\s*"/);  // got a JSON response
        expect(r1.stdout).not.toMatch(/\$MSB_GH_TOKEN/);         // not the placeholder
        expect(r1.stdout).not.toMatch(/Requires authentication/i); // header was injected

        // 2. Host git identity flows through.
        const r2 = await session.run(
          "Run this exact bash command and report only its output verbatim: " +
          "`bash -c 'git config --global --get user.name && git config --global --get user.email'`"
        );
        expect(r2.exitCode).toBe(0);
        // Don't pin to the user's actual identity — just verify both
        // lines are non-empty (autodetect populated them).
        const lines = r2.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        // The output usually contains a leading "Output:" frame from
        // Claude; the *contents* are at least 2 non-empty lines that
        // aren't just markdown fences or commentary.
        const dataLines = lines.filter((l) => !/^[`>*-]/.test(l) && !/^Output/.test(l));
        expect(dataLines.length).toBeGreaterThanOrEqual(2);
      } finally {
        await teardown();
      }
    },
    60_000
  );
});
