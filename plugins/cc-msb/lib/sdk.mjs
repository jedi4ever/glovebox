// Shared SDK loader — resolves the microsandbox package via npm install or
// via the msb binary's realpath (works with nvm/fnm/global installs).
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSdk() {
  try { return await import('microsandbox'); } catch {}
  const msbBin = execSync('command -v msb', { encoding: 'utf8' }).trim();
  const pkgDir = resolve(dirname(realpathSync(msbBin)), '..');
  return await import(pathToFileURL(`${pkgDir}/dist/index.js`).href);
}
