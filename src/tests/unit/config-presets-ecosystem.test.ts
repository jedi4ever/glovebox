import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync, readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../plugins/glovebox", import.meta.url));
const FAKE_MSB_DIR = fileURLToPath(new URL("../fixtures/fake-msb", import.meta.url));
const PRE_HOOK = join(PLUGIN_ROOT, "hooks/pre-tool-use.mjs");

const SESSION_ID = "unit-ecosystem-001";
const SANDBOX_NAME = `glovebox-${SESSION_ID.slice(0, 16)}`;

function makeProject(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "glovebox-eco-"));
  writeFileSync(join(dir, ".glovebox.yml"), yaml);
  return dir;
}

function runHook(projectDir: string) {
  return spawnSync("node", [PRE_HOOK], {
    input: JSON.stringify({ tool_name: "Bash", session_id: SESSION_ID, tool_input: { command: "echo hi" } }),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_MSB_DIR}:${process.env["PATH"]}`,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
      GLOVEBOX_FAKE_CREATE: "1",
      GLOVEBOX_MAIN_SCOPE: "session",
    },
  });
}

function readNetwork(): string {
  const f = `/tmp/fake-msb-${SANDBOX_NAME}.create-args`;
  if (!existsSync(f)) return "";
  try { return (JSON.parse(readFileSync(f, "utf8")) as { network: string }).network ?? ""; }
  catch { return ""; }
}

function hosts(network: string): string[] {
  return network.split(",").map((h) => h.trim()).filter(Boolean);
}

function cleanup() {
  readdirSync("/tmp")
    .filter((f) => f.startsWith(`fake-msb-${SANDBOX_NAME}`) && (f.endsWith(".state") || f.endsWith(".create-args")))
    .forEach((f) => { try { rmSync(`/tmp/${f}`); } catch {} });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("ecosystem presets — network hosts", () => {
  it("npm preset opens registry and Node.js CDN hosts", () => {
    const dir = makeProject("presets: [npm]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("registry.npmjs.org");
      expect(net).toContain("registry.yarnpkg.com");
      expect(net).toContain("nodejs.org");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("github preset opens GitHub API, raw content, GHCR, and upload hosts", () => {
    const dir = makeProject("presets: [github]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("github.com");
      expect(net).toContain("api.github.com");
      expect(net).toContain("raw.githubusercontent.com");
      expect(net).toContain("uploads.github.com");
      expect(net).toContain("ghcr.io");
      expect(net).toContain("pkg-containers.githubusercontent.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("pip preset opens PyPI and files.pythonhosted.org", () => {
    const dir = makeProject("presets: [pip]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("pypi.org");
      expect(net).toContain("files.pythonhosted.org");
      expect(net).toContain("bootstrap.pypa.io");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("go preset opens Go module proxy, checksum DB, and GCS", () => {
    const dir = makeProject("presets: [go]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("proxy.golang.org");
      expect(net).toContain("sum.golang.org");
      expect(net).toContain("storage.googleapis.com");
      expect(net).toContain("gopkg.in");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cargo preset opens crates.io and its CDN and sparse index", () => {
    const dir = makeProject("presets: [cargo]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("crates.io");
      expect(net).toContain("static.crates.io");
      expect(net).toContain("index.crates.io");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("apt preset opens Debian and Ubuntu package mirrors", () => {
    const dir = makeProject("presets: [apt]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("deb.debian.org");
      expect(net).toContain("security.debian.org");
      expect(net).toContain("archive.ubuntu.com");
      expect(net).toContain("security.ubuntu.com");
      expect(net).toContain("ports.ubuntu.com");
      expect(net).toContain("keyserver.ubuntu.com");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("docker preset opens Docker Hub registry and auth hosts", () => {
    const dir = makeProject("presets: [docker]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("registry-1.docker.io");
      expect(net).toContain("auth.docker.io");
      expect(net).toContain("production.cloudflare.docker.com");
      expect(net).toContain("index.docker.io");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("ecosystem presets — composition", () => {
  it("npm + pip union their host lists with no duplicates", () => {
    const dir = makeProject("presets: [npm, pip]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      // npm hosts
      expect(net).toContain("registry.npmjs.org");
      expect(net).toContain("nodejs.org");
      // pip hosts
      expect(net).toContain("pypi.org");
      expect(net).toContain("files.pythonhosted.org");
      // no duplicates
      const unique = new Set(net);
      expect(unique.size).toBe(net.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("dev preset (npm + github sub-presets) contains expected hosts", () => {
    const dir = makeProject("presets: [dev]\n");
    try {
      runHook(dir);
      const net = hosts(readNetwork());
      expect(net).toContain("registry.npmjs.org");
      expect(net).toContain("github.com");
      expect(net).toContain("ghcr.io");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
