"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RPC_ERRORS, PluginRpcError } = require("./rpcRouter.cjs");
const {
  MAX_TERMINAL_PROVIDERS_PER_REQUEST,
  PluginTerminalProviderService,
  normalizeTerminalSessionEvent,
} = require("./terminalProviderService.cjs");

function provider(pluginId, id, kind) {
  return {
    pluginId,
    pluginVersion: "1.0.0",
    pluginDisplayName: pluginId,
    provider: { id, kind, label: id },
  };
}

function setup(options = {}) {
  const providers = options.providers ?? [
    provider("com.example.beta", "com.example.beta.completion", "terminal.completion"),
    provider("com.example.alpha", "com.example.alpha.completion", "terminal.completion"),
    provider("com.example.alpha", "com.example.alpha.decoration", "terminal.decoration"),
    provider("com.example.alpha", "com.example.alpha.interceptor", "terminal.interceptor.input"),
  ];
  const calls = [];
  const notifications = [];
  const permissionCalls = [];
  const active = new Set(options.activePluginIds ?? []);
  const contributionService = {
    listProviders({ kind } = {}) {
      return kind == null ? providers : providers.filter((entry) => entry.provider.kind === kind);
    },
    async activateProvider(providerId) {
      calls.push(["activate", providerId]);
      const entry = providers.find((candidate) => candidate.provider.id === providerId);
      if (!entry) throw new PluginRpcError(RPC_ERRORS.notFound, "missing provider");
      active.add(entry.pluginId);
      return {
        plugin: {
          id: entry.pluginId,
          activeVersion: entry.pluginVersion,
          manifest: {
            id: entry.pluginId,
            permissions: {
              required: ["provider.terminal", "terminal.complete", "terminal.output", "terminal.decorate"],
            },
          },
        },
        provider: entry.provider,
        identity: {
          pluginId: entry.pluginId,
          pluginVersion: entry.pluginVersion,
          runtimeId: `runtime:${entry.pluginId}`,
          runtimeKind: "browser",
          securityPrincipal: `principal:${entry.pluginId}`,
        },
      };
    },
  };
  const runtimeSupervisor = {
    async request(pluginId, method, params, requestOptions) {
      calls.push(["request", pluginId, method, params, requestOptions]);
      if (options.request) return options.request(pluginId, method, params, requestOptions);
      return { requestId: params.requestId, status: "ok", result: { items: [{ label: params.providerId }] } };
    },
    getRuntimeIdentity(pluginId) {
      if (options.getRuntimeIdentity) return options.getRuntimeIdentity(pluginId, active);
      return active.has(pluginId) ? {
        pluginId,
        pluginVersion: "1.0.0",
        runtimeId: `runtime:${pluginId}`,
        runtimeKind: "browser",
        securityPrincipal: `principal:${pluginId}`,
      } : null;
    },
    async notify(pluginId, method, params, notifyOptions) {
      notifications.push([pluginId, method, params, notifyOptions]);
    },
  };
  const permissionEngine = {
    async authorize(context, descriptor) {
      permissionCalls.push([context, descriptor]);
      if (options.authorize) return options.authorize(context, descriptor);
      return { scope: "existing" };
    },
  };
  return {
    calls,
    notifications,
    permissionCalls,
    service: new PluginTerminalProviderService({ contributionService, permissionEngine, runtimeSupervisor }),
  };
}

const session = {
  sessionId: "session-1",
  hostId: "host-1",
  workspaceId: "workspace-1",
  protocol: "ssh",
  status: "connected",
  cwd: "/srv/app",
  title: "app",
  shellType: "posix",
  cols: 120,
  rows: 40,
  alternateScreen: false,
};

test("terminal Provider registry ranks declared providers deterministically and excludes raw interceptors", () => {
  const { service } = setup();
  assert.deepEqual(
    service.listProviders({
      kind: "terminal.completion",
      preferredProviderIds: ["com.example.beta.completion"],
    }).map((entry) => entry.provider.id),
    ["com.example.beta.completion", "com.example.alpha.completion"],
  );
  assert.throws(
    () => service.listProviders({ kind: "terminal.interceptor.input" }),
    (error) => error?.code === RPC_ERRORS.unsupported,
  );
});

test("terminal Provider invocation lazily activates, forwards deadlines, and freezes bounded results", async () => {
  const { calls, notifications, permissionCalls, service } = setup();
  const result = await service.invokeProvider({
    providerId: "com.example.alpha.completion",
    kind: "terminal.completion",
    operation: "provideCompletions",
    requestId: "request-1",
    payload: { session, value: { input: "git st" } },
    deadlineMs: 250,
  });
  assert.deepEqual(result, {
    pluginId: "com.example.alpha",
    pluginVersion: "1.0.0",
    runtimeId: "runtime:com.example.alpha",
    providerId: "com.example.alpha.completion",
    kind: "terminal.completion",
    requestId: "request-1",
    status: "ok",
    result: { items: [{ label: "com.example.alpha.completion" }] },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.result.items), true);
  assert.deepEqual(calls[0], ["activate", "com.example.alpha.completion"]);
  assert.equal(calls[1][1], "com.example.alpha");
  assert.equal(calls[1][2], "provider.invoke");
  assert.equal(calls[1][3].kind, "terminal.completion");
  assert.equal(calls[1][3].deadlineMs, 250);
  assert.equal(calls[1][4].timeoutMs, 250);
  assert.equal(calls[1][4].expectedIdentity.runtimeId, "runtime:com.example.alpha");
  assert.deepEqual(permissionCalls.map((call) => call[1].permission), [
    "provider.terminal",
    "terminal.complete",
  ]);
  assert.equal(permissionCalls[0][0].runtimeId, "runtime:com.example.alpha");
  assert.equal(permissionCalls[0][1].sessionId, session.sessionId);
  assert.deepEqual(notifications, [[
    "com.example.alpha",
    "plugin.terminal.event",
    { type: "snapshot", session },
    { expectedIdentity: {
      pluginId: "com.example.alpha",
      pluginVersion: "1.0.0",
      runtimeId: "runtime:com.example.alpha",
      runtimeKind: "browser",
      securityPrincipal: "principal:com.example.alpha",
    } },
  ]]);
});

test("terminal Provider invocation rejects kind drift and malformed or oversized results", async () => {
  const mismatch = setup();
  await assert.rejects(
    mismatch.service.invokeProvider({
      providerId: "com.example.alpha.completion",
      kind: "terminal.decoration",
      operation: "provide",
      requestId: "request-kind",
    }),
    (error) => error?.code === RPC_ERRORS.failedPrecondition,
  );

  const malformed = setup({
    request: async (_pluginId, _method, params) => ({
      requestId: `${params.requestId}-wrong`,
      status: "ok",
      result: null,
    }),
  });
  await assert.rejects(
    malformed.service.invokeProvider({
      providerId: "com.example.alpha.completion",
      kind: "terminal.completion",
      operation: "provide",
      requestId: "request-mismatch",
    }),
    (error) => error?.code === RPC_ERRORS.dataLoss,
  );

  const oversized = setup({
    request: async (_pluginId, _method, params) => ({
      requestId: params.requestId,
      status: "ok",
      result: "x".repeat(128 * 1024),
    }),
  });
  await assert.rejects(
    oversized.service.invokeProvider({
      providerId: "com.example.alpha.completion",
      kind: "terminal.completion",
      operation: "provide",
      requestId: "request-oversized",
    }),
    (error) => error?.code === RPC_ERRORS.dataLoss,
  );
});

test("terminal Provider invocation authorizes optional permissions before sending session data", async () => {
  const fixture = setup({
    authorize: async (_context, descriptor) => {
      if (descriptor.permission === "terminal.complete") {
        throw new PluginRpcError(RPC_ERRORS.permissionDenied, "permission denied");
      }
      return { scope: "existing" };
    },
  });
  await assert.rejects(
    fixture.service.invokeProvider({
      providerId: "com.example.alpha.completion",
      kind: "terminal.completion",
      operation: "provide",
      requestId: "request-denied",
      payload: { session },
    }),
    (error) => error?.code === RPC_ERRORS.permissionDenied,
  );
  assert.deepEqual(fixture.permissionCalls.map((call) => call[1].permission), [
    "provider.terminal",
    "terminal.complete",
  ]);
  assert.deepEqual(fixture.notifications, []);
  assert.equal(fixture.calls.some((call) => call[0] === "request"), false);
});

test("terminal Provider fan-out contains failures and preserves deterministic registry order", async () => {
  const { calls, service } = setup({
    request: async (pluginId, _method, params) => {
      if (pluginId === "com.example.alpha") {
        throw new PluginRpcError(RPC_ERRORS.unavailable, "alpha unavailable");
      }
      return { requestId: params.requestId, status: "ok", result: { items: [{ label: "beta" }] } };
    },
  });
  const results = await service.provide({
    kind: "terminal.completion",
    operation: "provideCompletions",
    session,
    payload: { input: "be", session: { sessionId: "spoofed" } },
    preferredProviderIds: ["com.example.beta.completion"],
    deadlineMs: 300,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].providerId, "com.example.beta.completion");
  assert.equal(results[0].status, "ok");
  assert.equal(results[1].providerId, "com.example.alpha.completion");
  assert.equal(results[1].status, "failed");
  assert.equal(results[1].error.code, RPC_ERRORS.unavailable);
  const forwarded = calls.find((call) => call[0] === "request");
  assert.equal(forwarded[3].payload.input, "be");
  assert.equal(forwarded[3].payload.session.sessionId, session.sessionId);
});

test("terminal lifecycle delivery targets only active Provider runtimes and strips sensitive command text", async () => {
  const { notifications, service } = setup({ activePluginIds: ["com.example.alpha"] });
  const beforeAuthorization = await service.publishSessionEvent({
    type: "connected",
    session,
  });
  assert.deepEqual(beforeAuthorization, [
    { pluginId: "com.example.alpha", delivered: false },
    { pluginId: "com.example.beta", delivered: false },
  ]);
  assert.deepEqual(notifications, []);
  await service.invokeProvider({
    providerId: "com.example.alpha.completion",
    kind: "terminal.completion",
    operation: "provide",
    requestId: "authorize-lifecycle",
    payload: { session },
  });
  notifications.length = 0;
  const deliveries = await service.publishSessionEvent({
    type: "commandSubmitted",
    session,
    command: "export TOKEN=secret",
  });
  assert.deepEqual(deliveries, [
    { pluginId: "com.example.alpha", delivered: true },
    { pluginId: "com.example.beta", delivered: false },
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], "com.example.alpha");
  assert.equal(notifications[0][1], "plugin.terminal.event");
  assert.equal(Object.hasOwn(notifications[0][2], "command"), false);
  assert.equal(Object.isFrozen(notifications[0][2].session), true);
  assert.deepEqual(normalizeTerminalSessionEvent({ type: "disposed", session }), {
    type: "disposed",
    session,
  });
});

test("one-use Provider grants never authorize later lifecycle delivery", async () => {
  const { notifications, service } = setup({
    authorize: async () => ({ scope: "once" }),
  });
  await service.invokeProvider({
    providerId: "com.example.alpha.completion",
    kind: "terminal.completion",
    operation: "provide",
    requestId: "one-use-lifecycle",
    payload: { session },
  });
  notifications.length = 0;
  const deliveries = await service.publishSessionEvent({ type: "cwdChanged", session });
  assert.deepEqual(deliveries, [
    { pluginId: "com.example.alpha", delivered: false },
    { pluginId: "com.example.beta", delivered: false },
  ]);
  assert.deepEqual(notifications, []);
});

test("failed and cancelled Provider results never authorize later lifecycle delivery", async () => {
  for (const status of ["failed", "cancelled"]) {
    const { notifications, service } = setup({
      request: async (_pluginId, _method, params) => status === "failed"
        ? {
            requestId: params.requestId,
            status,
            error: { code: RPC_ERRORS.internal, message: "provider failed" },
          }
        : { requestId: params.requestId, status },
    });
    const result = await service.invokeProvider({
      providerId: "com.example.alpha.completion",
      kind: "terminal.completion",
      operation: "provide",
      requestId: `unsuccessful-${status}`,
      payload: { session },
    });
    assert.equal(result.status, status);
    notifications.length = 0;
    const deliveries = await service.publishSessionEvent({ type: "resized", session });
    assert.deepEqual(deliveries, [
      { pluginId: "com.example.alpha", delivered: false },
      { pluginId: "com.example.beta", delivered: false },
    ]);
    assert.deepEqual(notifications, []);
  }
});

test("terminal Provider fan-out enforces the per-request Provider quota", async () => {
  const providers = Array.from({ length: MAX_TERMINAL_PROVIDERS_PER_REQUEST + 5 }, (_, index) => provider(
    `com.example.provider${String(index).padStart(2, "0")}`,
    `com.example.provider${String(index).padStart(2, "0")}.completion`,
    "terminal.completion",
  ));
  const { calls, service } = setup({ providers });
  const results = await service.provide({
    kind: "terminal.completion",
    operation: "provideCompletions",
    session,
  });
  assert.equal(results.length, MAX_TERMINAL_PROVIDERS_PER_REQUEST);
  assert.equal(calls.filter((call) => call[0] === "request").length, MAX_TERMINAL_PROVIDERS_PER_REQUEST);
});
