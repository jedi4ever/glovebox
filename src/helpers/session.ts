import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PLUGIN_DIR = new URL("../../plugins/cc-msb", import.meta.url).pathname;
const SANDBOXED_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit"];

export interface SessionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionOptions {
  env?: Record<string, string>;
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

export async function createCleanSession(options: SessionOptions = {}): Promise<CleanSession> {
  const apiKey = requireApiKey();
  const configDir = await mkdtemp(join(tmpdir(), "cc-msb-test-"));

  return {
    configDir,

    run(prompt: string): Promise<SessionResult> {
      return new Promise((resolve, reject) => {
        const proc = spawn(
          "claude",
          [
            "--print",
            "--allowedTools", SANDBOXED_TOOLS.join(","),
            "--plugin-dir", PLUGIN_DIR,
            prompt,
          ],
          {
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey,
              CLAUDE_CONFIG_DIR: configDir,
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
      await rm(configDir, { recursive: true, force: true });
    },
  };
}
