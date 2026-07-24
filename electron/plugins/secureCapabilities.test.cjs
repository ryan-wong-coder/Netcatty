"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerSecurePluginCapabilities } = require("./secureCapabilities.cjs");

function createRegistrations(secretStore) {
  const requests = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler) { requests.set(method, handler); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const broker = new Proxy({}, { get: () => () => ({}) });
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore,
    credentialBroker: broker,
    networkBroker: broker,
    filesystemBroker: broker,
    companionSupervisor: broker,
    assertLeaseParams: (params) => params,
  });
  return requests;
}

test("secret mutations recheck runtime activity immediately before commit", async () => {
  const events = [];
  const requests = createRegistrations({
    set(_pluginId, _key, _value) {
      events.push("set");
      return { kind: "secret", id: "secret-reference-0000000000000000", key: "api-key" };
    },
    delete() { events.push("delete"); },
    getReference() { return null; },
  });
  const activeContext = {
    pluginId: "com.example.secure",
    async assertActive() { events.push("active"); },
  };
  await requests.get("secrets.set")({ key: "api-key", value: "value" }, activeContext);
  await requests.get("secrets.delete")({ key: "api-key" }, activeContext);
  assert.deepEqual(events, ["active", "set", "active", "delete"]);

  const stoppedContext = {
    pluginId: "com.example.secure",
    async assertActive() { throw new Error("runtime stopped"); },
  };
  await assert.rejects(
    requests.get("secrets.set")({ key: "api-key", value: "value" }, stoppedContext),
    /runtime stopped/,
  );
  await assert.rejects(
    requests.get("secrets.delete")({ key: "api-key" }, stoppedContext),
    /runtime stopped/,
  );
  assert.deepEqual(events, ["active", "set", "active", "delete"]);
});

test("filesystem RPC authorization fixes resource kind by operation without host I/O", () => {
  const registrations = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler, options) { registrations.set(method, { handler, options }); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const filesystemCalls = [];
  const filesystemBroker = {
    validateRead: (params) => params,
    validateWrite: (params) => params,
    validatePath: (params) => params,
    describeReadAuthorization(params, resourceKind) {
      filesystemCalls.push([params.path, resourceKind]);
      return { permission: "filesystem.read", resources: [params.path], resourceKinds: [resourceKind] };
    },
    describeWriteAuthorization(params) {
      filesystemCalls.push([params.path, "exact"]);
      return { permission: "filesystem.write", resources: [params.path], resourceKinds: ["exact"] };
    },
    readFile: async () => null,
    stat: async () => null,
    readDirectory: async () => null,
    writeFile: async () => null,
  };
  const broker = new Proxy({}, { get: () => () => ({}) });
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore: {},
    credentialBroker: broker,
    networkBroker: broker,
    filesystemBroker,
    companionSupervisor: broker,
    assertLeaseParams: (params) => params,
  });

  const target = "/canonical/target";
  for (const method of ["filesystem.readFile", "filesystem.stat", "filesystem.readDirectory"]) {
    registrations.get(method).options.authorization({ path: target });
  }
  registrations.get("filesystem.writeFile").options.authorization({
    path: target,
    data: "value",
    overwrite: true,
  });
  assert.deepEqual(filesystemCalls, [
    [target, "exact"],
    [target, "exact"],
    [target, "directory"],
    [target, "exact"],
  ]);
});

test("companion start authorization receives host-owned runtime placement", () => {
  const registrations = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler, options) { registrations.set(method, { handler, options }); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const broker = new Proxy({}, { get: () => () => ({}) });
  let observedContext;
  const companionSupervisor = {
    validateStart: (params) => params,
    describeStartAuthorization(params, context) {
      observedContext = context;
      return {
        permission: "companion.execute",
        resources: [params.companionId],
      };
    },
    validateRequest: (params) => params,
    validateStop: (params) => params,
    describeHandleAuthorization: () => ({
      permission: "companion.execute",
      resources: ["com.example.secure.helper"],
    }),
    start: async () => null,
    request: async () => null,
    stop: async () => null,
  };
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore: {},
    credentialBroker: broker,
    networkBroker: broker,
    filesystemBroker: broker,
    companionSupervisor,
    assertLeaseParams: (params) => params,
  });
  const runtimeContext = { runtimeKind: "utility", runtimeId: "runtime-advanced" };
  registrations.get("companion.start").options.authorization({
    companionId: "com.example.secure.helper",
  }, runtimeContext);
  assert.equal(observedContext, runtimeContext);
});

test("companion requests consume operation-bound credential leases exactly once", async () => {
  const registrations = new Map();
  const registry = {
    use() {},
    registerRequest(method, handler, options) { registrations.set(method, { handler, options }); },
  };
  const middlewareOwner = { createMiddleware: () => async (_context, next) => next() };
  const consumed = [];
  const forwarded = [];
  const credentialBroker = {
    async consumeLease(context, lease, operationId) {
      consumed.push({ context, lease, operationId });
      return lease.id.endsWith("user") ? "alice" : "correct horse battery staple";
    },
  };
  const companionSupervisor = {
    validateRequest(params) { return params; },
    describeHandleAuthorization: () => ({
      permission: "companion.execute",
      resources: ["com.example.secure.helper"],
    }),
    async request(params, context) {
      forwarded.push({ params, context });
      return { accepted: true };
    },
    validateStart: (params) => params,
    validateStop: (params) => params,
    describeStartAuthorization: () => ({
      permission: "companion.execute",
      resources: ["com.example.secure.helper"],
    }),
    start: async () => null,
    stop: async () => null,
  };
  const broker = new Proxy({}, { get: () => () => ({}) });
  registerSecurePluginCapabilities(registry, {
    quotaManager: middlewareOwner,
    permissionEngine: middlewareOwner,
    secretStore: {},
    credentialBroker,
    networkBroker: broker,
    filesystemBroker: broker,
    companionSupervisor,
    assertLeaseParams: (params) => params,
  });

  const context = {
    pluginId: "com.example.secure",
    async assertActive() {},
  };
  const result = await registrations.get("companion.request").handler({
    handleId: "companion-handle-0001",
    method: "authenticate",
    params: { host: "example.test" },
    credentialLeases: {
      username: { kind: "secret-lease", id: "credential-lease-user" },
      password: { kind: "secret-lease", id: "credential-lease-password" },
    },
    operationId: "login",
    timeoutMs: 5_000,
  }, context);

  assert.deepEqual(result, { accepted: true });
  assert.equal(consumed.length, 2);
  assert.deepEqual(consumed.map(({ lease, operationId }) => [lease.id, operationId]), [
    ["credential-lease-user", "login"],
    ["credential-lease-password", "login"],
  ]);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].params, {
    handleId: "companion-handle-0001",
    method: "authenticate",
    params: {
      payload: { host: "example.test" },
      credentials: {
        username: "alice",
        password: "correct horse battery staple",
      },
    },
    timeoutMs: 5_000,
  });
  assert.equal(forwarded[0].context, context);
});
