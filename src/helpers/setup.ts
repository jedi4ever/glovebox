import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Always pin GLOVEBOX_CONFIG_DIR to a fresh empty tmp dir for the test run,
// even if the developer already has it exported in their shell. The hook
// looks for $GLOVEBOX_CONFIG_DIR/config.yml; an empty dir means "no global
// config", which keeps tests deterministic regardless of what's in
// ~/.config/glovebox/ on the host. Individual tests that need to exercise
// the global config still override this for the duration of their spawn.
process.env["GLOVEBOX_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "glovebox-test-config-"));

// Disable the git-identity / gh-token autodetect fallbacks by default in
// the test suite. Otherwise the hooks would pick up the developer's real
// `~/.gitconfig` and `gh auth token`, polluting every test that asserts
// on the resolved JSON payload. Tests that explicitly exercise the
// autodetect path re-enable via extraEnv on the spawn call.
process.env["GLOVEBOX_MAIN_GIT_USER_AUTODETECT"] = "false";
process.env["GLOVEBOX_MAIN_GIT_TOKEN_AUTODETECT"] = "false";
