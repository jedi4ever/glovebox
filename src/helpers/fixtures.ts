import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(
  new URL("../tests/fixtures", import.meta.url)
);

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES_DIR, ...parts);
}
