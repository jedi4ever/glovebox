import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCleanSession, type CleanSession, type SessionOptions } from "./session.js";
import { fixturePath } from "./fixtures.js";

export interface Scenario {
  projectDir: string;
  session: CleanSession;
  teardown: () => Promise<void>;
}

export interface SetupOptions extends SessionOptions {
  fixture?: string;
}

// Spins up an isolated project dir + clean session. Use inside an
// it.concurrent test with try/finally — call teardown() in finally.
export async function setupScenario(prefix: string, options: SetupOptions = {}): Promise<Scenario> {
  const projectDir = await mkdtemp(join(tmpdir(), prefix));
  if (options.fixture) {
    await cp(fixturePath(options.fixture), projectDir, { recursive: true });
  }
  const { fixture, ...sessionOptions } = options;
  void fixture;
  const session = await createCleanSession({ cwd: projectDir, ...sessionOptions });
  const teardown = async () => {
    await session.dispose();
    await rm(projectDir, { recursive: true, force: true });
  };
  return { projectDir, session, teardown };
}
