import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createCleanSession } from "../helpers/session.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/glovebox", import.meta.url));
const EXPECTED_SHIM_PATH = join(PLUGIN_ROOT, "skills/shell/glovebox-bash.sh");

// The glovebox:shell SKILL.md uses the documented skill dynamic-injection syntax
// `!`echo "${CLAUDE_SKILL_DIR}/glovebox-bash.sh"`` so that, when the skill is
// invoked, the rendered content includes the absolute path of the bundled
// shim — ready for the user to paste into their settings.json. Plugin path
// variables don't expand in settings.json env.* values, so this is how we
// give end users a copy-pasteable absolute path.

describe("glovebox:shell skill", () => {
  it("invocation reports the absolute shim path", async () => {
    const session = await createCleanSession();
    try {
      const result = await session.run(
        "Invoke the glovebox:shell skill and quote, verbatim, the absolute filesystem path " +
        "the skill says to paste into the CLAUDE_CODE_SHELL env entry."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(EXPECTED_SHIM_PATH);
    } finally {
      await session.dispose();
    }
  });
});
