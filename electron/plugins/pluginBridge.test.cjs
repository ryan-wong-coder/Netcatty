"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, rename, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
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

test("plugin Vault credential catalog updates only through the trusted host bridge", async () => {
  const ipcMain = createIpcMain();
  const updates = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    credentialResolver: {
      update(entries) { updates.push(entries); return entries.length; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: (event) => event?.trusted === true,
  });
  const entries = [{ id: "credential-reference-0001", ciphertext: "enc:v1:Y2lwaGVy" }];
  assert.equal(await ipcMain.handlers.get(CHANNELS.credentialCatalogUpdate)(
    { trusted: true },
    { entries },
  ), 1);
  assert.deepEqual(updates, [entries]);
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.credentialCatalogUpdate)({ trusted: false }, { entries }),
    /Untrusted/i,
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

test("plugin extension Provider requests are cancellable and sender-owned", async () => {
  const ipcMain = createIpcMain();
  let destroyed;
  const calls = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async invoke(payload, options) {
        calls.push(payload);
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
        });
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 73,
      once(name, listener) { if (name === "destroyed") destroyed = listener; },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.extensionInvoke)(event, {
    requestId: "extension-request-1",
    providerId: "com.example.transport.connection",
    kind: "connection",
    operation: "probe",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ipcMain.handlers.get(CHANNELS.extensionCancel)(event, {
    requestId: "extension-request-1",
  }), true);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(await ipcMain.handlers.get(CHANNELS.extensionCancel)(event, {
    requestId: "extension-request-1",
  }), false);
  assert.equal(typeof destroyed, "function");
  assert.equal(calls.length, 1);
});

test("generic extension invocation cannot bypass authentication or connection-session ownership", async () => {
  const ipcMain = createIpcMain();
  let calls = 0;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async invoke() { calls += 1; return null; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const invoke = ipcMain.handlers.get(CHANNELS.extensionInvoke);
  const event = { sender: { once() {}, id: 41 } };
  await assert.rejects(invoke(event, {
    requestId: "auth-bypass",
    kind: "authentication",
    providerId: "com.example.auth.provider",
    operation: "respond",
    payload: { response: "plaintext" },
  }), /dedicated host workflow/i);
  await assert.rejects(invoke(event, {
    requestId: "connection-bypass",
    kind: "connection",
    providerId: "com.example.connection.provider",
    operation: "close",
    payload: { connectionId: "not-owned" },
  }), /dedicated host workflow/i);
  assert.equal(calls, 0);
});

test("plugin importer files use sender-owned native selections and bounded streaming", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "netcatty-plugin-importer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "hosts.json");
  await writeFile(filePath, "streamed-import");
  const parsed = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async parseImporter(params, options) {
        for await (const chunk of params.source) parsed.push(Buffer.from(chunk));
        assert.equal(params.sourceByteLength, 15);
        assert.equal(params.fileName, "hosts.json");
        options.onProgress({ type: "progress", completed: 1, total: 2, message: "Reading" });
        return { providerId: params.providerId, result: { parsed: 0, warnings: 0, errors: 0 }, records: [] };
      },
    },
    selectImporterFile: async () => filePath,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const progressEvents = [];
  const first = { sender: {
    id: 1,
    once() {},
    isDestroyed: () => false,
    send(channel, payload) { progressEvents.push([channel, payload]); },
  } };
  const second = { sender: { id: 2, once() {} } };
  const selection = await ipcMain.handlers.get(CHANNELS.importerSelectFile)(first, {});
  assert.equal(selection.fileName, "hosts.json");
  assert.equal(Buffer.from(selection.sample).toString(), "streamed-import");
  await assert.rejects(ipcMain.handlers.get(CHANNELS.importerParseFile)(second, {
    requestId: "other-window",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  }), /selection expired/i);
  await rename(filePath, `${filePath}.selected`);
  await writeFile(filePath, "path-replaced!!");
  const preview = await ipcMain.handlers.get(CHANNELS.importerParseFile)(first, {
    requestId: "owner-window",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  });
  assert.equal(preview.providerId, "com.example.importer");
  assert.equal(Buffer.concat(parsed).toString(), "streamed-import");
  assert.deepEqual(progressEvents, [[CHANNELS.importerProgress, {
    requestId: "owner-window",
    providerId: "com.example.importer",
    progress: { type: "progress", completed: 1, total: 2, message: "Reading" },
  }]]);
  await assert.rejects(ipcMain.handlers.get(CHANNELS.importerParseFile)(first, {
    requestId: "replay",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  }), /selection expired/i);
});

test("plugin connection authentication uses host-rendered sender-owned challenges", async () => {
  const ipcMain = createIpcMain();
  const sent = [];
  const calls = [];
  const external = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async authenticate(params, requestChallenge) {
        calls.push(["authenticate", params]);
        const response = await requestChallenge({
          id: "password-1",
          kind: "password",
          title: "Password",
        });
        calls.push(["response", response]);
        return {
          status: "authenticated",
          credential: { kind: "credential", id: "credential-after-auth" },
        };
      },
      async openConnection(params, options) {
        calls.push(["open", params]);
        await options.onData(Uint8Array.from([65]));
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { external.push(["start", options]); return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data) { external.push(["output", sessionId, data]); },
      async finishExternalSession(sessionId, details) { external.push(["finish", sessionId, details]); },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 74,
      once() {},
      isDestroyed: () => false,
      send(channel, payload) { sent.push([channel, payload]); },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-auth-1",
    sessionId: "session-auth-1",
    providerId: "com.example.transport.connection",
    authenticationProviderId: "com.example.transport.authentication",
    configuration: { host: "example.test" },
    columns: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], CHANNELS.authenticationChallenge);
  const challengeEvent = sent[0][1];
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.authenticationRespond)({ sender: { id: 75, once() {} } }, {
      ...challengeEvent,
      challengeId: challengeEvent.challenge.id,
      response: "stolen",
    }),
    /not owned/,
  );
  await ipcMain.handlers.get(CHANNELS.authenticationRespond)(event, {
    requestId: challengeEvent.requestId,
    challengeRequestId: challengeEvent.challengeRequestId,
    challengeId: challengeEvent.challenge.id,
    response: "secret answer",
  });
  assert.deepEqual(await pending, {
    sessionId: "session-auth-1",
    providerId: "com.example.transport.connection",
    status: "connected",
    diagnostics: [],
  });
  assert.deepEqual(calls[0], ["authenticate", {
    providerId: "com.example.transport.authentication",
    connectionProviderId: "com.example.transport.connection",
    configuration: { host: "example.test" },
  }]);
  assert.deepEqual(calls[1], ["response", "secret answer"]);
  assert.deepEqual(calls[2][0], "open");
  assert.deepEqual(calls[2][1].credential, {
    kind: "credential",
    id: "credential-after-auth",
  });
  assert.equal(external[0][0], "start");
  assert.equal(external[0][1].sessionId, "session-auth-1");
  assert.deepEqual(external[1], ["output", "session-auth-1", Uint8Array.from([65])]);
});

test("plugin connection status monitoring releases silent connected sessions", async () => {
  const ipcMain = createIpcMain();
  const statusCalls = [];
  let resolveConnectedOutput;
  const connectedOutput = new Promise((resolve) => { resolveConnectedOutput = resolve; });
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connecting", diagnostics: [] };
      },
      async control(sessionId, operation, payload, options) {
        statusCalls.push([sessionId, operation, payload, options.signal.aborted]);
        return { status: statusCalls.length === 1 ? "connecting" : "connected" };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data) { resolveConnectedOutput([sessionId, data]); },
      async finishExternalSession() { return true; },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 77, once() {}, isDestroyed: () => false } };
  const opened = await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-silent-start",
    sessionId: "session-silent-start",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.equal(opened.status, "connecting");
  assert.deepEqual(await connectedOutput, ["session-silent-start", ""]);
  assert.equal(statusCalls.length, 2);
  assert.equal(statusCalls.every((call) => call[1] === "getStatus" && call[3] === false), true);
});

test("plugin connections that open connected release silent terminal startup", async () => {
  const ipcMain = createIpcMain();
  const output = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data) { output.push([sessionId, data]); return true; },
      async finishExternalSession() { return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 79, once() {}, isDestroyed: () => false } };
  const opened = await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-silent-connected",
    sessionId: "session-silent-connected",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.equal(opened.status, "connected");
  assert.deepEqual(output, [["session-silent-connected", ""]]);
});

test("silent connection readiness delivery failure closes the opened provider session", async () => {
  const ipcMain = createIpcMain();
  const controls = [];
  const finished = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control(...args) { controls.push(args); return null; },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() { throw new Error("renderer unavailable"); },
      async finishExternalSession(sessionId, details) { finished.push([sessionId, details]); return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 80, once() {}, isDestroyed: () => false } };
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
      requestId: "connection-readiness-failure",
      sessionId: "session-readiness-failure",
      providerId: "com.example.transport.connection",
      configuration: {},
      columns: 80,
      rows: 24,
    }),
    /renderer unavailable/,
  );
  assert.deepEqual(controls.map(([sessionId, operation]) => [sessionId, operation]), [
    ["session-readiness-failure", "close"],
  ]);
  assert.deepEqual(finished, [[
    "session-readiness-failure",
    { reason: "error", error: "renderer unavailable" },
  ]]);
});

test("plugin connection status monitoring closes asynchronous provider errors", async () => {
  const ipcMain = createIpcMain();
  const closed = [];
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connecting", diagnostics: [] };
      },
      async control() { return { status: "error", message: "Handshake rejected" }; },
      closeSessionLocal(sessionId) { closed.push(sessionId); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() {},
      async finishExternalSession(sessionId, details) { resolveFinished([sessionId, details]); return true; },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 78, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-late-error",
    sessionId: "session-late-error",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.deepEqual(await finished, [
    "session-late-error",
    { reason: "error", error: "Handshake rejected" },
  ]);
  assert.deepEqual(closed, ["session-late-error"]);
});

test("closing the terminal while a plugin connection opens cancels the provider startup", async () => {
  const ipcMain = createIpcMain();
  let externalOptions;
  const closed = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      openConnection(_params, options) {
        return new Promise((_resolve, reject) => {
          const rejectCancelled = () => reject(options.signal.reason);
          if (options.signal.aborted) rejectCancelled();
          else options.signal.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
      closeSessionLocal(sessionId) { closed.push(sessionId); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        externalOptions = options;
        return { sessionId: options.sessionId };
      },
      async finishExternalSession() { return false; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 76, once() {}, isDestroyed: () => false } };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-close-during-start",
    sessionId: "session-close-during-start",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await externalOptions.onClose("renderer-close");
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(closed, ["session-close-during-start"]);
});
