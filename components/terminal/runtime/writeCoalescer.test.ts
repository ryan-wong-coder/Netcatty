import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  createWriteCoalescer,
  MAX_PENDING_WRITE_COALESCE_BYTES,
} from "./writeCoalescer.ts";

type FrameCallback = (time: number) => void;

let frameCallbacks: Map<number, FrameCallback>;
let nextFrameId: number;
let originalRaf: typeof requestAnimationFrame;
let originalCancelRaf: typeof cancelAnimationFrame;

const fireFrame = (): void => {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) {
    callback(performance.now());
  }
};

beforeEach(() => {
  frameCallbacks = new Map();
  nextFrameId = 1;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frameCallbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    frameCallbacks.delete(id);
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
});

test("coalesces chunks in the same frame into one write", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data));

  coalescer.push("foo");
  coalescer.push("bar");
  coalescer.push("baz");
  assert.equal(writes.length, 0);

  fireFrame();
  assert.deepEqual(writes, ["foobarbaz"]);
});

test("schedules a new frame for data arriving after a flush", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data));

  coalescer.push("first");
  fireFrame();
  coalescer.push("second");
  fireFrame();

  assert.deepEqual(writes, ["first", "second"]);
});

test("flushSync writes pending bytes immediately and cancels the scheduled frame", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data));

  coalescer.push("pending");
  coalescer.flushSync();
  assert.deepEqual(writes, ["pending"]);

  fireFrame();
  assert.deepEqual(writes, ["pending"]);
});

test("flushes synchronously when pending bytes exceed the cap", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data));
  const chunk = "x".repeat(MAX_PENDING_WRITE_COALESCE_BYTES);

  coalescer.push(chunk);
  coalescer.push("y");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, MAX_PENDING_WRITE_COALESCE_BYTES + 1);
});

test("dispose flushes remaining bytes and stops accepting new chunks", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data));

  coalescer.push("tail");
  coalescer.dispose();
  assert.deepEqual(writes, ["tail"]);

  coalescer.push("ignored");
  fireFrame();
  assert.deepEqual(writes, ["tail"]);
});
