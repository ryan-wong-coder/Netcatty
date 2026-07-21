"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

class FakePort {
  constructor() {
    this.listeners = new Set();
    this.messages = [];
    this.closed = false;
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message, transfer = []) {
    this.messages.push({ message, transfer });
  }

  start() {}

  close() { this.closed = true; }

  emit(data, ports = []) {
    for (const listener of this.listeners) listener({ data, ports });
  }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("utility runtime dispatches dedicated terminal ports to the exact registered interceptor", async () => {
  const { startPluginRuntime } = await import("./runtimePeer.mjs");
  const control = new FakePort();
  const runtime = await startPluginRuntime({
    port: control,
    config: {
      pluginId: "com.example",
      pluginVersion: "1.0.0",
      netcattyVersion: "1.0.0",
      apiVersion: "1.0.0",
      enabledFeatures: [],
      environment: {},
      entryUrl: "file:///plugin.js",
    },
    loadPlugin: async () => ({
      default: {
        activate(context) {
          context.providers.register(
            "com.example.input",
            "terminal.interceptor.input",
            ({ data }) => Uint8Array.from([...data].map((byte) => byte >= 97 && byte <= 122 ? byte - 32 : byte)),
          );
        },
      },
    }),
  });
  control.emit({ jsonrpc: "2.0", id: 1, method: "plugin.initialize", params: {} });
  await tick();
  control.emit({ jsonrpc: "2.0", id: 2, method: "plugin.activate", params: {} });
  await tick();

  const dataPort = new FakePort();
  control.emit({
    type: "netcatty-plugin:terminal-interceptor:attach",
    descriptor: {
      providerId: "com.example.input",
      direction: "input",
      session: { sessionId: "session-1", protocol: "ssh", status: "connected" },
    },
  }, [dataPort]);
  const data = Uint8Array.from(Buffer.from("hello")).buffer;
  dataPort.emit({
    type: "netcatty:terminal-interceptor:chunk",
    sequence: 1,
    direction: "input",
    data,
  });
  await tick();
  assert.equal(dataPort.messages.length, 1);
  assert.equal(dataPort.messages[0].message.status, "ok");
  assert.equal(dataPort.messages[0].message.creditBytes, 5);
  assert.equal(Buffer.from(dataPort.messages[0].message.data).toString("utf8"), "HELLO");
  assert.deepEqual(dataPort.messages[0].transfer, [dataPort.messages[0].message.data]);
  await runtime.dispose();
});

test("utility runtime closes a terminal port when provider ownership or kind is invalid", async () => {
  const { startPluginRuntime } = await import("./runtimePeer.mjs");
  const control = new FakePort();
  const runtime = await startPluginRuntime({
    port: control,
    config: {
      pluginId: "com.example",
      pluginVersion: "1.0.0",
      netcattyVersion: "1.0.0",
      apiVersion: "1.0.0",
      enabledFeatures: [],
      environment: {},
      entryUrl: "file:///plugin.js",
    },
    loadPlugin: async () => ({ default: { activate() {} } }),
  });
  control.emit({ jsonrpc: "2.0", id: 1, method: "plugin.initialize", params: {} });
  await tick();
  control.emit({ jsonrpc: "2.0", id: 2, method: "plugin.activate", params: {} });
  await tick();
  const dataPort = new FakePort();
  control.emit({
    type: "netcatty-plugin:terminal-interceptor:attach",
    descriptor: {
      providerId: "com.example.missing",
      direction: "input",
      session: { sessionId: "session-1" },
    },
  }, [dataPort]);
  assert.equal(dataPort.closed, true);
  await runtime.dispose();
});

test("terminal ports convert synchronous throws to failures and stop using disposed handlers", async () => {
  const { startPluginRuntime } = await import("./runtimePeer.mjs");
  const control = new FakePort();
  let registration;
  let calls = 0;
  const runtime = await startPluginRuntime({
    port: control,
    config: {
      pluginId: "com.example",
      pluginVersion: "1.0.0",
      netcattyVersion: "1.0.0",
      apiVersion: "1.0.0",
      enabledFeatures: [],
      environment: {},
      entryUrl: "file:///plugin.js",
    },
    loadPlugin: async () => ({
      default: {
        activate(context) {
          registration = context.providers.register(
            "com.example.input",
            "terminal.interceptor.input",
            () => {
              calls += 1;
              throw new Error("synchronous failure");
            },
          );
        },
      },
    }),
  });
  control.emit({ jsonrpc: "2.0", id: 1, method: "plugin.initialize", params: {} });
  await tick();
  control.emit({ jsonrpc: "2.0", id: 2, method: "plugin.activate", params: {} });
  await tick();

  const dataPort = new FakePort();
  control.emit({
    type: "netcatty-plugin:terminal-interceptor:attach",
    descriptor: {
      providerId: "com.example.input",
      direction: "input",
      session: { sessionId: "session-1", protocol: "ssh", status: "connected" },
    },
  }, [dataPort]);
  const send = (sequence) => dataPort.emit({
    type: "netcatty:terminal-interceptor:chunk",
    sequence,
    direction: "input",
    data: Uint8Array.from([sequence]).buffer,
  });
  send(1);
  await tick();
  assert.equal(dataPort.messages[0].message.status, "failed");
  assert.equal(calls, 1);

  registration.dispose();
  send(2);
  await tick();
  assert.equal(dataPort.messages[1].message.status, "failed");
  assert.equal(calls, 1);
  await runtime.dispose();
});
