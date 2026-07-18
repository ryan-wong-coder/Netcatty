"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPluginHostService } = require("./hostService.cjs");

function createOptions(root, configureRpcRegistry) {
  return {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => root,
      getVersion: () => "0.0.0",
    },
    electron: {},
    configureRpcRegistry,
  };
}

test("host RPC registry configuration is complete before runtime initialization", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root, (registry) => {
    registry.registerRequest("settings.get", () => null);
  }));
  context.after(() => service.database.close());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
  });
  assert.equal(typeof routes.requestHandlers["settings.get"], "function");
});

test("async host RPC registry configuration fails before a service can start", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createPluginHostService(createOptions(root, async () => {})),
    /must be synchronous/,
  );
});

test("host service forwards the transport quota guard to the runtime supervisor", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeMessageGuard = () => {};
  const service = createPluginHostService({
    ...createOptions(root),
    runtimeMessageGuard,
  });
  context.after(() => service.database.close());
  assert.equal(service.runtimeSupervisor.runtimeMessageGuard, runtimeMessageGuard);
});
