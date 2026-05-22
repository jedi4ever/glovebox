import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession } from "../helpers/session.js";
import { fixturePath } from "../helpers/fixtures.js";

describe("config — pass_env integration", () => {
  let session: CleanSession | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await session?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("default (no config): host env vars do not leak into the sandbox", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-passenv-default-"));

    session = await createCleanSession({
      cwd: projectDir,
      env: { CC_MSB_LEAK_PROBE: "should-not-be-visible" },
    });
    const result = await session.run(
      "Run a bash command that prints exactly: `value=[${CC_MSB_LEAK_PROBE:-unset}]`. " +
      "Report the exact output."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/value=\[unset\]/);
    expect(result.stdout).not.toMatch(/should-not-be-visible/);
  });

  it("main.pass_env list: only listed env vars are visible in the sandbox", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-passenv-list-"));
    await cp(fixturePath("config-pass-env-list"), projectDir, { recursive: true });

    session = await createCleanSession({
      cwd: projectDir,
      env: {
        TEST_PASS_ENV_VAR: "passed-through",
        SECOND_VAR: "also-passed",
        UNRELATED_VAR: "should-not-leak",
      },
    });
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
  });

  it("main.pass_env: all — every host env var is visible in the sandbox", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "cc-msb-passenv-all-"));
    await cp(fixturePath("config-pass-env-all"), projectDir, { recursive: true });

    session = await createCleanSession({
      cwd: projectDir,
      env: { ARBITRARY_HOST_VAR: "arbitrary-value" },
    });
    const result = await session.run(
      "Run a bash command that prints exactly: `marker=[${ARBITRARY_HOST_VAR:-unset}]`. " +
      "Report the exact output."
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/marker=\[arbitrary-value\]/);
  });
});
