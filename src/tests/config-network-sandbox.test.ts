import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

// Probes the `network` config against real MSB sandboxes. Uses bash's built-in
// `/dev/tcp/<host>/<port>` so we don't depend on `curl`/`wget` being installed
// in the default ubuntu image.

const PROBE = (host: string, label: string) =>
  `(timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/443' && echo ${label}=OK || echo ${label}=FAIL) 2>&1`;

describe.concurrent("config — network integration", () => {
  it("default (no config): network is on — TCP to example.com succeeds", async () => {
    const { session, teardown } = await setupScenario("glovebox-net-default-");
    try {
      const result = await session.run(
        "Run this exact bash command and report the exact output verbatim:\n" +
        "`" + PROBE("example.com", "EXAMPLE") + "`"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/EXAMPLE=OK/);
    } finally {
      await teardown();
    }
  });

  it("network: disabled — outbound TCP fails", async () => {
    const { session, teardown } = await setupScenario("glovebox-net-disabled-", {
      fixture: "config-network-disabled",
    });
    try {
      const result = await session.run(
        "Run this exact bash command and report the exact output verbatim. Do not retry on failure:\n" +
        "`" + PROBE("example.com", "EXAMPLE") + "`"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/EXAMPLE=FAIL/);
      expect(result.stdout).not.toMatch(/EXAMPLE=OK/);
    } finally {
      await teardown();
    }
  });

  it("network: allowlist — listed domain reachable, unlisted denied", async () => {
    const { session, teardown } = await setupScenario("glovebox-net-allow-", {
      fixture: "config-network-allowlist",
    });
    try {
      const result = await session.run(
        "Run these two exact bash commands and report each output verbatim, labeled clearly:\n" +
        "1. `" + PROBE("example.com", "ALLOWED") + "`\n" +
        "2. `" + PROBE("www.google.com", "DENIED") + "`"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ALLOWED=OK/);
      expect(result.stdout).toMatch(/DENIED=FAIL/);
      expect(result.stdout).not.toMatch(/DENIED=OK/);
    } finally {
      await teardown();
    }
  });
});
