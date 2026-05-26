import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const MODULE_URL = new URL(
  "../../../plugins/glovebox/scripts/lib/sandbox-build.mjs",
  import.meta.url
).href;
void fileURLToPath;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { method: string; args: unknown[] };

function makeBuilder() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return proxy;
    };
  const proxy: any = {
    image: record("image"),
    fromSnapshot: record("fromSnapshot"),
    replace: record("replace"),
    user: record("user"),
    workdir: record("workdir"),
    port: record("port"),
    portUdp: record("portUdp"),
    volume: (guest: string, configure: (m: any) => any) => {
      const m: any = {
        bind: record("volume.bind"),
        tmpfs: record("volume.tmpfs"),
      };
      configure(m);
      calls.push({ method: "volume", args: [guest] });
      return proxy;
    },
    network: (configure: (nb: any) => any) => {
      const nb: any = {
        enabled: record("network.enabled"),
        policyJson: record("network.policyJson"),
        port: record("port"),
        portUdp: record("portUdp"),
        trustHostCAs: record("network.trustHostCAs"),
        onSecretViolation: record("network.onSecretViolation"),
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
  user: "",
};

describe("sandbox-build.mjs — applyConfig", () => {
  it("auto-maps host UID for any image when mountWorkdir=true (so VirtioFS writes work)", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, baseCfg); // baseCfg.image = "ubuntu"
    const calls = b.__calls() as Call[];
    const uid = process.getuid?.();
    if (uid != null && uid !== 0) {
      expect(calls.find((c) => c.method === "user")?.args).toEqual([String(uid)]);
    }
    expect(calls.find((c) => c.method === "workdir")?.args).toEqual(["/workspace"]);
    expect(calls.find((c) => c.method === "volume")?.args).toEqual(["/workspace"]);
    expect(calls.find((c) => c.method === "volume.bind")?.args).toEqual(["/tmp/proj"]);
  });

  it("respects explicit user config instead of defaulting to root", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, user: "myuser" });
    expect((b.__calls() as Call[]).find((c) => c.method === "user")?.args).toEqual(["myuser"]);
  });

  it("skips workdir/volume when mountWorkdir=false, no user call when user unset", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, mountWorkdir: false });
    const calls = b.__calls() as Call[];
    expect(calls.find((c) => c.method === "user")).toBeUndefined();
    expect(calls.find((c) => c.method === "workdir")).toBeUndefined();
    expect(calls.find((c) => c.method === "volume")).toBeUndefined();
  });

  it("applies explicit user even when mountWorkdir=false", async () => {
    const { applyConfig } = await import(MODULE_URL);
    const b = makeBuilder();
    applyConfig(b, { ...baseCfg, mountWorkdir: false, user: "1001" });
    expect((b.__calls() as Call[]).find((c) => c.method === "user")?.args).toEqual(["1001"]);
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

describe("sandbox-build.mjs — buildRemapScript", () => {
  it("finds the primary non-root user and remaps its UID", async () => {
    const { buildRemapScript } = await import(MODULE_URL);
    const uid = process.getuid?.() ?? 501;
    const script: string = buildRemapScript(uid);
    expect(script).toMatch(/getent passwd/);
    expect(script).toMatch(/awk.*500.*60000/);
    expect(script).toMatch(new RegExp(`usermod -u ${uid}`));
    expect(script).toMatch(new RegExp(`chown ${uid}`));
  });

  it("exits early if UID is already correct", async () => {
    const { buildRemapScript } = await import(MODULE_URL);
    const uid = process.getuid?.() ?? 501;
    const script: string = buildRemapScript(uid);
    expect(script).toMatch(new RegExp(`\\[ "\\$OLD_UID" = "${uid}" \\] && exit 0`));
  });

  it("exits early if no non-root user found", async () => {
    const { buildRemapScript } = await import(MODULE_URL);
    const script: string = buildRemapScript(process.getuid?.() ?? 501);
    expect(script).toMatch(/\[ -z "\$MAIN_USER" \] && exit 0/);
  });
});
