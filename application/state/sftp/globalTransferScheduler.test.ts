import assert from "node:assert/strict";
import test from "node:test";

import { createGlobalSftpTransferScheduler } from "./globalTransferScheduler";

test("scheduler enforces one global limit across owners", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let id = 0;
  const run = (ownerId: string) => scheduler.run(ownerId, `${ownerId}-${id += 1}`, () => 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });

  const jobs = [run("a"), run("a"), run("b"), run("b")];
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  releases.shift()?.();
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await jobs;
  assert.equal(maxActive, 2);
});

test("scheduler alternates owners when both have queued work", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;

  const first = scheduler.run("a", "a1", () => 1, async () => {
    order.push("a1");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const a2 = scheduler.run("a", "a2", () => 1, async () => { order.push("a2"); });
  const b1 = scheduler.run("b", "b1", () => 1, async () => { order.push("b1"); });

  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, a2, b1]);
  assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("prioritize moves a queued transfer ahead of fairness ordering", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run("a", "a1", () => 1, async () => {
    order.push("a1");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const b1 = scheduler.run("b", "b1", () => 1, async () => { order.push("b1"); });
  const a2 = scheduler.run("a", "a2", () => 1, async () => { order.push("a2"); });
  scheduler.prioritize("a2");
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, b1, a2]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});

test("queued work stays paused until resumed and can be cancelled", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run("a", "a1", () => 1, async () => {
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
  });
  const paused = scheduler.run("b", "b1", () => 1, async () => { order.push("b1"); });
  const cancelled = scheduler.run("c", "c1", () => 1, async () => { order.push("c1"); });
  assert.equal(scheduler.pause("b1"), true);
  assert.equal(scheduler.cancel("c1"), true);
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await first;
  await assert.rejects(cancelled, /Transfer cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  assert.equal(scheduler.resume("b1"), true);
  await paused;
  assert.deepEqual(order, ["b1"]);
});
