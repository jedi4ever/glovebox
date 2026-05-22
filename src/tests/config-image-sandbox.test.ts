import { describe, it, expect } from "vitest";
import { setupScenario } from "../helpers/scenario.js";

describe.concurrent("config — sandbox_image integration", () => {
  it("sandbox runs on the default ubuntu image when no config file is present", async () => {
    const { session, teardown } = await setupScenario("cc-msb-image-default-");
    try {
      const result = await session.run(
        "Run a bash command to read /etc/os-release and tell me what NAME= says."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ubuntu/i);
    } finally {
      await teardown();
    }
  });

  it("sandbox runs on the image specified in the config file (debian)", async () => {
    const { session, teardown } = await setupScenario("cc-msb-image-config-", { fixture: "config-image-debian" });
    try {
      const result = await session.run(
        "Run a bash command to read /etc/os-release and tell me what NAME= says."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/debian/i);
    } finally {
      await teardown();
    }
  });

  it("sandbox runs on the image specified in the config file (alpine)", async () => {
    const { session, teardown } = await setupScenario("cc-msb-image-alpine-", { fixture: "config-image-alpine" });
    try {
      const result = await session.run(
        "Run a bash command to read /etc/os-release and tell me what NAME= says."
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/alpine/i);
    } finally {
      await teardown();
    }
  });
});
