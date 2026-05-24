import { describe, it, expect, afterEach } from "vitest";
import { createCleanSession, type CleanSession } from "../helpers/session.js";

describe("clean session", () => {
  let session: CleanSession | undefined;

  afterEach(async () => {
    await session?.dispose();
  });

  it("creates a session with an isolated config dir", async () => {
    session = await createCleanSession();
    expect(session.configDir).toMatch(/glovebox-test-/);
  });
});
