import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

describe.concurrent("config — pass_env integration", () => {
  it("default (no config): host env vars do not leak into the sandbox", async () => {
    const { session, teardown } = await setupScenario("cc-msb-passenv-default-", {
      env: { CC_MSB_LEAK_PROBE: "should-not-be-visible" },
    });
    try {
      const result = await session.run(
        "Run a bash command that prints exactly: `value=[${CC_MSB_LEAK_PROBE:-unset}]`. " +
        "Report the exact output."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/value=\[unset\]/);
      expect(result.stdout).not.toMatch(/should-not-be-visible/);
    } finally {
      await teardown();
    }
  });

  it("main.pass_env list: only listed env vars are visible in the sandbox", async () => {
    const { session, teardown } = await setupScenario("cc-msb-passenv-list-", {
      fixture: "config-pass-env-list",
      env: {
        TEST_PASS_ENV_VAR: "passed-through",
        SECOND_VAR: "also-passed",
        UNRELATED_VAR: "should-not-leak",
      },
    });
    try {
      const result = await session.run(
        "Run a single bash command that prints exactly: " +
        "`first=[${TEST_PASS_ENV_VAR:-unset}] second=[${SECOND_VAR:-unset}] unrelated=[${UNRELATED_VAR:-unset}]`. " +
        "Report the exact output."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/first=\[passed-through\]/);
      expect(result.stdout).toMatch(/second=\[also-passed\]/);
      expect(result.stdout).toMatch(/unrelated=\[unset\]/);
      expect(result.stdout).not.toMatch(/should-not-leak/);
    } finally {
      await teardown();
    }
  });

  it("main.pass_env: all — every host env var is visible in the sandbox", async () => {
    const { session, teardown } = await setupScenario("cc-msb-passenv-all-", {
      fixture: "config-pass-env-all",
      env: { ARBITRARY_HOST_VAR: "arbitrary-value" },
    });
    try {
      const result = await session.run(
        "Run a bash command that prints exactly: `marker=[${ARBITRARY_HOST_VAR:-unset}]`. " +
        "Report the exact output."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/marker=\[arbitrary-value\]/);
    } finally {
      await teardown();
    }
  });
});
