import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";
import { spawnTUI, type TUI } from "../helpers/tui.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/cc-msb", import.meta.url));
const SHIM = join(PLUGIN_ROOT, "skills/shell/cc-msb-bash.sh");

const PROBE_SANDBOX = "cc-msb-shim-tui-probe";
const CLAUDE_BIN = execSync("which claude", { encoding: "utf8" }).trim();

beforeAll(() => {
  spawnSync("msb", ["stop", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
});

afterAll(() => {
  spawnSync("msb", ["stop", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
});

interface Scenario {
  tui: TUI;
  projectDir: string;
  configDir: string;
  traceLog: string;
  teardown: () => Promise<void>;
}

// Boots an interactive `claude` TUI session backed by a real cc-msb sandbox.
// Pre-populates everything CC asks on first run (theme, onboarding, API-key
// approval, workspace trust) so the session lands directly on the main input
// prompt. settings.local.json's env block is whatever the caller passes —
// empty means no shim wired, full path means shim is active.
async function setupScenario(settingsEnv: Record<string, string>): Promise<Scenario> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");

  // Fresh probe sandbox each test (so the shim's "newest cc-msb-* sandbox"
  // selector has a current target).
  spawnSync("msb", ["stop", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", PROBE_SANDBOX, "--quiet"], { encoding: "utf8" });
  const create = spawnSync("msb", ["create", "ubuntu", "--name", PROBE_SANDBOX, "--quiet"], {
    encoding: "utf8",
  });
  if (create.status !== 0) throw new Error("msb create failed: " + create.stderr);

  const projectDir = await realpath(await mkdtemp(join(tmpdir(), "cc-msb-shim-tui-")));
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "cc-msb-shim-cfg-")));
  const traceLog = join(projectDir, "shim-trace.log");

  await mkdir(join(projectDir, ".claude"), { recursive: true });
  await writeFile(
    join(projectDir, ".claude", "settings.local.json"),
    JSON.stringify({ env: settingsEnv })
  );

  // First-run state CC normally asks about. Project entry keyed at both
  // /var/folders/... and /private/var/folders/... so whichever shape CC
  // canonicalises to matches.
  const apiKeyApproval = apiKey.slice(-20);
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
  const projects: Record<string, typeof projectEntry> = { [projectDir]: projectEntry };
  if (projectDir.startsWith("/private/")) {
    projects[projectDir.replace(/^\/private/, "")] = projectEntry;
  }
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({
      theme: "dark",
      hasCompletedOnboarding: true,
      hasTrustDialogHooksAccepted: true,
      customApiKeyResponses: { approved: [apiKeyApproval], rejected: [] },
      projects,
    })
  );

  // Explicitly clear CLAUDE_CODE_SHELL from inherited env so a value in the
  // test runner's shell doesn't leak into the "no shim" scenario.
  const baseEnv = { ...process.env };
  delete baseEnv["CLAUDE_CODE_SHELL"];
  const tui = spawnTUI(CLAUDE_BIN, ["--plugin-dir", PLUGIN_ROOT], {
    cwd: projectDir,
    env: { ...baseEnv, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: configDir },
  });

  const teardown = async () => {
    tui.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { await rm(projectDir, { recursive: true, force: true }); } catch {}
    try { await rm(configDir, { recursive: true, force: true }); } catch {}
  };

  return { tui, projectDir, configDir, traceLog, teardown };
}

describe("cc-msb-bash.sh — interactive TUI", () => {
  it("with CLAUDE_CODE_SHELL=shim: `!uname -srm` reports Linux (sandbox)", async () => {
    const s = await setupScenario({ CLAUDE_CODE_SHELL: SHIM });
    // Refresh settings.local.json now that we know the trace path.
    await writeFile(
      join(s.projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ env: { CLAUDE_CODE_SHELL: SHIM, CC_MSB_SHELL_TRACE_LOG: s.traceLog } })
    );

    try {
      await s.tui.expect(/^[❯>│]\s*$/m, { timeout: 30_000, quietMs: 400 });
      // Send `!` first, wait, then send the command — CC needs a beat to
      // switch into shell-input mode after the prefix.
      s.tui.send("!");
      await new Promise((r) => setTimeout(r, 400));
      s.tui.sendLine("uname -srm");
      // The shim spawns `msb list` + `msb exec` over the msb daemon; that
      // round-trip can take 30+s on a cold daemon, so allow generously.
      await s.tui.expect(/Linux/, { timeout: 60_000, quietMs: 400 });

      const screen = s.tui.visible();
      expect(screen).toMatch(/Linux/);
      // Shim's trace log proves CC actually invoked CLAUDE_CODE_SHELL.
      expect(existsSync(s.traceLog)).toBe(true);
      const trace = await readFile(s.traceLog, "utf8");
      expect(trace.trim().length).toBeGreaterThan(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log("\n=== TUI screen at failure ===\n" + s.tui.visible().slice(-2000) + "\n=== end ===\n");
      throw err;
    } finally {
      await s.teardown();
    }
  }, 120_000);

  it("without CLAUDE_CODE_SHELL: `!uname -s` reports Darwin (host /bin/bash)", async () => {
    // Same plugin-loaded session, no CLAUDE_CODE_SHELL in settings.local.json.
    // CC's `!` prefix should fall back to /bin/bash on the host → Darwin.
    //
    // Important: send `!` first, wait, THEN send the command. CC's TUI
    // appears to need a beat to switch into shell-input mode after the `!`
    // prefix — sending the whole line in one chunk bypasses that and Claude
    // ends up answering the literal text instead.
    const s = await setupScenario({});

    try {
      await s.tui.expect(/^[❯>│]\s*$/m, { timeout: 30_000, quietMs: 400 });
      s.tui.send("!");
      await new Promise((r) => setTimeout(r, 400));
      s.tui.sendLine("uname -s");
      await s.tui.expect(/Darwin|Linux/, { timeout: 20_000, quietMs: 400 });

      const screen = s.tui.visible();
      // Host is macOS → Darwin. Without CLAUDE_CODE_SHELL there's no shim
      // to route into the sandbox, and the plugin's PreToolUse Bash hook
      // does NOT fire for the `!` prefix (confirmed empirically), so `!cmd`
      // runs on the real host shell.
      expect(screen).toMatch(/Darwin/);
      expect(screen).not.toMatch(/Linux/);
      // The shim was not wired, so the shim's trace log should not exist.
      expect(existsSync(s.traceLog)).toBe(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log("\n=== TUI screen at failure ===\n" + s.tui.visible().slice(-2000) + "\n=== end ===\n");
      throw err;
    } finally {
      await s.teardown();
    }
  }, 60_000);
});
