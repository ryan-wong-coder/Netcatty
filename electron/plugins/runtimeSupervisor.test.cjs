"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
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

function createFixture(context, runtimeFactory) {
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

  await fixture.supervisor.start(fixture.manifest.id);
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
