"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHANNELS,
  createTrustedPluginBridgeSender,
  registerPluginBridge,
} = require("./pluginBridge.cjs");

function createIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
  };
}

test("plugin management bridge is unavailable unless the local development gate is explicit", async () => {
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: null,
    env: {},
    isTrustedSender: () => true,
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), /runtime is disabled/);
});

test("plugin management bridge fails closed when the host manager is unavailable", async () => {
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: null,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), /disabled or unavailable/);
});

test("plugin management bridge checks sender ownership before invoking manager", async () => {
  const calls = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: {
      initialize: async () => {},
      list: async () => [],
      install: async (...args) => calls.push(args),
      setEnabled: async () => null,
      restart: async () => null,
      uninstall: async () => true,
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: createTrustedPluginBridgeSender({ devServerUrl: "http://localhost:5173" }),
  });
  const trusted = { senderFrame: { url: "app://netcatty/index.html" } };
  await ipcMain.handlers.get(CHANNELS.install)(trusted, { archivePath: "/plugin.ncpkg", enable: true });
  assert.deepEqual(calls, [["/plugin.ncpkg", { enable: true }]]);
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.list)({ senderFrame: { url: "https://attacker.invalid/" } }),
    /Untrusted/,
  );
});

test("plugin management availability follows asynchronous host initialization", async () => {
  const ipcMain = createIpcMain();
  let listCalls = 0;
  const initializationError = new Error("package recovery failed");
  registerPluginBridge(ipcMain, {
    manager: {
      initialize: async () => { throw initializationError; },
      list: async () => { listCalls += 1; return []; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), (error) => (
    error.message.includes("disabled or unavailable") && error.cause === initializationError
  ));
  assert.equal(listCalls, 0);
});
