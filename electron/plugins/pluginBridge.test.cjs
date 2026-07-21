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

test("plugin setting scope catalogs are bounded, sender-owned, and merged for settings windows", async () => {
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
  const broadcasts = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
    broadcast: (...args) => broadcasts.push(args),
  });
  let firstDestroyed;
  const first = {
    sender: {
      id: 1,
      once: (event, listener) => { if (event === "destroyed") firstDestroyed = listener; },
    },
  };
  const second = { sender: { id: 2, once() {} } };
  const settingsWindow = { sender: { id: 3, once() {} } };
  const next = { host: [{ id: "host-1", label: "Production" }] };
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(first, next);
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(second, {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Duplicate from second window" }],
  });
  const merged = {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [{ id: "device", label: "This device" }],
  };
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(first), merged);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(second), merged);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(settingsWindow), merged);
  assert.deepEqual(broadcasts.at(-1), [CHANNELS.scopeCatalogChanged, merged]);
  firstDestroyed();
  const afterFirstWindowClosed = {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Duplicate from second window" }],
    session: [],
    device: [{ id: "device", label: "This device" }],
  };
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(settingsWindow), afterFirstWindowClosed);
  assert.deepEqual(broadcasts.at(-1), [CHANNELS.scopeCatalogChanged, afterFirstWindowClosed]);
});

test("plugin terminal Provider bridge owns cancellation by renderer sender", async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  const pipelineCalls = [];
  let destroyed;
  const terminalProviderService = {
    listProviders(options) {
      calls.push(["list", options]);
      return [{ provider: { id: "com.example.completion" } }];
    },
    async provide(request, options) {
      calls.push(["provide", request]);
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve([{ status: "cancelled" }]), { once: true });
      });
    },
    async publishSessionEvent(event) {
      calls.push(["event", event]);
      return [{ pluginId: "com.example", delivered: true }];
    },
  };
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    terminalProviderService,
    terminalDataPipelineService: {
      async handleSessionEvent(payload, options) {
        pipelineCalls.push([payload, options]);
        return [{ direction: "input", attached: true }];
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 42,
      once(name, listener) { if (name === "destroyed") destroyed = listener; },
    },
  };

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalProviders)(event, {
    kind: "terminal.completion",
  }), [{ provider: { id: "com.example.completion" } }]);
  const pending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "renderer-request-1",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "renderer-request-1",
  }), true);
  assert.deepEqual(await pending, [{ status: "cancelled" }]);
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "renderer-request-1",
  }), false);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalSessionEvent)(event, {
    type: "created",
    session: { sessionId: "session-1" },
  }), [{ pluginId: "com.example", delivered: true }]);
  assert.deepEqual(pipelineCalls, [[
    { type: "created", session: { sessionId: "session-1" } },
    { webContentsId: 42 },
  ]]);
  assert.equal(typeof destroyed, "function");
  const destroyedPending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "renderer-request-destroyed",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  destroyed();
  assert.deepEqual(await destroyedPending, [{ status: "cancelled" }]);
  assert.deepEqual(calls, [
    ["list", { kind: "terminal.completion" }],
    ["provide", {
      kind: "terminal.completion",
      operation: "provideCompletions",
      session: { sessionId: "session-1" },
    }],
    ["event", { type: "created", session: { sessionId: "session-1" } }],
    ["provide", {
      kind: "terminal.completion",
      operation: "provideCompletions",
      session: { sessionId: "session-1" },
    }],
  ]);
});

test("plugin terminal Provider bridge releases cancellation during host initialization", async () => {
  const ipcMain = createIpcMain();
  let releaseInitialization;
  let initializationStarted;
  const started = new Promise((resolve) => { initializationStarted = resolve; });
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });
  const observedSignals = [];
  registerPluginBridge(ipcMain, {
    manager: {
      async initialize() {
        initializationStarted();
        await initialization;
      },
    },
    terminalProviderService: {
      async provide(_request, options) {
        observedSignals.push(options.signal);
        return [{ status: options.signal.aborted ? "cancelled" : "ok" }];
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 84, once() {} } };
  const pending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "cancel-during-initialize",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await started;
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "cancel-during-initialize",
  }), true);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(observedSignals.length, 0);
  releaseInitialization();
  const retry = await ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "after-cancelled-initialize",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  assert.deepEqual(retry, [{ status: "ok" }]);
  assert.equal(observedSignals.length, 1);
  assert.equal(observedSignals[0].aborted, false);
});
