"use strict";

const assert = require("node:assert/strict");
const { MessageChannel } = require("node:worker_threads");
const test = require("node:test");

const { PluginTerminalDataPipelineService } = require("./terminalDataPipelineService.cjs");

function provider(pluginId, id, direction) {
  return Object.freeze({
    pluginId,
    pluginVersion: "1.0.0",
    pluginDisplayName: pluginId,
    provider: Object.freeze({ id, kind: `terminal.interceptor.${direction}`, label: id }),
  });
}

function harness(options = {}) {
  const providers = options.providers ?? [provider("com.example", "com.example.input", "input")];
  const identity = Object.freeze({
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: options.runtimeKind ?? "utility",
    securityPrincipal: "principal-1",
  });
  const attached = [];
  const detached = [];
  const authorized = [];
  const contributionListeners = [];
  const runtimeListeners = [];
  const contributionService = {
    listProviders({ kind }) { return providers.filter((entry) => entry.provider.kind === kind); },
    async activateProvider(providerId) {
      const entry = providers.find((candidate) => candidate.provider.id === providerId);
      if (!entry) throw new Error("missing provider");
      return {
        plugin: {
          id: entry.pluginId,
          activeVersion: entry.pluginVersion,
          manifest: { main: { node: "dist/index.js" }, permissions: { required: ["runtime.advanced"] } },
        },
        provider: entry.provider,
        identity: options.activationIdentity ?? identity,
      };
    },
    onDidChange(listener) { contributionListeners.push(listener); },
  };
  const runtimeSupervisor = {
    getRuntimeIdentity() { return options.getRuntimeIdentity?.() ?? identity; },
    onDidChangeRuntime(listener) { runtimeListeners.push(listener); },
    async attachTerminalInterceptor(pluginId, descriptor, port, attachOptions) {
      port.unref?.();
      attached.push({ side: "plugin", pluginId, descriptor, port, attachOptions });
      await options.onAttachTerminalInterceptor?.();
    },
  };
  const permissionEngine = {
    async authorize(context, request) {
      authorized.push({ context, request });
      await options.onAuthorize?.({ context, request, providers });
      const scope = typeof options.permissionScope === "function"
        ? options.permissionScope({ context, request, call: authorized.length })
        : options.permissionScope ?? "session";
      return { scope };
    },
  };
  const worker = {
    warningListener: null,
    ownedListener: null,
    ownsSession() { return true; },
    attachTerminalInterceptor(descriptor, port) {
      port.unref?.();
      attached.push({ side: "worker", descriptor, port });
    },
    detachTerminalInterceptor(sessionId, direction) { detached.push({ sessionId, direction }); },
    onTerminalInterceptorWarning(listener) {
      this.warningListener = listener;
      return { dispose: () => { this.warningListener = null; } };
    },
    onSessionOwned(listener) {
      this.ownedListener = listener;
      return { dispose: () => { this.ownedListener = null; } };
    },
  };
  const selections = [];
  const warnings = [];
  const service = new PluginTerminalDataPipelineService({
    contributionService,
    permissionEngine,
    runtimeSupervisor,
    MessageChannelMain: MessageChannel,
    requestSelection: async (request) => {
      selections.push(request);
      return Object.hasOwn(options, "selectedProviderId")
        ? options.selectedProviderId
        : request.providers[0].provider.id;
    },
    showWarning: (warning) => warnings.push(warning),
  });
  service.bindTerminalWorkerManager(worker);
  return {
    service,
    worker,
    identity,
    attached,
    detached,
    authorized,
    selections,
    warnings,
    runtimeListeners,
    contributionService,
  };
}

const session = Object.freeze({
  sessionId: "session-1",
  protocol: "ssh",
  status: "connected",
});

test("pipeline activation requires exact session permissions and transfers one port to each process", async () => {
  const h = harness();
  const result = await h.service.configureDirection(session, "input");
  assert.deepEqual(result, {
    status: "active",
    direction: "input",
    providerId: "com.example.input",
    pluginId: "com.example",
  });
  assert.deepEqual(h.authorized.map((entry) => entry.request.permission), [
    "provider.terminal",
    "terminal.intercept.input",
  ]);
  assert.ok(h.authorized.every((entry) => entry.request.sessionId === "session-1"));
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
  assert.deepEqual(h.attached[0].attachOptions.expectedIdentity, h.identity);
});

test("pipeline rejects one-use permission grants before opening a streaming port", async () => {
  const h = harness({ permissionScope: "once" });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /require a session, application, or persistent permission grant/,
  );
  assert.equal(h.authorized.length, 1);
  assert.equal(h.attached.length, 0);

  const laterOnce = harness({
    permissionScope: ({ call }) => (call === 2 ? "once" : "session"),
  });
  await assert.rejects(
    () => laterOnce.service.configureDirection(session, "input"),
    /require a session, application, or persistent permission grant/,
  );
  assert.equal(laterOnce.authorized.length, 2);
  assert.equal(laterOnce.attached.length, 0);
});

test("pipeline accepts an existing long-lived permission grant", async () => {
  const h = harness({ permissionScope: "existing" });
  const result = await h.service.configureDirection(session, "input");
  assert.equal(result.status, "active");
  assert.equal(h.authorized.length, 2);
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
});

test("multiple interceptors require an explicit per-session selection", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: "com.example.input",
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].providers.length, 2);
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1, "an active session binding must not prompt again");
});

test("declining competing interceptors is remembered for the session and reset on disposal", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: null,
  });
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal(h.selections.length, 1);

  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 2);
});

test("concurrent snapshots serialize to one authorization and one port pair", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.service.configureDirection(session, "input"),
    h.service.configureDirection(session, "input"),
  ]);
  assert.equal(first.status, "active");
  assert.equal(second.status, "active");
  assert.equal(h.authorized.length, 2);
  assert.equal(h.attached.length, 2);
});

test("browser runtimes cannot receive privileged terminal ports", async () => {
  const h = harness({ runtimeKind: "browser" });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /advanced utility runtime/,
  );
  assert.equal(h.attached.length, 0);
});

test("stale activation identity fails before permissions or port transfer", async () => {
  const h = harness({
    activationIdentity: {
      pluginId: "com.example",
      pluginVersion: "0.9.0",
      runtimeId: "stale-runtime",
      runtimeKind: "utility",
      securityPrincipal: "principal-1",
    },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /identity is unavailable, stale/,
  );
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);
});

test("worker transfer starts only after the plugin port is ready", async () => {
  const h = harness();
  h.worker.attachTerminalInterceptor = () => { throw new Error("worker unavailable"); };
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /worker unavailable/,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
});

test("contribution withdrawal during authorization prevents stale port publication", async () => {
  let withdrawn = false;
  const h = harness({
    onAuthorize({ providers }) {
      if (withdrawn) return;
      withdrawn = true;
      providers.splice(0, providers.length);
    },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /contribution changed/,
  );
  assert.equal(h.attached.length, 0);
});

test("runtime replacement during port attachment cannot publish a stale active binding", async () => {
  let runtimeId = "runtime-1";
  const h = harness({
    getRuntimeIdentity: () => ({
      pluginId: "com.example",
      pluginVersion: "1.0.0",
      runtimeId,
      runtimeKind: "utility",
      securityPrincipal: "principal-1",
    }),
    onAttachTerminalInterceptor() { runtimeId = "runtime-2"; },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /runtime changed during port attachment/,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
  assert.deepEqual(h.detached, []);
  assert.equal(h.service.active.size, 0);
});

test("disconnect detaches and reconnect restores the remembered session interceptor", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: "com.example.input",
  });
  await h.service.handleSessionEvent({ type: "connected", session });
  assert.equal(h.selections.length, 1);
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);

  await h.service.handleSessionEvent({
    type: "disconnected",
    session: { ...session, status: "disconnected" },
  });
  assert.deepEqual(h.detached, [{ sessionId: "session-1", direction: "input" }]);

  await h.service.handleSessionEvent({ type: "reconnected", session });
  assert.equal(h.selections.length, 1, "reconnect must reuse the session-local choice");
  assert.deepEqual(h.attached.map((entry) => entry.side), [
    "plugin", "worker", "plugin", "worker",
  ]);
});

test("a renderer cannot attach an interceptor to another window's terminal session", async () => {
  const h = harness();
  h.worker.ownsSession = () => false;
  await assert.rejects(
    () => h.service.configureDirection(session, "input", { webContentsId: 99 }),
    /not owned by the requesting window/,
  );
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);
});

test("created events defer silently until the worker has recorded session ownership", async () => {
  const h = harness();
  let owned = false;
  h.worker.ownsSession = () => owned;
  const results = await h.service.handleSessionEvent({ type: "created", session }, {
    webContentsId: 99,
  });
  assert.deepEqual(results, [
    { status: "pending-session", direction: "input" },
    { status: "pending-session", direction: "output" },
  ]);
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);

  owned = true;
  await h.worker.ownedListener({ sessionId: session.sessionId, webContentsId: 99 });
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
  assert.equal(h.authorized.length, 2);
});

test("session disposal invalidates an in-flight lazy activation before port transfer", async () => {
  const h = harness();
  const originalActivate = h.contributionService.activateProvider;
  let releaseActivation;
  h.contributionService.activateProvider = async (...args) => {
    await new Promise((resolve) => { releaseActivation = resolve; });
    return originalActivate(...args);
  };
  const pending = h.service.configureDirection(session, "input");
  await new Promise((resolve) => setImmediate(resolve));
  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  });
  releaseActivation();
  await assert.rejects(pending, /session changed/);
  assert.equal(h.attached.length, 0);
});

test("runtime exit and session disposal detach both directions", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.example", "com.example.output", "output"),
    ],
  });
  await h.service.handleSessionEvent({ type: "connected", session });
  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: "runtime-1",
  });
  assert.deepEqual(h.detached.map((entry) => entry.direction).sort(), ["input", "output"]);
  await h.service.handleSessionEvent({ type: "disposed", session: { ...session, status: "disconnected" } });
});

test("runtime exit clears the cached provider choice but ordinary reconnect preserves it", async () => {
  const providers = [
    provider("com.example", "com.example.input", "input"),
    provider("com.other", "com.other.input", "input"),
  ];
  const h = harness({
    providers,
    selectedProviderId: "com.example.input",
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1);

  const withdrawn = providers.splice(0);
  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: "runtime-1",
  });
  providers.push(...withdrawn);
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 2, "a stopped runtime must discard its session-local choice");
});

test("terminal worker exit invalidates active bindings before worker restart", async () => {
  const h = harness();
  await h.service.configureDirection(session, "input");
  h.worker.warningListener({ code: "worker-exit", message: "Terminal worker exited" });
  await h.service.configureDirection(session, "input");
  assert.equal(h.authorized.length, 4);
  assert.equal(h.attached.length, 4);
});

test("a failed interceptor stays quarantined for the rest of the session", async () => {
  const h = harness();
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "timeout",
    message: "Interceptor timed out",
  });

  const [result] = await h.service.handleSessionEvent({ type: "connected", session });
  assert.equal(result.status, "declined");
  assert.equal(h.authorized.length, 2, "the quarantined provider must not be authorized again");
  assert.equal(h.attached.length, 2, "the quarantined provider must not be reattached");
  assert.equal(h.warnings.length, 1);
});
