"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { RuntimeSupervisor } = require("./runtimeSupervisor.cjs");

function pluginManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    id: "com.example.runtime-test",
    name: "runtime-test",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/browser.js", node: "dist/node.js" },
    ...overrides,
  };
}

function createFixture(context, runtimeFactory, supervisorOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-supervisor-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createPluginPaths(root);
  fs.mkdirSync(paths.logs, { recursive: true });
  const database = new PluginDatabase(paths.database);
  context.after(() => {
    try { database.close(); } catch {}
  });
  const manifest = pluginManifest();
  database.installVersion({
    pluginId: manifest.id,
    version: manifest.version,
    manifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${manifest.id}/${manifest.version}/package`,
  }, { enable: true });
  const packageRoot = path.join(paths.packages, manifest.id, manifest.version, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  const runtimeOptions = [];
  const factory = (options) => {
    runtimeOptions.push(options);
    return runtimeFactory(options);
  };
  const supervisor = new RuntimeSupervisor({
    electron: {},
    database,
    packageStore: { resolvePackageRoot: () => packageRoot },
    protocol: {},
    paths,
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    runtimeDirectory: path.join(root, "runtime"),
    appRoot: process.cwd(),
    runtimeFactories: { browser: factory, utility: factory },
    ...supervisorOptions,
  });
  return { database, manifest, runtimeOptions, supervisor };
}

test("supervisor prefers the ordinary browser runtime and enforces negotiated identity", async (context) => {
  const calls = [];
  const fixture = createFixture(context, () => ({
    async start(config) {
      calls.push(["start", config]);
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() { calls.push(["stop"]); },
  }));

  const started = await fixture.supervisor.start(fixture.manifest.id);
  assert.deepEqual(started, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id));
  assert.equal(Object.hasOwn(started, "request"), false);
  assert.equal(Object.hasOwn(started, "stop"), false);
  assert.equal(fixture.runtimeOptions[0].plugin.manifest.main.browser, "dist/browser.js");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.kind, "browser");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "running");
  await fixture.supervisor.stop(fixture.manifest.id);
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "stop"]);
});

test("repeated activation failures quarantine after the third crash window event", async (context) => {
  const fixture = createFixture(context, () => ({
    async start() { throw new Error("activation failed"); },
    async stop() {},
  }));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /activation failed/);
  }
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "quarantined");
  assert.ok(plugin.runtime.quarantinedAt != null);
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /quarantined/);
});

test("unexpected process exit is contained and recorded without touching other runtimes", async (context) => {
  let exit;
  const fixture = createFixture(context, (options) => {
    exit = options.onExit;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  exit({ expected: false, error: new Error("process crashed") });
  await new Promise((resolve) => setImmediate(resolve));
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "error");
  assert.match(plugin.runtime.lastError, /process crashed/);
});

test("a startup exit and its rejected start count as one crash", async (context) => {
  let attempts = 0;
  const fixture = createFixture(context, (options) => ({
    async start() {
      attempts += 1;
      options.onExit({ expected: false, error: new Error("startup process exit") });
      throw new Error("startup rejected");
    },
    async stop() {},
  }));

  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  assert.equal(attempts, 2);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "error");
  await assert.rejects(fixture.supervisor.start(fixture.manifest.id), /startup rejected/);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "quarantined");
});

test("deactivation failure still leaves the runtime stopped", async (context) => {
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() { throw new Error("deactivation timed out"); },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  await fixture.supervisor.stop(fixture.manifest.id);
  const plugin = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(plugin.runtime.status, "stopped");
  assert.match(plugin.runtime.lastError, /deactivation timed out/);
});

test("supervisor composes host routes with immutable activation identity for downstream capabilities", async (context) => {
  const registry = new PluginHostRpcRegistry();
  registry.registerRequest("settings.get", async (_params, identity) => ({
    manifestFrozen: Object.isFrozen(identity.manifest) && Object.isFrozen(identity.manifest.main),
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
  }));
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  }, { rpcRegistry: registry });
  await fixture.supervisor.start(fixture.manifest.id);
  const result = await runtimeOptions.requestHandlers["settings.get"]({}, {
    requestId: 1,
    signal: AbortSignal.timeout(100),
  });
  assert.equal(result.pluginId, fixture.manifest.id);
  assert.equal(result.manifestFrozen, true);
  assert.equal(result.pluginVersion, "1.0.0");
  assert.equal(typeof result.runtimeId, "string");
  assert.equal(result.runtimeId, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id).runtimeId);
});

test("supervisor exposes bounded host-to-plugin calls and rejects stale active versions", async (context) => {
  const calls = [];
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
      async request(method, params, requestOptions) {
        calls.push(["request", method, params, requestOptions]);
        return { status: "ok" };
      },
      notify(method, params) { calls.push(["notify", method, params]); },
      async openStream(streamId, windowBytes) {
        calls.push(["stream", streamId, windowBytes]);
        return { streamId };
      },
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  assert.deepEqual(
    await fixture.supervisor.request(fixture.manifest.id, "commands.execute", { command: "run" }),
    { status: "ok" },
  );
  await fixture.supervisor.notify(fixture.manifest.id, "settings.changed", { key: "theme" });
  assert.deepEqual(
    await fixture.supervisor.openStream(fixture.manifest.id, "provider-output", 1024),
    { streamId: "provider-output" },
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["request", "notify", "stream"]);
  await assert.rejects(
    fixture.supervisor.request(fixture.manifest.id, "plugin.activate", {}),
    /reserved/,
  );

  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  await assert.rejects(
    fixture.supervisor.request(fixture.manifest.id, "commands.execute", {}),
    /stale or inactive/,
  );
  await assert.rejects(
    runtimeOptions.requestHandlers["storage.keys"]({}, { signal: AbortSignal.timeout(100) }),
    (error) => error?.code === -32014,
  );
});

test("runtime placement and state events are injectable without changing lifecycle ownership", async (context) => {
  const events = [];
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
  }), {
    resolveRuntimeKind({ availableKinds, plugin }) {
      assert.deepEqual(availableKinds, ["browser", "utility"]);
      assert.equal(Object.isFrozen(plugin), true);
      assert.equal(Object.isFrozen(plugin.manifest), true);
      return "utility";
    },
  });
  const disposable = fixture.supervisor.onDidChangeRuntime((event) => events.push(event));
  await fixture.supervisor.start(fixture.manifest.id);
  await fixture.supervisor.stop(fixture.manifest.id);
  disposable.dispose();
  assert.deepEqual(events.map(({ status }) => status), ["starting", "running", "stopped"]);
  assert.equal(events[0].runtimeKind, "utility");
  assert.equal(events[0].runtimeId, events[2].runtimeId);
});

test("progress events carry immutable activation identity for downstream provider correlation", async (context) => {
  let runtimeOptions;
  const fixture = createFixture(context, (options) => {
    runtimeOptions = options;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  const events = [];
  const disposable = fixture.supervisor.onDidReportProgress((event) => events.push(event));
  await fixture.supervisor.start(fixture.manifest.id);
  const value = { kind: "report", message: "Parsing", percentage: 25 };
  runtimeOptions.onProgress({ token: "import-1", value });
  value.message = "spoofed";
  disposable.dispose();
  assert.equal(events.length, 1);
  assert.equal(events[0].runtimeId, fixture.supervisor.getRuntimeIdentity(fixture.manifest.id).runtimeId);
  assert.equal(events[0].token, "import-1");
  assert.deepEqual(events[0].value, { kind: "report", message: "Parsing", percentage: 25 });
  assert.equal(Object.isFrozen(events[0].value), true);
});

test("host-to-plugin results are discarded when the active runtime changes in flight", async (context) => {
  let resolveRequest;
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
    async request() {
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  const pending = fixture.supervisor.request(fixture.manifest.id, "provider.invoke", {});
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolveRequest({ status: "ok", stale: true });
  await assert.rejects(pending, (error) => error?.code === -32014);
});

test("a host stream is cancelled when the active runtime changes while it opens", async (context) => {
  let resolveOpen;
  let cancelled = 0;
  const fixture = createFixture(context, () => ({
    async start(config) {
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: config.enabledFeatures,
      };
    },
    async stop() {},
    async openStream() {
      return new Promise((resolve) => { resolveOpen = resolve; });
    },
  }));
  await fixture.supervisor.start(fixture.manifest.id);
  const pending = fixture.supervisor.openStream(fixture.manifest.id, "import-output", 1024);
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolveOpen({ cancel() { cancelled += 1; } });
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(cancelled, 1);
});

test("runtime placement cannot start a version replaced while policy is pending", async (context) => {
  let resolvePlacement;
  let factoryCalls = 0;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {};
  }, {
    resolveRuntimeKind: async () => {
      markPlacementEntered();
      return new Promise((resolve) => { resolvePlacement = resolve; });
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  resolvePlacement("browser");
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(factoryCalls, 0);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).activeVersion, "2.0.0");
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.lastError, null);
});

test("stop cancels a pending runtime placement decision before a process is created", async (context) => {
  let placementSignal;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  let factoryCalls = 0;
  const fixture = createFixture(context, () => {
    factoryCalls += 1;
    return {};
  }, {
    resolveRuntimeKind({ signal }) {
      placementSignal = signal;
      markPlacementEntered();
      return new Promise(() => {});
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  assert.equal(placementSignal.aborted, true);
  assert.equal(factoryCalls, 0);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "stopped");
});

test("stop cancels activation without recording a plugin crash", async (context) => {
  let rejectActivation;
  let markActivationEntered;
  const activationEntered = new Promise((resolve) => { markActivationEntered = resolve; });
  const fixture = createFixture(context, () => ({
    start() {
      markActivationEntered();
      return new Promise((_resolve, reject) => { rejectActivation = reject; });
    },
    async stop() {
      rejectActivation(new Error("activation stopped"));
    },
  }));
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await activationEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  const active = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(active.runtime.status, "stopped");
  assert.equal(active.runtime.lastError, null);
  assert.equal(Number(fixture.database.db.prepare(
    "SELECT COUNT(*) AS count FROM plugin_crashes WHERE plugin_id = ?",
  ).get(fixture.manifest.id).count), 0);
});

test("stop finishes even when plugin activation never settles", async (context) => {
  let markActivationEntered;
  const activationEntered = new Promise((resolve) => { markActivationEntered = resolve; });
  let stops = 0;
  const fixture = createFixture(context, () => ({
    start() {
      markActivationEntered();
      return new Promise(() => {});
    },
    async stop() { stops += 1; },
  }));
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await activationEntered;
  await fixture.supervisor.stop(fixture.manifest.id);
  await assert.rejects(pending, (error) => error?.code === -32001);
  assert.equal(stops, 1);
  assert.equal(fixture.supervisor.getRuntimeIdentity(fixture.manifest.id), null);
  assert.equal(fixture.database.getActivePlugin(fixture.manifest.id).runtime.status, "stopped");
});

test("lazy activation waits until the previous runtime has fully stopped", async (context) => {
  let factoryCalls = 0;
  let releaseFirstStop;
  let markFirstStopEntered;
  const firstStopEntered = new Promise((resolve) => { markFirstStopEntered = resolve; });
  const fixture = createFixture(context, () => {
    const instance = factoryCalls;
    factoryCalls += 1;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {
        if (instance !== 0) return;
        markFirstStopEntered();
        await new Promise((resolve) => { releaseFirstStop = resolve; });
      },
    };
  });
  const firstIdentity = await fixture.supervisor.start(fixture.manifest.id);
  const stopping = fixture.supervisor.stop(fixture.manifest.id);
  await firstStopEntered;
  const restarting = fixture.supervisor.start(fixture.manifest.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
  releaseFirstStop();
  await stopping;
  const secondIdentity = await restarting;
  assert.equal(factoryCalls, 2);
  assert.notEqual(secondIdentity.runtimeId, firstIdentity.runtimeId);
});

test("shutdown cancels unresolved placement and waits for startup cleanup", async (context) => {
  let signal;
  let markPlacementEntered;
  const placementEntered = new Promise((resolve) => { markPlacementEntered = resolve; });
  const fixture = createFixture(context, () => {
    throw new Error("runtime must not be created after shutdown");
  }, {
    resolveRuntimeKind(contextValue) {
      signal = contextValue.signal;
      markPlacementEntered();
      return new Promise(() => {});
    },
  });
  const pending = fixture.supervisor.start(fixture.manifest.id);
  await placementEntered;
  await fixture.supervisor.shutdown();
  await assert.rejects(pending, (error) => error?.code === -32014);
  assert.equal(signal.aborted, true);
  assert.equal(fixture.supervisor.getRuntimeIdentity(fixture.manifest.id), null);
});

test("a stale runtime crash cannot quarantine or overwrite a replacement version", async (context) => {
  let exit;
  const fixture = createFixture(context, (options) => {
    exit = options.onExit;
    return {
      async start(config) {
        return {
          pluginId: config.pluginId,
          pluginVersion: config.pluginVersion,
          apiVersion: config.apiVersion,
          enabledFeatures: config.enabledFeatures,
        };
      },
      async stop() {},
    };
  });
  await fixture.supervisor.start(fixture.manifest.id);
  const replacement = pluginManifest({ version: "2.0.0" });
  fixture.database.installVersion({
    pluginId: replacement.id,
    version: replacement.version,
    manifest: replacement,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${replacement.id}/${replacement.version}/package`,
  });
  await assert.rejects(
    fixture.supervisor.start(fixture.manifest.id),
    (error) => error?.code === -32014,
  );
  exit({ expected: false, error: new Error("stale process crashed") });
  await new Promise((resolve) => setImmediate(resolve));
  const active = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(active.activeVersion, "2.0.0");
  assert.equal(active.runtime.lastError, null);
  assert.equal(active.runtime.quarantinedAt, null);
  fixture.database.installVersion({
    pluginId: fixture.manifest.id,
    version: fixture.manifest.version,
    manifest: fixture.manifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${fixture.manifest.id}/${fixture.manifest.version}/package`,
  });
  const priorVersion = fixture.database.getActivePlugin(fixture.manifest.id);
  assert.equal(priorVersion.runtime.status, "error");
  assert.match(priorVersion.runtime.lastError, /stale process crashed/);
});
