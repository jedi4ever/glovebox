import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { setupScenario } from "../helpers/scenario.js";

// Probe the developer's host once at module load. The autodetect tests
// require three things on the host:
//   1. `gh auth token` returns a non-empty token
//   2. `git config --global` has user.name + user.email set
//   3. the `localhost:5123/glovebox` image is pulled into msb (it
//      provides `gh` inside the guest — `buildpack-deps:noble` doesn't)
// On a fresh laptop or CI without these, the tests skip with a reason.
function hostReadyForAutodetect(): { ready: boolean; reason: string; token: string } {
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = (gh.stdout || "").trim();
  if (gh.status !== 0 || !token) {
    return { ready: false, reason: "no `gh auth token` on host", token: "" };
  }
  const name = spawnSync("git", ["config", "--global", "--get", "user.name"], { encoding: "utf8" });
  if (name.status !== 0 || !(name.stdout || "").trim()) {
    return { ready: false, reason: "no `git config --global user.name`", token };
  }
  const email = spawnSync("git", ["config", "--global", "--get", "user.email"], { encoding: "utf8" });
  if (email.status !== 0 || !(email.stdout || "").trim()) {
    return { ready: false, reason: "no `git config --global user.email`", token };
  }
  const imgs = spawnSync("msb", ["images"], { encoding: "utf8" });
  if (imgs.status !== 0 || !/localhost:5123\/glovebox/.test(imgs.stdout || "")) {
    return { ready: false, reason: "`localhost:5123/glovebox` image not in `msb images` (run `cd contrib && make all` first)", token };
  }
  return { ready: true, reason: "", token };
}
const host = hostReadyForAutodetect();

// Defensive guard: any captured test output that ever contains the
// real host token is a leak. The host token only lives in the test
// runner's memory here — never passed as env to the child claude
// process — so the only way it could appear in Claude's stdout is if
// msb's proxy substituted it AND something inside the guest echoed
// the substituted value back. Both are bugs.
const REAL_HOST_TOKEN = host.token;
function assertNoTokenLeak(stdout: string) {
  if (REAL_HOST_TOKEN && stdout.includes(REAL_HOST_TOKEN)) {
    throw new Error("TOKEN LEAK: real host gh token appeared in test output");
  }
}

// End-to-end test for the `git_*` / `github_*` config sections.
//
// `git_user_name` / `git_user_email` are applied via `git config --global`
// inside the guest right after `createDetached`, so the values should be
// readable by any subsequent Bash call.
//
// We use buildpack-deps:noble (curl + git preinstalled) for a fast probe.

describe.concurrent("git + github integration", () => {
  it("git_user_name / git_user_email are visible via `git config --global --get`", async () => {
    const { session, teardown } = await setupScenario("glovebox-git-id-", {
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
  // inside the guest. All three tests below skip on machines without
  // those prerequisites.
  const itAuto = host.ready ? it.concurrent : it.concurrent.skip;
  const autoEnv = {
    // setup.ts globally disables autodetect for unit-test stability;
    // re-enable here to actually exercise the path.
    GLOVEBOX_MAIN_GIT_USER_AUTODETECT: "true",
    GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT: "true",
  };
  const skipNote = host.ready ? "" : ` — SKIPPED: ${host.reason}`;

  itAuto(
    `autodetect: GH_TOKEN reaches api.github.com via the proxy (raw curl)${skipNote}`,
    async () => {
      const { session, teardown } = await setupScenario("glovebox-gh-curl-", {
        fixture: "config-git-autodetect-probe",
        env: autoEnv,
      });
      try {
        // End-to-end probe: msb's secret proxy must (1) preserve the
        // `$MSB_GH_TOKEN` placeholder in the env var, (2) MITM-decrypt
        // the HTTPS request, and (3) substitute the placeholder with the
        // real token. We assert a 200 response with a `"login":` field —
        // a literal placeholder leaking through would 401 with "Bad
        // credentials" (which `"(?:login|message)":` would *also* match,
        // so we have to be specific). The prompt forbids echoing
        // $GH_TOKEN; assertNoTokenLeak below is the backstop.
        const r = await session.run(
          "Run this exact bash command and report ONLY the response body — " +
          "NOT the command itself, NOT any header values, NOT the value of $GH_TOKEN: " +
          "`curl -sS -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/user 2>&1 | head -40`"
        );
        assertNoTokenLeak(r.stdout);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/"login":\s*"/);                 // 200 OK with /user JSON
        expect(r.stdout).not.toMatch(/Bad credentials/i);          // not 401
        expect(r.stdout).not.toMatch(/\$MSB_GH_TOKEN/);            // not the placeholder
        expect(r.stdout).not.toMatch(/Requires authentication/i);  // header was injected
      } finally {
        await teardown();
      }
    },
    60_000
  );

  itAuto(
    `autodetect: \`gh auth status\` succeeds inside the sandbox${skipNote}`,
    async () => {
      const { session, teardown } = await setupScenario("glovebox-gh-auth-status-", {
        fixture: "config-git-autodetect-probe",
        env: autoEnv,
      });
      try {
        // Realistic-usage probe — requires gh to read GH_TOKEN, send a
        // request through the proxy, AND github to accept the substituted
        // token. Strictly stronger than the raw-curl test above. `gh auth
        // status` masks the token (`gho_*****…`) in its own output so
        // a leak here would have to come from gh printing the env var
        // verbatim, which it doesn't.
        const r = await session.run(
          "Run this exact bash command and report ONLY its combined output verbatim. " +
          "Do NOT print the value of $GH_TOKEN or expand it in any way: " +
          "`gh auth status 2>&1`"
        );
        assertNoTokenLeak(r.stdout);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/Logged in to github\.com/i);
        expect(r.stdout).not.toMatch(/\$MSB_GH_TOKEN/);
        expect(r.stdout).not.toMatch(/not logged into|You are not logged/i);
      } finally {
        await teardown();
      }
    },
    60_000
  );

  itAuto(
    `autodetect: host's git config --global user.name/email flow into the sandbox${skipNote}`,
    async () => {
      const { session, teardown } = await setupScenario("glovebox-git-identity-auto-", {
        fixture: "config-git-autodetect-probe",
        env: autoEnv,
      });
      try {
        const r = await session.run(
          "Run this exact bash command and report only its output verbatim: " +
          "`bash -c 'git config --global --get user.name && git config --global --get user.email'`"
        );
        expect(r.exitCode).toBe(0);
        // Don't pin to the user's identity — just assert two non-empty
        // data lines, which proves autodetect populated both.
        const dataLines = r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !/^[`>*-]/.test(l) && !/^Output/i.test(l));
        expect(dataLines.length).toBeGreaterThanOrEqual(2);
      } finally {
        await teardown();
      }
    },
    60_000
  );
});
