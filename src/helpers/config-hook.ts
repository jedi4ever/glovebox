import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, readFileSync, existsSync, readdirSync } from "node:fs";

export const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/glovebox", import.meta.url));
export const DEFAULT_IMAGE = 'node:alpine';
export const FAKE_MSB_DIR = fileURLToPath(new URL("../tests/fixtures/fake-msb", import.meta.url));
export const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

// Named sandbox prefixes that the shared cleanupFakeMsbFiles should also wipe.
// Each test file that uses fixed sandbox names (outside the session prefix) must
// manage its OWN named prefixes via a local cleanup function — NOT by adding them
// here. Keeping this list empty prevents parallel test files from deleting each
// other's state files mid-test.
export const NAMED_PREFIXES: string[] = [];

export function dirSandboxName(dir: string): string {
  return `glovebox-dir-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

export interface CreateConfig {
  sandboxName: string;
  image: string;
  projectDir: string;
  mountWorkdir: boolean;
  network: string;
  ports: string;
  secrets: string;
  onSecretViolation: string;
  tlsIntercept: boolean;
  tlsInterceptPort: number | null;
  tlsBypass: string;
  trustHostCas: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
}

export function wrappedCommand(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.updatedInput.command;
}

// Factory — call once per test file with a unique sessionId whose first 8
// characters differ from all other files (prevents state-file collisions when
// vitest runs files in parallel).
export function createConfigTestContext(sessionId: string) {
  const SANDBOX_NAME = `glovebox-${sessionId.slice(0, 16)}`;
  const SESSION_PREFIX = `glovebox-${sessionId.slice(0, 8)}`;
  // Per-agent sandbox name for "test-agent": prefix(8) + "_" + agent(8)
  const PER_AGENT_SANDBOX = `glovebox-${sessionId.slice(0, 8)}-test_age`;

  function bashEvent(agentType?: string) {
    return {
      tool_name: "Bash",
      session_id: sessionId,
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { command: "echo hi" },
    };
  }

  function runHook(
    projectDir: string,
    extraEnv: Record<string, string> = {},
    agentType?: string
  ) {
    return spawnSync("node", [PRE_HOOK], {
      input: JSON.stringify(bashEvent(agentType)),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        CLAUDE_PROJECT_DIR: projectDir,
        GLOVEBOX_FAKE_CREATE: "1",
        ...extraEnv,
      },
    });
  }

  function readCreateConfig(sandboxName: string = SANDBOX_NAME): CreateConfig | null {
    const f = `/tmp/fake-msb-${sandboxName}.create-args`;
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, "utf8")) as CreateConfig; } catch { return null; }
  }

  function readCreateArgs(sandboxName: string = SANDBOX_NAME): string[] {
    const cfg = readCreateConfig(sandboxName);
    if (!cfg) return [];
    const args: string[] = [cfg.image, "--name", cfg.sandboxName, "--workdir", "/workspace", "--quiet"];
    if (cfg.mountWorkdir) args.push("--volume", `${cfg.projectDir}:/workspace`);
    if (cfg.network === "disabled") args.push("--no-net");
    else if (cfg.network && cfg.network !== "enabled") {
      for (const d of cfg.network.split(",").map((s) => s.trim()).filter(Boolean)) {
        args.push("--net-rule", `allow@${d}`);
      }
    }
    for (const p of cfg.ports.split(",").map((s) => s.trim()).filter(Boolean)) {
      args.push("--port", p);
    }
    for (const s of cfg.secrets.split(",").map((x) => x.trim()).filter(Boolean)) {
      args.push("--secret", s);
    }
    if (cfg.onSecretViolation) args.push("--on-secret-violation", cfg.onSecretViolation);
    if (cfg.tlsIntercept) args.push("--tls-intercept");
    if (cfg.tlsInterceptPort != null) args.push("--tls-intercept-port", String(cfg.tlsInterceptPort));
    for (const b of cfg.tlsBypass.split(",").map((s) => s.trim()).filter(Boolean)) {
      args.push("--tls-bypass", b);
    }
    if (cfg.trustHostCas) args.push("--trust-host-cas");
    return args;
  }

  function findEphemeralCreateArgs(): string | null {
    const files = readdirSync("/tmp").filter(
      (f) =>
        f.startsWith(`fake-msb-${SESSION_PREFIX}`) &&
        f.endsWith(".create-args") &&
        f !== `fake-msb-${SANDBOX_NAME}.create-args`
    );
    return files.length > 0 ? `/tmp/${files[0]}` : null;
  }

  function cleanupFakeMsbFiles() {
    readdirSync("/tmp")
      .filter((f) => {
        if (!f.startsWith("fake-msb-") || (!f.endsWith(".state") && !f.endsWith(".create-args"))) return false;
        if (f.startsWith(`fake-msb-${SESSION_PREFIX}`)) return true;
        // glovebox-dir-* sandboxes are owned by config-scope.test.ts; that file
        // manages their cleanup directly so we do NOT wipe them here.
        return NAMED_PREFIXES.some((p) => f.startsWith(`fake-msb-${p}`));
      })
      .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
  }

  return {
    SESSION_ID: sessionId,
    SANDBOX_NAME,
    SESSION_PREFIX,
    PER_AGENT_SANDBOX,
    runHook,
    readCreateConfig,
    readCreateArgs,
    findEphemeralCreateArgs,
    cleanupFakeMsbFiles,
  };
}
