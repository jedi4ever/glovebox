import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";

// Loads the in-tree helper module directly (no `microsandbox` install
// required for this test — the helper is plain JS until it calls loadSdk).
const MODULE_URL = new URL(
  "../../../plugins/cc-msb/scripts/lib/sandbox-build.mjs",
  import.meta.url
).href;
void fileURLToPath; // silence unused-import lint if it appears

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { method: string; args: unknown[] };

function makeBuilder() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      // every builder setter is chainable in the real SDK
      return proxy;
    };
  const proxy: any = {
    image: record("image"),
    fromSnapshot: record("fromSnapshot"),
    replace: record("replace"),
    workdir: record("workdir"),
    port: record("port"),
    portUdp: record("portUdp"),
    // .volume(guest, configure) — invoke `configure` with a mount-builder mock
    volume: (guest: string, configure: (m: any) => any) => {
      const m: any = {
        bind: record("volume.bind"),
        tmpfs: record("volume.tmpfs"),
      };
      configure(m);
      calls.push({ method: "volume", args: [guest] });
      return proxy;
    },
    // .network(cb)
    network: (configure: (nb: any) => any) => {
      const nb: any = {
        enabled: record("network.enabled"),
        policyJson: record("network.policyJson"),
        port: record("port"),
        portUdp: record("portUdp"),
        trustHostCAs: record("network.trustHostCAs"),
        onSecretViolation: record("network.onSecretViolation"),
        // Legacy mock — kept around so older tests still pass; applyConfig
        // no longer calls this (it uses .secret() instead for the
        // multi-host placeholder bug fix).
        secretEnvSimple: record("network.secretEnvSimple"),
        secret: (cb: (b: any) => any) => {
          const sb: any = {
            env: (v: string) => { calls.push({ method: "secret.env", args: [v] }); return sb; },
            value: (v: string) => { calls.push({ method: "secret.value", args: [v] }); return sb; },
            allowHost: (h: string) => { calls.push({ method: "secret.allowHost", args: [h] }); return sb; },
          };
          cb(sb);
          calls.push({ method: "network.secret", args: [] });
          return nb;
        },
        tls: (cb: (tb: any) => any) => {
          const tb: any = {
            bypass: record("tls.bypass"),
            interceptedPorts: record("tls.interceptedPorts"),
          };
          cb(tb);
          calls.push({ method: "network.tls", args: [] });
          return nb;
        },
      };
      configure(nb);
      return proxy;
    },
    createDetached: record("createDetached"),
    __calls: () => calls,
  };
  return proxy;
}

const baseCfg = {
  sandboxName: "test-sb",
  image: "ubuntu",
  projectDir: "/tmp/proj",
  mountWorkdir: true,
  network: "enabled",
  ports: "",
  secrets: "",
  onSecretViolation: "",
  tlsIntercept: false,
  tlsInterceptPort: null as number | null,
  tlsBypass: "",
  trustHostCas: false,
};

describe("sandbox-build.mjs — applyConfig", () => {
  it("applies workdir + bind volume when mountWorkdir=true", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, baseCfg);
    const calls = b.__calls() as Call[];
    expect(calls.find((c) => c.method === "workdir")?.args).toEqual(["/workspace"]);
    expect(calls.find((c) => c.method === "volume")?.args).toEqual(["/workspace"]);
    expect(calls.find((c) => c.method === "volume.bind")?.args).toEqual(["/tmp/proj"]);
  });

  it("skips workdir/volume when mountWorkdir=false", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, mountWorkdir: false });
    const calls = b.__calls() as Call[];
    expect(calls.find((c) => c.method === "workdir")).toBeUndefined();
    expect(calls.find((c) => c.method === "volume")).toBeUndefined();
  });

  it("emits .port() for TCP entries and .portUdp() for /udp entries", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, ports: "8080:80,9229:9229/udp,5432:5432" });
    const calls = b.__calls() as Call[];
    const ports = calls.filter((c) => c.method === "port").map((c) => c.args);
    const udps = calls.filter((c) => c.method === "portUdp").map((c) => c.args);
    expect(ports).toContainEqual([8080, 80]);
    expect(ports).toContainEqual([5432, 5432]);
    expect(udps).toContainEqual([9229, 9229]);
  });

  it("network=disabled → .enabled(false)", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, network: "disabled" });
    expect(b.__calls().find((c: Call) => c.method === "network.enabled")?.args).toEqual([false]);
  });

  it("network=<allowlist> → policyJson with per-domain egress allows", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, network: "github.com,api.example.com" });
    const call = (b.__calls() as Call[]).find((c) => c.method === "network.policyJson");
    expect(call).toBeDefined();
    const policy = JSON.parse(call!.args[0] as string);
    expect(policy.default_egress).toBe("deny");
    expect(policy.rules.map((r: { destination: { domain: string } }) => r.destination.domain)).toEqual(
      ["github.com", "api.example.com"]
    );
    expect(policy.rules.every((r: { direction: string }) => r.direction === "egress")).toBe(true);
  });

  it("tlsIntercept=true + trustHostCas=true → both flag methods fire", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, {
      ...baseCfg,
      tlsIntercept: true,
      trustHostCas: true,
      tlsInterceptPort: 8443,
      tlsBypass: "*.internal.com,intra",
    });
    const calls = b.__calls() as Call[];
    expect(calls.find((c) => c.method === "network.trustHostCAs")?.args).toEqual([true]);
    expect(calls.filter((c) => c.method === "tls.bypass").map((c) => c.args)).toEqual([
      ["*.internal.com"],
      ["intra"],
    ]);
    expect(calls.find((c) => c.method === "tls.interceptedPorts")?.args).toEqual([[8443]]);
  });

  it("secrets → one nb.secret(b => env.value.allowHost…) call per (env,value) group", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, {
      ...baseCfg,
      secrets: "GH_TOKEN=ghp_abc@github.com,NPM_TOKEN=npm_xyz@registry.npmjs.org",
      onSecretViolation: "block-and-log",
    });
    const calls = b.__calls() as Call[];
    // Two distinct (env,value) pairs → two secret() invocations.
    expect(calls.filter((c) => c.method === "network.secret")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "secret.env").map((c) => c.args)).toEqual([
      ["GH_TOKEN"], ["NPM_TOKEN"],
    ]);
    expect(calls.filter((c) => c.method === "secret.allowHost").map((c) => c.args)).toEqual([
      ["github.com"], ["registry.npmjs.org"],
    ]);
    expect(calls.find((c) => c.method === "network.onSecretViolation")?.args).toEqual(["block-and-log"]);
  });

  it("multi-host github expansion → ONE secret() with multiple allowHost calls (placeholder leak fix)", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, {
      ...baseCfg,
      secrets: [
        "GH_TOKEN=ghp_xyz@github.com",
        "GH_TOKEN=ghp_xyz@api.github.com",
        "GH_TOKEN=ghp_xyz@codeload.github.com",
      ].join(","),
    });
    const calls = b.__calls() as Call[];
    // Same (env,value) across three hosts → exactly ONE .secret() call.
    expect(calls.filter((c) => c.method === "network.secret")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "secret.env")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "secret.value").map((c) => c.args)).toEqual([
      ["ghp_xyz"],
    ]);
    expect(calls.filter((c) => c.method === "secret.allowHost").map((c) => c.args)).toEqual([
      ["github.com"], ["api.github.com"], ["codeload.github.com"],
    ]);
  });

  it("throws on malformed port specs", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    expect(() => applyConfig(b, { ...baseCfg, ports: "not-a-port" })).toThrow(/bad port spec/);
  });
});

describe("sandbox-build.mjs — applyGitIdentity", () => {
  // Build a minimal mock Sandbox class that records exec calls. The real
  // SDK isn't needed.
  function makeMockSandboxClass(): { Sandbox: any; lastExec: () => unknown[] | null } {
    const calls: unknown[][] = [];
    const live = {
      exec: async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: () => "" };
      },
    };
    const handle = { connect: async () => live };
    const Sandbox = { get: async () => handle };
    return { Sandbox, lastExec: () => (calls.length ? calls[calls.length - 1]! : null) };
  }

  it("no-op when neither gitUserName nor gitUserEmail is set", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, { sandboxName: "test", gitUserName: "", gitUserEmail: "" });
    expect(lastExec()).toBeNull();
  });

  it("execs `git config --global user.name` when only name is set", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, { sandboxName: "test", gitUserName: "Alice", gitUserEmail: "" });
    const call = lastExec();
    expect(call).not.toBeNull();
    expect(call?.[0]).toBe("sh");
    const script = (call?.[1] as string[])[1];
    expect(script).toMatch(/git config --global user\.name "Alice"/);
    expect(script).not.toMatch(/user\.email/);
  });

  it("execs both user.name and user.email when both set, AND-chained", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, {
      sandboxName: "test",
      gitUserName: "Alice",
      gitUserEmail: "alice@example.com",
    });
    const script = ((lastExec()?.[1] as string[]) || [])[1] || "";
    expect(script).toMatch(/git config --global user\.name "Alice"/);
    expect(script).toMatch(/&& git config --global user\.email "alice@example\.com"/);
  });

  it("shell-escapes quotes / backslashes / `$` / backticks in the values", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const { Sandbox, lastExec } = makeMockSandboxClass();
    await applyGitIdentity(Sandbox, {
      sandboxName: "test",
      gitUserName: 'Bob "the Builder" $WHO',
      gitUserEmail: "bob`echo`@host",
    });
    const script = ((lastExec()?.[1] as string[]) || [])[1] || "";
    expect(script).toContain('user.name "Bob \\"the Builder\\" \\$WHO"');
    expect(script).toContain('user.email "bob\\`echo\\`@host"');
  });

  it("swallows SDK errors silently (best-effort)", async () => {
    const { applyGitIdentity } = await import(MODULE_URL);
    const Sandbox = { get: async () => { throw new Error("sandbox vanished"); } };
    // Should resolve, not reject.
    await expect(applyGitIdentity(Sandbox, {
      sandboxName: "test", gitUserName: "x", gitUserEmail: "y@z",
    })).resolves.toBeUndefined();
  });
});

describe("sandbox-build.mjs — dumpFake", () => {
  const NAME = "cc-msb-sandbox-build-test";
  const FAKE_FILE = `/tmp/fake-msb-${NAME}.create-args`;
  const STATE_FILE = `/tmp/fake-msb-${NAME}.state`;

  beforeEach(() => {
    try { rmSync(FAKE_FILE); } catch { /* ignore */ }
    try { rmSync(STATE_FILE); } catch { /* ignore */ }
  });
  afterEach(() => {
    try { rmSync(FAKE_FILE); } catch { /* ignore */ }
    try { rmSync(STATE_FILE); } catch { /* ignore */ }
  });

  it("returns false when CC_MSB_FAKE_CREATE is unset", async () => {
    delete process.env["CC_MSB_FAKE_CREATE"];
    const { dumpFake } = await import(MODULE_URL);
    expect(dumpFake({ sandboxName: NAME })).toBe(false);
    expect(existsSync(FAKE_FILE)).toBe(false);
  });

  it("writes the JSON payload + state file when CC_MSB_FAKE_CREATE=1", async () => {
    process.env["CC_MSB_FAKE_CREATE"] = "1";
    try {
      const { dumpFake } = await import(MODULE_URL);
      const cfg = { ...baseCfg, sandboxName: NAME };
      expect(dumpFake(cfg)).toBe(true);
      expect(existsSync(FAKE_FILE)).toBe(true);
      expect(existsSync(STATE_FILE)).toBe(true);
      const dumped = JSON.parse(readFileSync(FAKE_FILE, "utf8"));
      expect(dumped.sandboxName).toBe(NAME);
      expect(dumped.image).toBe("ubuntu");
      expect(readFileSync(STATE_FILE, "utf8").trim()).toBe("Running");
    } finally {
      delete process.env["CC_MSB_FAKE_CREATE"];
    }
  });
});
