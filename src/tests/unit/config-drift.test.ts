import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, cleanupFakeMsbFiles } = createConfigTestContext("unit-dft-dri-001");

function cleanupDriftFiles() {
  // Remove any drift-named state/create-args files left from previous runs.
  // These are NOT in NAMED_PREFIXES to avoid other parallel tests wiping them mid-test.
  readdirSync("/tmp")
    .filter((f) => f.startsWith("fake-msb-cc-msb-drift-") && (f.endsWith(".state") || f.endsWith(".create-args")))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(() => { cleanupFakeMsbFiles(); cleanupDriftFiles(); });
afterEach(() => { cleanupFakeMsbFiles(); cleanupDriftFiles(); });

describe("config — config-drift detection", () => {
  function fpPath(sandboxName: string): string {
    return join(homedir(), ".cache", "cc-msb", "fingerprints", `${sandboxName}.fp`);
  }
  function clearFp(sandboxName: string): void {
    try { rmSync(fpPath(sandboxName)); } catch {}
  }
  function decisionOf(stdout: string): { decision: string; reason?: string } {
    if (!stdout.trim()) return { decision: "(no-op)" };
    const o = JSON.parse(stdout).hookSpecificOutput;
    return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
  }

  it("first-time create writes a fingerprint file", () => {
    const sandboxName = "cc-msb-drift-first-create";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    writeFileSync(
      join(projectDir, ".cc-msb.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`
    );
    try {
      runHook(projectDir);
      expect(existsSync(fpPath(sandboxName))).toBe(true);
      const fp = readFileSync(fpPath(sandboxName), "utf8").trim();
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("re-running with the same config produces no drift (allow)", () => {
    const sandboxName = "cc-msb-drift-stable";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    const cfg = `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`;
    writeFileSync(join(projectDir, ".cc-msb.yml"), cfg);
    try {
      const r1 = runHook(projectDir);
      expect(decisionOf(r1.stdout).decision).toBe("allow");
      const r2 = runHook(projectDir);
      expect(decisionOf(r2.stdout).decision).toBe("allow");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("local-file change (image): emits a deny pointing at the named sandbox", () => {
    const sandboxName = "cc-msb-drift-local-change";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    writeFileSync(
      join(projectDir, ".cc-msb.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`
    );
    try {
      const r1 = runHook(projectDir);
      expect(decisionOf(r1.stdout).decision).toBe("allow");
      writeFileSync(
        join(projectDir, ".cc-msb.yml"),
        `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: alpine\n`
      );
      const r2 = runHook(projectDir);
      const { decision, reason } = decisionOf(r2.stdout);
      expect(decision).toBe("deny");
      expect(reason).toContain(sandboxName);
      expect(reason).toMatch(/msb stop/);
      expect(reason).toMatch(/msb remove/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("local-file change (network): emits a deny", () => {
    const sandboxName = "cc-msb-drift-net-change";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    writeFileSync(
      join(projectDir, ".cc-msb.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n`
    );
    try {
      const r1 = runHook(projectDir);
      expect(decisionOf(r1.stdout).decision).toBe("allow");
      writeFileSync(
        join(projectDir, ".cc-msb.yml"),
        `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  network: disabled\n`
      );
      const r2 = runHook(projectDir);
      expect(decisionOf(r2.stdout).decision).toBe("deny");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("global-file change is also detected (no local file in between)", () => {
    const sandboxName = "cc-msb-drift-global-change";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    const globalDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-glob-"));
    writeFileSync(
      join(globalDir, "config.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`
    );
    try {
      const r1 = runHook(projectDir, { CC_MSB_CONFIG_DIR: globalDir });
      expect(decisionOf(r1.stdout).decision).toBe("allow");
      writeFileSync(
        join(globalDir, "config.yml"),
        `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: alpine\n`
      );
      const r2 = runHook(projectDir, { CC_MSB_CONFIG_DIR: globalDir });
      const { decision, reason } = decisionOf(r2.stdout);
      expect(decision).toBe("deny");
      expect(reason).toContain(sandboxName);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("local change overriding global: still drifts when value flips", () => {
    const sandboxName = "cc-msb-drift-mixed-change";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    const globalDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-glob-"));
    writeFileSync(
      join(globalDir, "config.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`
    );
    try {
      const r1 = runHook(projectDir, { CC_MSB_CONFIG_DIR: globalDir });
      expect(decisionOf(r1.stdout).decision).toBe("allow");
      writeFileSync(join(projectDir, ".cc-msb.yml"), "main:\n  sandbox_image: alpine\n");
      const r2 = runHook(projectDir, { CC_MSB_CONFIG_DIR: globalDir });
      expect(decisionOf(r2.stdout).decision).toBe("deny");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("recreate after drift: remove sandbox → next call re-creates + rewrites fingerprint", () => {
    const sandboxName = "cc-msb-drift-recreate-cycle";
    clearFp(sandboxName);
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    writeFileSync(
      join(projectDir, ".cc-msb.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: ubuntu\n`
    );
    try {
      runHook(projectDir);
      const fp1 = readFileSync(fpPath(sandboxName), "utf8").trim();

      writeFileSync(
        join(projectDir, ".cc-msb.yml"),
        `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: alpine\n`
      );
      expect(decisionOf(runHook(projectDir).stdout).decision).toBe("deny");
      expect(readFileSync(fpPath(sandboxName), "utf8").trim()).toBe(fp1);

      try { rmSync(`/tmp/fake-msb-${sandboxName}.state`); } catch {}
      try { rmSync(`/tmp/fake-msb-${sandboxName}.create-args`); } catch {}

      const r3 = runHook(projectDir);
      expect(decisionOf(r3.stdout).decision).toBe("allow");
      const fp2 = readFileSync(fpPath(sandboxName), "utf8").trim();
      expect(fp2).not.toBe(fp1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      clearFp(sandboxName);
    }
  });

  it("auto_recreate config: resolves via standard chain (default false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-msb-autorec-"));
    try {
      writeFileSync(join(dir, ".cc-msb.yml"), "main:\n  auto_recreate: true\n");
      const r = runHook(dir);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-existing sandbox without a stored fingerprint: no drift (backwards-compat)", () => {
    const sandboxName = "cc-msb-drift-no-stored-fp";
    clearFp(sandboxName);
    writeFileSync(`/tmp/fake-msb-${sandboxName}.state`, "Running\n");
    const projectDir = mkdtempSync(join(tmpdir(), "cc-msb-drift-"));
    writeFileSync(
      join(projectDir, ".cc-msb.yml"),
      `main:\n  scope: named\n  sandbox_name: ${sandboxName}\n  sandbox_image: alpine\n`
    );
    try {
      const r = runHook(projectDir);
      expect(decisionOf(r.stdout).decision).toBe("allow");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      try { rmSync(`/tmp/fake-msb-${sandboxName}.state`); } catch {}
      clearFp(sandboxName);
    }
  });
});
