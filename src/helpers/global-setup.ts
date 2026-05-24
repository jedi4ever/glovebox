// Global setup: remove glovebox-test-* sandboxes left over from interrupted
// test runs. All fixed-name integration test sandboxes use this prefix so
// the cleanup is a single prefix scan with no explicit name list.

export async function setup() {
  let removeSandbox: (name: string) => Promise<void>;
  let listSandboxNames: (prefix?: string) => Promise<string[]>;
  try {
    ({ removeSandbox, listSandboxNames } = await import("./msb-sdk.js"));
  } catch {
    return;
  }
  const names = await listSandboxNames("glovebox-test-").catch(() => []);
  await Promise.all(names.map((n) => removeSandbox(n).catch(() => {})));
}
