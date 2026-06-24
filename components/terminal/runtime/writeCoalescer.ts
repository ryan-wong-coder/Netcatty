/**
 * Coalesces PTY output chunks into one xterm.write() per animation frame.
 *
 * Agent CLIs (Codex, Claude Code) emit full-screen repaints as many small PTY
 * chunks. Writing each chunk individually triggers an xterm parse/render cycle
 * per chunk, which can tear TUI frames (missing box borders, clipped bottom
 * rows). Batching to the display refresh rate keeps rendering atomic per frame.
 *
 * Ported from superset-sh/superset (issues #2241 / #2244):
 * apps/desktop/src/renderer/lib/terminal/write-coalescer.ts
 */

/** Pending-byte ceiling when rAF is throttled (hidden window). */
export const MAX_PENDING_WRITE_COALESCE_BYTES = 1024 * 1024;

export type WriteCoalescer = {
  push(chunk: string): void;
  /** Flush pending bytes synchronously before ordered writes (exit notices). */
  flushSync(): void;
  dispose(): void;
};

export const createWriteCoalescer = (write: (data: string) => void): WriteCoalescer => {
  let pending: string[] = [];
  let pendingBytes = 0;
  let frameId: number | null = null;
  let disposed = false;

  const flushSync = (): void => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (pendingBytes === 0) {
      return;
    }
    const batch = pending.length === 1 ? pending[0]! : pending.join("");
    pending = [];
    pendingBytes = 0;
    write(batch);
  };

  const push = (chunk: string): void => {
    if (disposed || chunk.length === 0) {
      return;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes > MAX_PENDING_WRITE_COALESCE_BYTES) {
      flushSync();
      return;
    }
    if (frameId === null) {
      frameId = requestAnimationFrame(() => {
        frameId = null;
        flushSync();
      });
    }
  };

  return {
    push,
    flushSync,
    dispose() {
      if (disposed) {
        return;
      }
      flushSync();
      disposed = true;
    },
  };
};
