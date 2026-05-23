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

// Pin CC_MSB_CONFIG_DIR to an empty tmp dir so tests never accidentally
// read the developer's real ~/.config/cc-msb/config.yml. Individual tests
// that want to exercise the global config can point CC_MSB_CONFIG_DIR at
// their own fixture dir for the duration of the test.
if (!process.env["CC_MSB_CONFIG_DIR"]) {
  process.env["CC_MSB_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cc-msb-test-config-"));
}
