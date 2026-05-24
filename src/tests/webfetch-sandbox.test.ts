import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

// CC's WebFetch tool normally runs on the host's network and bypasses
// every glovebox config. Our PreToolUse hook denies WebFetch with a hint
// to use Bash + curl, and the existing Bash hook then routes that curl
// through `msb exec` into the sandbox. End-to-end: Claude asks for a
// URL, our hook bounces it, Claude retries with Bash+curl, the sandbox
// fetches the URL and Claude sees the body.

describe.concurrent("WebFetch interception", () => {
  it("asking Claude to fetch a URL routes through Bash+curl in the sandbox", async () => {
    // Use buildpack-deps:noble so curl is preinstalled — saves ~30s of
    // apt-get fallback time on the default ubuntu image.
    const { session, teardown } = await setupScenario("glovebox-webfetch-", { fixture: "config-webfetch" });
    try {
      // example.com is a stable, low-traffic page whose body contains the
      // literal phrase "Example Domain". Use the WebFetch tool name in the
      // prompt so Claude actually tries it first; the hook will deny and
      // nudge Claude to fall back to Bash+curl.
      const result = await session.run(
        "Use the WebFetch tool to fetch https://example.com and tell me the exact text of the <h1> on that page. " +
        "If WebFetch is unavailable, fall back to whatever tool actually works in this sandbox."
      );

      expect(result.exitCode).toBe(0);
      // The page body has the literal "Example Domain" — seeing it proves
      // the fetch succeeded (via Bash+curl in the sandbox).
      expect(result.stdout).toMatch(/Example Domain/);
    } finally {
      await teardown();
    }
  });

  it("network: disabled blocks the fetch from inside the sandbox", async () => {
    // Same plugin, same shim, but `network: disabled` on main. The deny+hint
    // still fires for WebFetch, Claude falls back to Bash+curl, but the sandbox
    // has `--no-net` so curl can't reach example.com → no "Example Domain".
    const { session, teardown } = await setupScenario("glovebox-webfetch-nonet-", {
      fixture: "config-webfetch-network-disabled",
    });
    try {
      const result = await session.run(
        "Fetch https://example.com and report the exact text of the <h1> on that page. " +
        "If the fetch fails, just say so verbatim and don't retry."
      );
      expect(result.exitCode).toBe(0);
      // The fetch cannot succeed when the sandbox has no network.
      expect(result.stdout).not.toMatch(/Example Domain/);
    } finally {
      await teardown();
    }
  });

  it("scope: host bypasses the interception — fetch succeeds on the host's network", async () => {
    // With scope=host, the glovebox hooks short-circuit at the top of the
    // PreToolUse, so WebFetch is NOT denied. CC runs WebFetch normally on
    // the host's network. Even though the project-level config could set
    // network policy, scope=host means no sandbox at all.
    const { session, teardown } = await setupScenario("glovebox-webfetch-host-", {
      fixture: "config-webfetch-host",
    });
    try {
      const result = await session.run(
        "Use the WebFetch tool to fetch https://example.com and quote the exact text of the <h1>."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Example Domain/);
    } finally {
      await teardown();
    }
  });
});
