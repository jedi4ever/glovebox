import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { removeSandbox } from "./msb-sdk.js";

const PLUGIN_DIR = new URL("../../plugins/glovebox", import.meta.url).pathname;
const SANDBOXED_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Agent"];

export interface SessionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionOptions {
  env?: Record<string, string>;
  cwd?: string;
  agentType?: string;
  /** When true, dispose() skips sandbox removal (caller owns cleanup). */
  keepSandbox?: boolean;
}

export interface CleanSession {
  configDir: string;
  run(prompt: string): Promise<SessionResult>;
  dispose(): Promise<void>;
}

function requireApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) throw new Error("ANTHROPIC_API_KEY must be set to run integration tests");
  return key;
}

/** Read the sandboxes tracking file and return each unique name listed. */
async function trackedSandboxes(stateDir: string): Promise<string[]> {
  const pattern = /[a-z0-9][a-z0-9_-]{0,63}/g;
  const allNames = new Set<string>();
  // Each session writes its sandbox names into <stateDir>/<sessionId>/sandboxes.
  // Walk one level deep to collect all session sub-dirs.
  try {
    const { readdirSync } = await import("node:fs");
    for (const sessionId of readdirSync(stateDir)) {
      const file = join(stateDir, sessionId, "sandboxes");
      if (!existsSync(file)) continue;
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(pattern)) allNames.add(m[0]);
    }
  } catch { /* state dir may not exist if no sandbox was ever created */ }
  return [...allNames];
}

export async function createCleanSession(options: SessionOptions = {}): Promise<CleanSession> {
  const apiKey = requireApiKey();
  const configDir = await mkdtemp(join(tmpdir(), "glovebox-test-config-"));
  // Each session gets its own state dir so we know exactly which sandboxes
  // were created — regardless of scope (named, directory, session, etc.).
  const stateDir = await mkdtemp(join(tmpdir(), "glovebox-test-state-"));

  return {
    configDir,

    run(prompt: string): Promise<SessionResult> {
      return new Promise((resolve, reject) => {
        const agentArgs = options.agentType ? ["--agent", options.agentType] : [];
        const proc = spawn(
          "claude",
          [
            "--print",
            "--allowedTools", SANDBOXED_TOOLS.join(","),
            "--plugin-dir", PLUGIN_DIR,
            ...agentArgs,
            prompt,
          ],
          {
            cwd: options.cwd,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey,
              CLAUDE_CONFIG_DIR: configDir,
              // Pin the project dir to the session's cwd so the plugin's
              // workspace bind-mount and CC's path resolution stay in sync.
              // Without this, CC may walk up to the git repo root and set
              // CLAUDE_PROJECT_DIR there, causing Edit path mismatches.
              ...(options.cwd ? { CLAUDE_PROJECT_DIR: options.cwd } : {}),
              // Redirect plugin state so we can track which sandbox(es) were
              // created, then clean them up in dispose() regardless of scope.
              GLOVEBOX_STATE_DIR: stateDir,
              // All auto-generated sandbox names get this prefix so global-setup
              // can sweep every test VM without touching production sandboxes.
              GLOVEBOX_SANDBOX_PREFIX: 'glovebox-test',
              ...options.env,
            },
          }
        );

        proc.stdin.end();

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      });
    },

    async dispose() {
      if (!options.keepSandbox) {
        for (const name of await trackedSandboxes(stateDir)) {
          await removeSandbox(name);
        }
      }
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
