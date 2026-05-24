// SDK-backed helpers for integration tests. Avoids shelling out to the
// `msb` CLI — the SDK is already a dep (installed alongside the msb binary).

const SDK_URL = new URL("../../plugins/glovebox/lib/sdk.mjs", import.meta.url).href;

type SandboxHandle = { name: string; status: string; configJson: string; stop(): Promise<void>; remove(): Promise<void> };
type SandboxBuilderChain = { createDetached(): Promise<unknown>; replace(): SandboxBuilderChain };
type SandboxClass = {
  list(): Promise<SandboxHandle[]>;
  remove(name: string): Promise<void>;
  builder(name: string): { image(img: string): SandboxBuilderChain };
};
type SnapshotClass = {
  remove(nameOrPath: string, opts?: { force?: boolean }): Promise<void>;
};
type ImageHandle = { reference: string };
type ImageClass = { list(): Promise<ImageHandle[]> };

let _Sandbox: SandboxClass | null = null;
let _Snapshot: SnapshotClass | null = null;
let _Image: ImageClass | null = null;

async function sdk(): Promise<{ Sandbox: SandboxClass; Snapshot: SnapshotClass; Image: ImageClass }> {
  if (_Sandbox && _Snapshot && _Image) return { Sandbox: _Sandbox, Snapshot: _Snapshot, Image: _Image };
  const { loadSdk } = await import(SDK_URL) as {
    loadSdk(): Promise<{ Sandbox: SandboxClass; Snapshot: SnapshotClass; Image: ImageClass }>
  };
  const loaded = await loadSdk();
  _Sandbox = loaded.Sandbox;
  _Snapshot = loaded.Snapshot;
  _Image = loaded.Image;
  return loaded;
}

/** Remove a sandbox by name, stopping it first if running. Silently ignores not-found. */
export async function removeSandbox(name: string): Promise<void> {
  try {
    const { Sandbox } = await sdk();
    const handles = await Sandbox.list();
    const handle = handles.find((h) => h.name === name);
    if (!handle) return;
    if (handle.status === "running" || handle.status === "draining") {
      try {
        // connect() + stopAndWait() ensures the sandbox is fully stopped before remove().
        // handle.stop() is fire-and-forget; calling remove() immediately after fails.
        const live = await handle.connect();
        await live.stopAndWait();
      } catch {
        // Sandbox stopped mid-flight or connect failed — try direct stop + poll.
        try { await handle.stop(); } catch {}
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const h2 = await Sandbox.get(name);
            if (h2.status !== "running" && h2.status !== "draining") break;
          } catch { break; }
        }
      }
    }
    await handle.remove();
  } catch {
    // Not found or already removed — both are fine.
  }
}

/** Return the raw configJson string for a named sandbox, or null if not found. */
export async function getSandboxConfigJson(name: string): Promise<string | null> {
  try {
    const { Sandbox } = await sdk();
    const handles = await Sandbox.list();
    const handle = handles.find((h) => h.name === name);
    return handle ? handle.configJson : null;
  } catch {
    return null;
  }
}

/** Remove a snapshot by name (force). Silently ignores not-found. */
export async function removeSnapshot(name: string): Promise<void> {
  try {
    const { Snapshot } = await sdk();
    await Snapshot.remove(name, { force: true });
  } catch {
    // Not found or already removed.
  }
}

/** Create a minimal sandbox (detached) using the given image. Replaces any existing sandbox with the same name. */
export async function createSandbox(name: string, image: string): Promise<void> {
  const { Sandbox } = await sdk();
  await Sandbox.builder(name).image(image).replace().createDetached();
}

/** List all sandbox names matching a prefix. */
export async function listSandboxNames(prefix?: string): Promise<string[]> {
  const { Sandbox } = await sdk();
  const handles = await Sandbox.list();
  const names = handles.map((h) => h.name);
  return prefix ? names.filter((n) => n.startsWith(prefix)) : names;
}

/** Return all pulled image references (e.g. "ubuntu", "localhost:5123/glovebox"). */
export async function listImageRefs(): Promise<string[]> {
  const { Image } = await sdk();
  const handles = await Image.list();
  return handles.map((h) => h.reference);
}
