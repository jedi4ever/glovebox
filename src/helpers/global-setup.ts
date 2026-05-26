// Global setup: remove glovebox-test-* sandboxes left over from interrupted
// test runs, and ensure all images used by fixtures are pulled into msb.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../tests/fixtures', import.meta.url));
const CONFIG_MERGE = fileURLToPath(new URL('../../plugins/glovebox/lib/config-merge.mjs', import.meta.url));

function fixtureImages(): string[] {
  const images = new Set<string>();
  for (const name of readdirSync(FIXTURES_DIR)) {
    const cfg = join(FIXTURES_DIR, name, '.glovebox.yml');
    try {
      if (!statSync(cfg).isFile()) continue;
      for (const m of readFileSync(cfg, 'utf8').matchAll(/sandbox_image:\s*(\S+)/g))
        if (m[1]) images.add(m[1]);
    } catch { /* no config or unreadable */ }
  }
  return [...images];
}

export async function setup() {
  let removeSandbox: (name: string) => Promise<void>;
  let listSandboxNames: (prefix?: string) => Promise<string[]>;
  let ensureImage: (ref: string) => Promise<void>;
  try {
    ({ removeSandbox, listSandboxNames, ensureImage } = await import('./msb-sdk.js'));
  } catch {
    return;
  }

  // Pull default image + all images referenced in fixture configs.
  const { DEFAULT_SANDBOX_IMAGE } = await import(CONFIG_MERGE) as { DEFAULT_SANDBOX_IMAGE: string };
  const images = [DEFAULT_SANDBOX_IMAGE, ...fixtureImages()];
  await Promise.all(images.map((img) => ensureImage(img).catch((e) => console.warn(`[setup] pull failed for ${img}: ${e.message}`))));

  // Remove leftover sandboxes from previous runs.
  // 'glovebox-test-' covers the current test prefix (set via GLOVEBOX_SANDBOX_PREFIX).
  // 'glovebox-dir-' catches pre-prefix-feature leftovers (directory-scope VMs that
  // accumulated before sessions carried the test prefix).
  const prefixes = ['glovebox-test-', 'glovebox-dir-'];
  const allNames = (await Promise.all(
    prefixes.map((p) => listSandboxNames(p).catch(() => [] as string[]))
  )).flat();
  await Promise.all(allNames.map((n) => removeSandbox(n).catch(() => {})));
}
