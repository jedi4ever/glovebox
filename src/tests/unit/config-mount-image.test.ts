import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixturePath } from "../../helpers/fixtures.js";
import { createConfigTestContext } from "../../helpers/config-hook.js";

const { runHook, readCreateArgs, readCreateConfig, PER_AGENT_SANDBOX, cleanupFakeMsbFiles } =
  createConfigTestContext("unit-mnt-img-001");

beforeEach(() => cleanupFakeMsbFiles());
afterEach(() => cleanupFakeMsbFiles());

describe("config — mount_workdir", () => {
  it("mounts workdir by default (no config file)", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()).toContain("--volume");
  });

  it("mounts workdir when config file sets mount_workdir: true", () => {
    runHook(fixturePath("config-mount-on"));
    expect(readCreateArgs()).toContain("--volume");
  });

  it("does not mount workdir when config file sets mount_workdir: false", () => {
    runHook(fixturePath("config-mount-off"));
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("env var CC_MSB_MAIN_MOUNT_WORKDIR=false overrides config file true", () => {
    runHook(fixturePath("config-mount-on"), { CC_MSB_MAIN_MOUNT_WORKDIR: "false" });
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("env var CC_MSB_MAIN_MOUNT_WORKDIR=true overrides config file false", () => {
    runHook(fixturePath("config-mount-off"), { CC_MSB_MAIN_MOUNT_WORKDIR: "true" });
    expect(readCreateArgs()).toContain("--volume");
  });

  it("env var CC_MSB_AGENT_MOUNT_WORKDIR=false disables mount for agents", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_AGENT_SCOPE_TEST_AGENT: "per-agent", CC_MSB_AGENT_MOUNT_WORKDIR: "false" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)).not.toContain("--volume");
  });

  it("config file supports quoted values (mount_workdir: 'false')", () => {
    runHook(fixturePath("config-quoted-false"));
    expect(readCreateArgs()).not.toContain("--volume");
  });

  it("config file ignores comments after value", () => {
    runHook(fixturePath("config-mount-off"));
    expect(readCreateArgs()).not.toContain("--volume");
  });
});

describe("config — sandbox_image", () => {
  it("uses ubuntu by default (no config file)", () => {
    runHook(fixturePath("simple-read"));
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("uses image from config file", () => {
    runHook(fixturePath("config-image-debian"));
    expect(readCreateArgs()[0]).toBe("debian");
  });

  it("env var CC_MSB_SANDBOX_IMAGE overrides config file", () => {
    runHook(fixturePath("config-image-debian"), { CC_MSB_SANDBOX_IMAGE: "alpine" });
    expect(readCreateArgs()[0]).toBe("alpine");
  });

  it("env var CC_MSB_SANDBOX_IMAGE overrides default when no config file", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_SANDBOX_IMAGE: "alpine" });
    expect(readCreateArgs()[0]).toBe("alpine");
  });

  it("accepts a registry-qualified image reference (localhost:5000/devbox)", () => {
    const localDir = mkdtempSync(join(tmpdir(), "cc-msb-registry-"));
    writeFileSync(
      join(localDir, ".cc-msb.yml"),
      "main:\n  sandbox_image: localhost:5000/devbox\n  network: disabled\n"
    );
    try {
      runHook(localDir);
      const args = readCreateArgs();
      expect(args[0]).toBe("localhost:5000/devbox");
      expect(args).toContain("--no-net");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("accepts a registry image with an explicit tag (registry.example.com:5000/devbox:v1.2)", () => {
    const localDir = mkdtempSync(join(tmpdir(), "cc-msb-registry-tag-"));
    writeFileSync(
      join(localDir, ".cc-msb.yml"),
      "main:\n  sandbox_image: registry.example.com:5000/devbox:v1.2\n"
    );
    try {
      runHook(localDir);
      expect(readCreateArgs()[0]).toBe("registry.example.com:5000/devbox:v1.2");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});

describe("config — agent-specific image", () => {
  it("uses agent-specific image from config when agent_type matches", () => {
    runHook(fixturePath("config-agent-image"), {}, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("debian");
  });

  it("falls back to global sandbox_image for an unlisted agent", () => {
    runHook(fixturePath("config-agent-image"), {}, "other-agent");
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("falls back to global sandbox_image when no agent_type in event", () => {
    runHook(fixturePath("config-agent-image"));
    expect(readCreateArgs()[0]).toBe("ubuntu");
  });

  it("env var CC_MSB_AGENT_IMAGE_<NAME> overrides config file for that agent", () => {
    runHook(fixturePath("config-agent-image"), { CC_MSB_AGENT_IMAGE_TEST_AGENT: "alpine" }, "test-agent");
    expect(readCreateArgs(PER_AGENT_SANDBOX)[0]).toBe("alpine");
  });

  it("env var CC_MSB_AGENT_IMAGE_<NAME> with hyphenated agent name (test-agent → TEST_AGENT)", () => {
    runHook(fixturePath("simple-read"), { CC_MSB_AGENT_IMAGE_TEST_AGENT: "alpine" }, "test-agent");
    expect(readCreateArgs()[0]).toBe("alpine");
  });
});
