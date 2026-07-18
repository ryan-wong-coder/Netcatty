"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { UtilityPluginRuntime, resolveUtilityEntrypoint } = require("./utilityPluginRuntime.cjs");

test("utility entrypoint is realpath-contained at the moment of launch", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-utility-entry-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist/index.js"), "export default {};\n");
  assert.equal(
    await resolveUtilityEntrypoint(packageRoot, "dist/index.js"),
    fs.realpathSync(path.join(packageRoot, "dist/index.js")),
  );
  if (process.platform !== "win32") {
    const outside = path.join(root, "outside.js");
    fs.writeFileSync(outside, "export default {};\n");
    fs.symlinkSync(outside, path.join(packageRoot, "dist/escape.js"));
    await assert.rejects(
      resolveUtilityEntrypoint(packageRoot, "dist/escape.js"),
      /escapes its package/,
    );
  }
});

test("utility runtime launches without a shell using a minimal environment", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-utility-launch-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist/index.js"), "export default {};\n");
  let forkOptions;
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
    postMessage(message) {
      if (message.type === "netcatty-plugin:bootstrap") {
        queueMicrotask(() => this.emit("message", { type: "netcatty-plugin:ready" }));
      } else if (message.method === "plugin.initialize") {
        queueMicrotask(() => this.emit("message", {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            pluginId: "com.example.utility",
            pluginVersion: "1.0.0",
            apiVersion: "0.1.0-internal",
            enabledFeatures: [],
          },
        }));
      } else if (message.method === "plugin.activate") {
        queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: message.id, result: null }));
      }
    }
    kill() { return true; }
  }
  const child = new FakeChild();
  const runtime = new UtilityPluginRuntime({
    utilityProcess: {
      fork(_bootstrap, _args, options) {
        forkOptions = options;
        return child;
      },
    },
    plugin: {
      id: "com.example.utility",
      manifest: { main: { node: "dist/index.js" } },
    },
    packageRoot,
    bootstrapPath: path.join(root, "utilityRuntime.mjs"),
    moduleMappings: {},
    handlers: {},
    logger: { write() {} },
  });
  await runtime.start({
    pluginId: "com.example.utility",
    pluginVersion: "1.0.0",
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
    enabledFeatures: [],
  });
  assert.equal(forkOptions.cwd, packageRoot);
  assert.deepEqual(forkOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(forkOptions.allowLoadingUnsignedLibraries, false);
  assert.equal(forkOptions.disclaim, process.platform === "darwin");
  assert.equal(Object.hasOwn(forkOptions, "shell"), false);
  assert.equal(Object.hasOwn(forkOptions.env, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(forkOptions.env, "HOME"), false);
});

test("utility runtime stop waits for the child exit before releasing the activation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-utility-stop-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist/index.js"), "export default {};\n");
  let kills = 0;
  let exitEvents = 0;
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 1234;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
    postMessage(message) {
      if (message.type === "netcatty-plugin:bootstrap") {
        queueMicrotask(() => this.emit("message", { type: "netcatty-plugin:ready" }));
      } else if (message.method === "plugin.initialize") {
        queueMicrotask(() => this.emit("message", {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            pluginId: "com.example.utility-stop",
            pluginVersion: "1.0.0",
            apiVersion: "0.1.0-internal",
            enabledFeatures: [],
          },
        }));
      } else if (message.method === "plugin.activate" || message.method === "plugin.deactivate") {
        queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: message.id, result: null }));
      }
    }
    kill() {
      kills += 1;
      return true;
    }
  }
  const child = new FakeChild();
  const runtime = new UtilityPluginRuntime({
    utilityProcess: { fork: () => child },
    plugin: {
      id: "com.example.utility-stop",
      manifest: { main: { node: "dist/index.js" } },
    },
    packageRoot,
    bootstrapPath: path.join(root, "utilityRuntime.mjs"),
    moduleMappings: {},
    handlers: {},
    logger: { write() {} },
    onExit: () => { exitEvents += 1; },
  });
  await runtime.start({
    pluginId: "com.example.utility-stop",
    pluginVersion: "1.0.0",
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
    enabledFeatures: [],
  });

  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
  assert.equal(exitEvents, 0);
  assert.equal(await Promise.race([stopping.then(() => "stopped"), Promise.resolve("pending")]), "pending");

  child.pid = undefined;
  child.emit("exit", 0);
  await stopping;
  assert.equal(exitEvents, 0);
});

test("utility fatal errors are reported only after the child is reaped", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-utility-error-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist/index.js"), "export default {};\n");
  const exits = [];
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 5678;
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
    postMessage(message) {
      if (message.type === "netcatty-plugin:bootstrap") {
        queueMicrotask(() => this.emit("message", { type: "netcatty-plugin:ready" }));
      } else if (message.method === "plugin.initialize") {
        queueMicrotask(() => this.emit("message", {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            pluginId: "com.example.utility-error",
            pluginVersion: "1.0.0",
            apiVersion: "0.1.0-internal",
            enabledFeatures: [],
          },
        }));
      } else if (message.method === "plugin.activate") {
        queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: message.id, result: null }));
      }
    }
    kill() { return true; }
  }
  const child = new FakeChild();
  const runtime = new UtilityPluginRuntime({
    utilityProcess: { fork: () => child },
    plugin: {
      id: "com.example.utility-error",
      manifest: { main: { node: "dist/index.js" } },
    },
    packageRoot,
    bootstrapPath: path.join(root, "utilityRuntime.mjs"),
    moduleMappings: {},
    handlers: {},
    logger: { write() {} },
    onExit: (details) => exits.push(details),
  });
  await runtime.start({
    pluginId: "com.example.utility-error",
    pluginVersion: "1.0.0",
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
    enabledFeatures: [],
  });

  child.emit("error", "FatalError", "fixture-location");
  assert.deepEqual(exits, []);
  child.pid = undefined;
  child.emit("exit", 1);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, false);
  assert.match(exits[0].error.message, /fixture-location/);
});

test("an already-aborted utility startup never forks a process", async () => {
  let forks = 0;
  const runtime = new UtilityPluginRuntime({
    utilityProcess: { fork() { forks += 1; } },
    plugin: {
      id: "com.example.cancelled-utility",
      manifest: { main: { node: "dist/index.js" } },
    },
    packageRoot: "/missing",
    bootstrapPath: "/runtime/utilityRuntime.mjs",
    moduleMappings: {},
    handlers: {},
    logger: { write() {} },
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runtime.start({}, { signal: controller.signal }), /cancelled/);
  assert.equal(forks, 0);
});
