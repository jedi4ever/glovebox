import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { spawnTUI } from "../helpers/tui.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/cc-msb", import.meta.url));
const SHIM = join(PLUGIN_ROOT, "skills/shell/cc-msb-bash.sh");

const PROBE_SANDBOX = "cc-msb-shim-tui-probe";
const CLAUDE_BIN = execSync("which claude", { encoding: "utf8" }).trim();

// Real msb sandbox used as the routing target for the TUI test. Stop any
// leftover from a previous run and bring up a fresh one.
beforeAll(() => {
  spawnSync("msb", ["stop", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
});

afterAll(() => {
  spawnSync("msb", ["stop", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
});

describe("cc-msb-bash.sh — interactive TUI", () => {
  it("`!cmd` typed in an interactive claude session is routed through CLAUDE_CODE_SHELL into the cc-msb sandbox", async () => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");

    // Boot a real cc-msb sandbox so the shim has something to find via `msb list`.
    const create = spawnSync("msb", ["create", "ubuntu", "--name", PROBE_SANDBOX, "--quiet"], {
      encoding: "utf8",
    });
    expect(create.status).toBe(0);

    // Project dir with .claude/settings.local.json wiring CLAUDE_CODE_SHELL to our shim,
    // and CC_MSB_SHELL_TRACE_LOG so we can later prove the shim was actually invoked.
    // realpath both so the path matches what CC stores after macOS resolves
    // /var/folders/... → /private/var/folders/.... CC keys `projects` by the
    // resolved path; if we use the unresolved one it won't match.
    const projectDir = await realpath(await mkdtemp(join(tmpdir(), "cc-msb-shim-tui-")));
    const configDir = await realpath(await mkdtemp(join(tmpdir(), "cc-msb-shim-cfg-")));
    const traceLog = join(projectDir, "shim-trace.log");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({
        env: {
          CLAUDE_CODE_SHELL: SHIM,
          CC_MSB_SHELL_TRACE_LOG: traceLog,
        },
      })
    );

    // Pre-mark onboarding + theme so the TUI doesn't get stuck on first-run
    // prompts. session.ts gets away without this because `--print` mode skips
    // first-run; interactive does not. CLAUDE_CONFIG_DIR is a HOME-equivalent
    // root — the user-level config sits at <configDir>/.claude.json (mirroring
    // ~/.claude.json) and the onboarding flags at <configDir>/.claude/claude.json
    // (mirroring ~/.claude/claude.json).
    // Approve the API key up-front so CC doesn't ask. CC stores the trailing
    // 20 chars of the key as the "approved" identifier. Also pre-accept the
    // workspace trust dialog for the temp project dir.
    const apiKeyApproval = apiKey.slice(-20);
    // CC reads cwd to look up the project; on macOS `mkdtemp` gives a
    // /var/folders/... path that resolves to /private/var/folders/.... Put
    // entries for both forms so whichever shape CC ends up canonicalising to,
    // it finds a matching record.
    const projectEntry = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    };
    const projects: Record<string, typeof projectEntry> = {
      [projectDir]: projectEntry,
    };
    if (projectDir.startsWith("/private/")) {
      projects[projectDir.replace(/^\/private/, "")] = projectEntry;
    }
    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        hasCompletedOnboarding: true,
        hasTrustDialogHooksAccepted: true,
        customApiKeyResponses: {
          approved: [apiKeyApproval],
          rejected: [],
        },
        projects,
      })
    );

    const tui = spawnTUI(
      CLAUDE_BIN,
      ["--plugin-dir", PLUGIN_ROOT],
      {
        cwd: projectDir,
        env: {
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_CONFIG_DIR: configDir,
        },
      }
    );

    try {
      // With theme, onboarding, API-key approval, and project-trust all
      // pre-populated, the TUI should land directly on the main input prompt.
      // CC renders the prompt as ❯ (U+276F).
      await tui.expect(/^[❯>│]\s*$/m, { timeout: 30_000, quietMs: 400 });

      // Type a `!`-prefixed shell command. CC routes it through CLAUDE_CODE_SHELL.
      tui.sendLine("!uname -srm");

      // The sandbox is Linux; the host is Darwin. Seeing Linux in the rendered
      // output proves the shim actually routed the command through msb exec.
      await tui.expect(/Linux/, { timeout: 20_000, quietMs: 400 });

      const screen = tui.visible();
      expect(screen).toMatch(/Linux/);

      // The shim should have appended at least one line to the trace log,
      // proving CC actually invoked CLAUDE_CODE_SHELL (not just sent a Bash
      // tool call through our PreToolUse hook).
      expect(existsSync(traceLog)).toBe(true);
      const trace = await readFile(traceLog, "utf8");
      expect(trace.trim().length).toBeGreaterThan(0);
    } catch (err) {
      // Dump the last ~2000 chars of the TUI screen so failures show the
      // actual state CC was in (which prompt is blocking, etc.).
      // eslint-disable-next-line no-console
      console.log("\n=== TUI screen at failure ===\n" + tui.visible().slice(-2000) + "\n=== end ===\n");
      throw err;
    } finally {
      tui.kill();
      // Give claude a moment to release file handles in configDir/plugins
      // before we try to recursively remove it; otherwise rm races and
      // throws ENOTEMPTY, masking any real test failure above.
      await new Promise((r) => setTimeout(r, 500));
      try { await rm(projectDir, { recursive: true, force: true }); } catch {}
      try { await rm(configDir, { recursive: true, force: true }); } catch {}
    }
  }, 60_000);
});
