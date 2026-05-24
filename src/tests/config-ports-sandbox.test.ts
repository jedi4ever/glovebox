import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { setupScenario } from "../helpers/scenario.js";

// Probe whether the host can establish a TCP connection to a port. msb's port
// forwarder binds the host port at sandbox-create time regardless of whether a
// backend service is listening in the guest, which makes "is the port open?"
// a reliable end-to-end probe of the forwarding configuration.
function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host, timeout: timeoutMs }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

const NAMED_SANDBOX = "glovebox-ports-int-named";
const HOST_PORT = 19876;

// Always clean up the named sandbox so the bound host port is released between
// CI runs (and so subsequent runs find the port closed in the sanity check).
afterAll(() => {
  spawnSync("msb", ["stop", NAMED_SANDBOX, "--quiet"], { encoding: "utf8" });
  spawnSync("msb", ["remove", NAMED_SANDBOX, "--quiet"], { encoding: "utf8" });
});

// Sequential — the host port is a shared resource and concurrency with itself
// would race. Each integration test using ports must pick an isolated port.
describe("config — ports integration", () => {
  it("port is NOT bound before the sandbox starts (sanity)", async () => {
    // Make sure no leftover sandbox is holding the port.
    spawnSync("msb", ["stop", NAMED_SANDBOX, "--quiet"], { encoding: "utf8" });
    spawnSync("msb", ["remove", NAMED_SANDBOX, "--quiet"], { encoding: "utf8" });
    expect(await isPortOpen(HOST_PORT)).toBe(false);
  });

  it("ports: \"19876:8000\" binds host port 19876 when the named sandbox is up", async () => {
    const { session, teardown } = await setupScenario("glovebox-ports-int-", {
      fixture: "config-ports-integration",
    });
    try {
      // Force a Bash call so the sandbox is definitely created and running.
      const r = await session.run("Run this bash command: `echo SANDBOX_UP`");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/SANDBOX_UP/);

      // The named sandbox persists past session.run() because it isn't tracked
      // for SessionEnd cleanup — so the host port stays bound here.
      expect(await isPortOpen(HOST_PORT)).toBe(true);
    } finally {
      await teardown();
    }
  });
});
