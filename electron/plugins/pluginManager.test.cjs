"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginManager } = require("./pluginManager.cjs");

test("failed activation leaves a newly installed plugin disabled", async () => {
  const plugin = { id: "com.example.activation-failure", enabled: true };
  let enabled = true;
  const manager = new PluginManager({
    database: {
      close() {},
      listPlugins: () => [],
      setEnabled(pluginId, nextEnabled) {
        assert.equal(pluginId, plugin.id);
        enabled = nextEnabled;
      },
    },
    packageStore: {
      async initialize() {},
      async install() { return plugin; },
    },
    runtimeSupervisor: {
      async start() { throw new Error("activation failed"); },
      async startEnabled() {},
      async stop() {},
    },
  });

  await assert.rejects(manager.install("/tmp/plugin.ncpkg", { enable: true }), /activation failed/);
  assert.equal(enabled, false);
});

test("management mutations are serialized in invocation order", async () => {
  const calls = [];
  let releaseInstall;
  const installBlocked = new Promise((resolve) => { releaseInstall = resolve; });
  const manager = new PluginManager({
    database: {
      close() {},
      getActivePlugin: (pluginId) => ({ id: pluginId, enabled: false }),
      listPlugins: () => [],
      setEnabled(pluginId, enabled) { calls.push(`enabled:${pluginId}:${enabled}`); },
    },
    packageStore: {
      async initialize() {},
      async install() {
        calls.push("install:start");
        await installBlocked;
        calls.push("install:end");
        return { id: "com.example.serial", enabled: false };
      },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(pluginId) { calls.push(`stop:${pluginId}`); },
    },
  });

  const install = manager.install("/tmp/plugin.ncpkg");
  const disable = manager.setEnabled("com.example.serial", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["install:start"]);
  releaseInstall();
  await Promise.all([install, disable]);
  assert.deepEqual(calls, [
    "install:start",
    "install:end",
    "stop:com.example.serial",
    "enabled:com.example.serial:false",
  ]);
});

test("installing an enabled version replaces the active runtime", async () => {
  const calls = [];
  const plugin = { id: "com.example.upgrade", enabled: true };
  const manager = new PluginManager({
    database: { close() {}, listPlugins: () => [], setEnabled() {} },
    packageStore: {
      async initialize() {},
      async install() { return plugin; },
    },
    runtimeSupervisor: {
      async startEnabled() {},
      async stop(pluginId) { calls.push(`stop:${pluginId}`); },
      async start(pluginId) { calls.push(`start:${pluginId}`); },
    },
  });
  assert.equal(await manager.install("/tmp/upgrade.ncpkg"), plugin);
  assert.deepEqual(calls, ["stop:com.example.upgrade", "start:com.example.upgrade"]);
});
