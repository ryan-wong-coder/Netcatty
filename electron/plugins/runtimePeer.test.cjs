"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MessageChannel } = require("node:worker_threads");

const { PluginRpcRouter } = require("./rpcRouter.cjs");

test("runtime peer performs initialize, activation, storage RPC, and disposal over one port", async () => {
  const { startPluginRuntime } = await import("./runtime/runtimePeer.mjs");
  const { port1, port2 } = new MessageChannel();
  const values = new Map();
  const host = new PluginRpcRouter({
    pluginId: "com.example.peer",
    send(message) { port1.postMessage(message); },
    handlers: {
      "storage.set": async ({ key, value }) => { values.set(key, value); return null; },
      "log.write": async () => null,
    },
  });
  port1.on("message", (message) => host.accept(message));
  const lifecycle = [];
  const peer = await startPluginRuntime({
    port: port2,
    config: {
      pluginId: "com.example.peer",
      pluginVersion: "1.0.0",
      netcattyVersion: "1.0.0",
      apiVersion: "0.1.0-internal",
      enabledFeatures: [],
    },
    async loadPlugin() {
      return {
        default: {
          async activate(context) {
            lifecycle.push("activate");
            await context.storage.set("answer", 42);
          },
          async deactivate() { lifecycle.push("deactivate"); },
        },
      };
    },
  });
  const initialized = await host.request("plugin.initialize", {
    netcattyVersion: "1.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
  });
  assert.equal(initialized.pluginId, "com.example.peer");
  const unhandledStream = await host.streams.openOutgoing("unhandled", 1024);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(unhandledStream.write(new Uint8Array([1])), /closed/);
  await assert.rejects(
    host.request("plugin.unknown", {}),
    (error) => error?.code === -32012 && error?.data?.pluginCode === "unsupported",
  );
  await host.request("plugin.activate", {});
  assert.equal(values.get("answer"), 42);
  await host.request("plugin.deactivate", {});
  await peer.dispose();
  host.close();
  assert.deepEqual(lifecycle, ["activate", "deactivate"]);
});
