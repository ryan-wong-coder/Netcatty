"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerPluginShutdown,
  resetPluginShutdownForTests,
  runPluginShutdown,
} = require("./shutdownCoordinator.cjs");

test("plugin shutdown is idempotent and completes before its quit deadline", async (context) => {
  context.after(resetPluginShutdownForTests);
  let calls = 0;
  registerPluginShutdown(async () => { calls += 1; });
  const [first, second] = await Promise.all([runPluginShutdown(), runPluginShutdown()]);
  assert.deepEqual(first, { timedOut: false });
  assert.deepEqual(second, { timedOut: false });
  assert.equal(calls, 1);
});

test("plugin shutdown fails open after the bounded quit deadline", async (context) => {
  context.after(resetPluginShutdownForTests);
  registerPluginShutdown(async () => new Promise(() => {}));
  assert.deepEqual(await runPluginShutdown({ timeoutMs: 5 }), { timedOut: true });
});
