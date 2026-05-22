import * as pty from "node-pty";
import { Terminal } from "@xterm/headless";

export interface TUIOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface TUI {
  send(s: string): void;
  sendLine(s: string): void;
  expect(pat: RegExp | string, opts?: { timeout?: number; quietMs?: number }): Promise<string>;
  visible(): string;
  quiet(ms?: number, timeout?: number): Promise<void>;
  cursor(): { x: number; y: number };
  kill(): void;
}

// Spawns `cmd` under a PTY, renders its output through a headless xterm so the
// terminal state (scrollback + screen) is queryable, and exposes send/expect
// helpers for keystroke-driven assertions. Inspired by a snippet contributed
// by the user.
export function spawnTUI(cmd: string, args: string[] = [], options: TUIOptions = {}): TUI {
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 30;

  const t = pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      ...(options.env ?? {}),
    } as Record<string, string>,
  });

  const screen = new Terminal({ cols, rows, allowProposedApi: true });
  let lastDataAt = Date.now();

  t.onData((d) => {
    screen.write(d);
    lastDataAt = Date.now();
  });

  function visible(): string {
    const buf = screen.buffer.active;
    const lines: string[] = [];
    const total = buf.length;
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true).trimEnd());
    }
    return lines.join("\n");
  }

  async function quiet(ms = 150, timeout = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (Date.now() - lastDataAt >= ms) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("TUI never settled");
  }

  async function expectVisible(
    pat: RegExp | string,
    { timeout = 10_000, quietMs = 120 }: { timeout?: number; quietMs?: number } = {}
  ): Promise<string> {
    const re =
      typeof pat === "string"
        ? new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        : pat;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (Date.now() - lastDataAt >= quietMs && re.test(visible())) {
        return visible();
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout waiting for ${pat}\nscreen:\n${visible().slice(-2000)}`);
  }

  return {
    send: (s) => t.write(s),
    sendLine: (s) => t.write(s + "\r"),
    expect: expectVisible,
    visible,
    quiet,
    cursor: () => ({ x: screen.buffer.active.cursorX, y: screen.buffer.active.cursorY }),
    kill: () => t.kill(),
  };
}
