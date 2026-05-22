import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/cc-msb", import.meta.url));
const SHIM = join(PLUGIN_ROOT, "skills/shell/cc-msb-bash.sh");
const SANDBOX = "cc-msb-shim-integration";

// Stand up a real msb sandbox so the shim has something to find via `msb list`,
// then verify it routes commands inside that sandbox (Linux uname) rather than
// running on the macOS host (Darwin uname).
afterAll(() => {
  spawnSync("msb", ["stop", SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", SANDBOX, "--quiet"], { encoding: "utf8" });
});

describe("cc-msb-bash.sh — shell shim integration", () => {
  it("routes `-c <cmd>` into a real running cc-msb sandbox", () => {
    const create = spawnSync("msb", ["create", "ubuntu", "--name", SANDBOX, "--quiet"], {
      encoding: "utf8",
    });
    expect(create.status).toBe(0);

    const r = spawnSync("bash", [SHIM, "-c", "uname -s"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    // The cc-msb sandbox runs Linux; the host (where this test runs) is Darwin.
    expect(r.stdout.trim()).toBe("Linux");
  });

});

// The "no sandbox running → fall back to /bin/bash" path is covered by the
// unit test (src/tests/unit/cc-msb-bash-shim.test.ts) by removing msb from
// PATH. We can't reliably assert that path in an integration test because
// other parallel suites may leave a cc-msb-* sandbox running concurrently.
