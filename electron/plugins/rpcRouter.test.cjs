"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginRpcError, PluginRpcRouter, RPC_ERRORS } = require("./rpcRouter.cjs");

function createRouter(options = {}) {
  const sent = [];
  const protocolErrors = [];
  const router = new PluginRpcRouter({
    pluginId: "com.example.test",
    send(message) {
      options.send?.(message);
      sent.push(message);
    },
    handlers: options.handlers,
    maxPending: options.maxPending,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 100,
    onProtocolError(error) { protocolErrors.push(error); },
  });
  return { router, sent, protocolErrors };
}

test("RPC correlation validates initialize results against the reserved contract", async () => {
  const fixture = createRouter();
  const resultPromise = fixture.router.request("plugin.initialize", {
    netcattyVersion: "1.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
  });
  const request = fixture.sent[0];
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      pluginId: "com.example.test",
      pluginVersion: "1.0.0",
      apiVersion: "0.1.0-internal",
      enabledFeatures: [],
    },
  });
  assert.equal((await resultPromise).pluginId, "com.example.test");

  const invalidPromise = fixture.router.request("plugin.initialize", {
    netcattyVersion: "1.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
  });
  await fixture.router.accept({ jsonrpc: "2.0", id: fixture.sent.at(-1).id, result: {} });
  await assert.rejects(invalidPromise, /Initialize result violates/);
});

test("RPC deadline sends cancellation and rejects without leaking pending state", async () => {
  const fixture = createRouter({ defaultTimeoutMs: 10 });
  const request = fixture.router.request("plugin.activate", {});
  await assert.rejects(request, (error) => error instanceof PluginRpcError && error.code === RPC_ERRORS.deadlineExceeded);
  assert.equal(fixture.sent.at(-1).method, "$/cancelRequest");
  assert.equal(fixture.router.pending.size, 0);
});

test("incoming request deadlines do not block later requests", async () => {
  const fixture = createRouter({
    defaultTimeoutMs: 20,
    handlers: {
      "storage.get": async () => new Promise(() => {}),
      "storage.keys": async () => ({ keys: ["ready"] }),
    },
  });
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: "slow",
    method: "storage.get",
    params: { key: "blocked" },
    deadlineMs: 10,
  });
  assert.equal(fixture.sent[0].error.code, RPC_ERRORS.deadlineExceeded);
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: "next",
    method: "storage.keys",
    params: {},
  });
  assert.deepEqual(fixture.sent[1].result, { keys: ["ready"] });
});

test("incoming handlers can await a nested outgoing RPC response", async () => {
  let fixture;
  fixture = createRouter({
    handlers: {
      "storage.get": async () => fixture.router.request("plugin.nested", {}),
    },
  });
  const incoming = fixture.router.accept({
    jsonrpc: "2.0",
    id: "incoming",
    method: "storage.get",
    params: { key: "value" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const nested = fixture.sent[0];
  assert.equal(nested.method, "plugin.nested");
  await fixture.router.accept({ jsonrpc: "2.0", id: nested.id, result: { value: 42 } });
  await incoming;
  assert.deepEqual(fixture.sent[1], {
    jsonrpc: "2.0",
    id: "incoming",
    result: { value: 42 },
  });
});

test("an already-aborted outgoing request is never sent", async () => {
  const fixture = createRouter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fixture.router.request("plugin.activate", {}, { signal: controller.signal }),
    (error) => error?.code === RPC_ERRORS.cancelled,
  );
  assert.deepEqual(fixture.sent, []);
});

test("synchronous transport failure releases RPC correlation and cancellation ownership", async () => {
  const fixture = createRouter({ send() { throw new Error("port is closed"); } });
  await assert.rejects(fixture.router.request("plugin.activate", {}), /port is closed/);
  assert.equal(fixture.router.pending.size, 0);
  assert.equal(fixture.router.pendingCancellationIds.size, 0);
});

test("outgoing cancellation IDs cannot alias concurrent requests", async () => {
  const fixture = createRouter();
  const first = fixture.router.request("plugin.activate", {}, { cancellationId: "same" });
  await assert.rejects(
    fixture.router.request("plugin.deactivate", {}, { cancellationId: "same" }),
    (error) => error?.code === RPC_ERRORS.invalidParams,
  );
  fixture.router.close();
  await assert.rejects(first, (error) => error?.code === RPC_ERRORS.unavailable);
});

test("duplicate in-flight request and cancellation IDs fail without replacing ownership", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fixture = createRouter({
    handlers: { "storage.keys": async () => blocked },
  });
  const first = fixture.router.accept({
    jsonrpc: "2.0",
    id: "same-id",
    method: "storage.keys",
    params: {},
    cancellationId: "same-cancel",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: "same-id",
    method: "storage.keys",
    params: {},
    cancellationId: "different-cancel",
  });
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: "different-id",
    method: "storage.keys",
    params: {},
    cancellationId: "same-cancel",
  });
  assert.deepEqual(fixture.sent.map((message) => message.error?.code), [
    RPC_ERRORS.invalidParams,
    RPC_ERRORS.invalidParams,
  ]);
  release({ keys: [] });
  await first;
  assert.deepEqual(fixture.sent.at(-1), {
    jsonrpc: "2.0",
    id: "same-id",
    result: { keys: [] },
  });
  assert.equal(fixture.router.closed, false);
});

test("invalid host handler results become bounded internal errors", async () => {
  const fixture = createRouter({
    handlers: { "storage.keys": async () => ({ unsafe: 1n }) },
  });
  await fixture.router.accept({
    jsonrpc: "2.0",
    id: "invalid-result",
    method: "storage.keys",
    params: {},
  });
  assert.equal(fixture.sent[0].error.code, RPC_ERRORS.internal);
  assert.equal(fixture.router.closed, false);
});

test("incoming requests retain host-assigned plugin identity and unsupported methods fail immediately", async () => {
  const identities = [];
  const fixture = createRouter({
    handlers: {
      "storage.keys": async (_params, context) => {
        identities.push(context.pluginId);
        return { keys: [] };
      },
    },
  });
  await fixture.router.accept({ jsonrpc: "2.0", id: "one", method: "storage.keys", params: {} });
  assert.deepEqual(identities, ["com.example.test"]);
  assert.deepEqual(fixture.sent[0], { jsonrpc: "2.0", id: "one", result: { keys: [] } });

  await fixture.router.accept({ jsonrpc: "2.0", id: "two", method: "host.unsupported", params: {} });
  assert.equal(fixture.sent[1].error.code, RPC_ERRORS.methodNotFound);
});

test("malformed RPC closes the peer instead of accepting a near-match", async () => {
  const fixture = createRouter();
  await fixture.router.accept({ jsonrpc: "2.0", id: -1, method: "plugin.activate" });
  assert.equal(fixture.protocolErrors.length, 1);
  assert.equal(fixture.router.closed, true);
});
