"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHANNELS,
  createTrustedPluginBridgeSender,
  registerPluginBridge,
  normalizePluginScopeCatalog,
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

test("plugin view host closures are broadcast to renderer windows", async () => {
  const ipcMain = createIpcMain();
  const broadcasts = [];
  let closeListener;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    contributionService: {},
    viewHost: {
      onDidClose(listener) { closeListener = listener; return { dispose() {} }; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
    broadcast: (...args) => broadcasts.push(args),
  });
  const event = {
    instanceId: "view-1",
    pluginId: "com.example.view",
    viewId: "com.example.view.panel",
    reason: "runtime-error",
  };
  closeListener(event);
  assert.deepEqual(broadcasts, [[CHANNELS.viewClosed, event]]);
});

test("plugin contribution icon requests use the host-owned resolver", async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    resolveContributionIcon: async (payload) => {
      calls.push(payload);
      return { light: "data:image/png;base64,bGlnaHQ=" };
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const payload = {
    pluginId: "com.example.icon",
    icon: { kind: "package", light: "assets/icon.png" },
  };

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.contributionIcon)({}, payload), {
    light: "data:image/png;base64,bGlnaHQ=",
  });
  assert.deepEqual(calls, [payload]);
});

test("plugin setting scope catalogs are bounded, deduplicated, and isolated by renderer window", async () => {
  assert.deepEqual(normalizePluginScopeCatalog({
    host: [{ id: "host-1", label: "Production" }, { id: "host-1", label: "Duplicate" }],
    workspace: [{ id: "", label: "Invalid" }],
  }), {
    workspace: [],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [],
  });

  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const firstEvents = [];
  const secondEvents = [];
  let firstDestroyed;
  const first = {
    sender: {
      id: 1,
      send: (...args) => firstEvents.push(args),
      once: (event, listener) => { if (event === "destroyed") firstDestroyed = listener; },
    },
  };
  const second = { sender: { id: 2, send: (...args) => secondEvents.push(args), once() {} } };
  const next = { host: [{ id: "host-1", label: "Production" }] };
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(first, next);
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(second, {
    workspace: [{ id: "workspace-2", label: "Second window" }],
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(first), {
    workspace: [],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [],
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(second), {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [],
    session: [],
    device: [],
  });
  assert.deepEqual(firstEvents, [[CHANNELS.scopeCatalogChanged, {
    workspace: [],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [],
  }]]);
  assert.equal(secondEvents.length, 1);
  firstDestroyed();
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(first), {
    workspace: [],
    host: [],
    session: [],
    device: [{ id: "device", label: "This device" }],
  });
});
