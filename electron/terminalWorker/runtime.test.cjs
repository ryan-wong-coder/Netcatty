const assert = require("node:assert/strict");
const test = require("node:test");

const { createTerminalWorkerRuntime } = require("./runtime.cjs");

class FakePort {
  constructor() {
    this.messages = [];
    this.closed = false;
    this.started = false;
    this.listeners = new Map();
  }

  postMessage(message) {
    this.messages.push(message);
  }

  start() {
    this.started = true;
  }

  close() {
    this.closed = true;
  }

  on(channel, callback) {
    this.listeners.set(channel, callback);
  }

  emitMessage(message) {
    const callback = this.listeners.get("message");
    if (callback) {
      callback({ data: message });
      return;
    }
    this.onmessage?.({ data: message });
  }
}

function createParentPort() {
  const messages = [];
  const listeners = new Map();
  return {
    messages,
    on(channel, cb) {
      listeners.set(channel, cb);
    },
    postMessage(message) {
      messages.push(message);
    },
    emitMessage(message) {
      listeners.get("message")?.(message);
    },
  };
}

test("runtime invokes registered request handlers and posts responses", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", async (_event, payload) => ({ ok: true, payload }));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: { value: 1 },
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages, [
    {
      kind: "response",
      requestId: "req-1",
      result: { ok: true, payload: { value: 1 } },
    },
  ]);
});

test("runtime routes interceptor ports to the worker-owned data pipeline", () => {
  const parentPort = createParentPort();
  const attached = [];
  const detached = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      attach(message, port) { attached.push({ message, port }); },
      detach(sessionId, direction) { detached.push({ sessionId, direction }); },
    },
    registerBridges() {},
  });
  runtime.start();
  const port = new FakePort();
  parentPort.emitMessage({
    data: { kind: "terminal-interceptor-port", sessionId: "session-1", direction: "output" },
    ports: [port],
  });
  assert.equal(attached[0].port, port);
  parentPort.emitMessage({ kind: "terminal-interceptor-detach", sessionId: "session-1", direction: "output" });
  assert.deepEqual(detached, [{ sessionId: "session-1", direction: "output" }]);
});

test("runtime invokes fire-and-forget listeners", () => {
  const parentPort = createParentPort();
  const calls = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:write", (_event, payload) => calls.push(payload));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:write",
    payload: { sessionId: "s1", data: "x" },
    webContentsId: 7,
  });

  assert.deepEqual(calls, [{ sessionId: "s1", data: "x" }]);
});

test("runtime sends output drain markers through the session output port", () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({ parentPort, registerBridges() {} });
  runtime.start();

  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1" },
    ports: [outputPort],
  });
  parentPort.emitMessage({ kind: "output-drain", sessionId: "s1", requestId: "drain-1" });

  assert.deepEqual(outputPort.messages, [
    { kind: "drain", requestId: "drain-1", sessionId: "s1" },
  ]);
});

test("runtime closes an urgent input port when its renderer is destroyed", () => {
  const parentPort = createParentPort();
  const urgentPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({ parentPort, registerBridges() {} });
  runtime.start();
  parentPort.emitMessage({
    data: { kind: "urgent-input-port", webContentsId: 7 },
    ports: [urgentPort],
  });

  parentPort.emitMessage({ kind: "close-urgent-input-port", webContentsId: 7 });

  assert.equal(urgentPort.closed, true);
});

test("runtime routes urgent input port interrupts to the interrupt listener", () => {
  const parentPort = createParentPort();
  const urgentPort = new FakePort();
  const calls = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:interrupt", (event, payload) => {
        calls.push({ senderId: event.sender.id, payload });
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "urgent-input-port",
      webContentsId: 7,
    },
    ports: [urgentPort],
  });
  urgentPort.emitMessage({
    kind: "interrupt",
    sessionId: "s1",
    trace: { traceId: "trace-1" },
  });

  assert.equal(urgentPort.started, true);
  assert.deepEqual(calls, [
    {
      senderId: 7,
      payload: {
        sessionId: "s1",
        trace: { traceId: "trace-1" },
        urgentInputPort: true,
      },
    },
  ]);
});

test("runtime clears host-sensitive input state before dispatching an interrupt", () => {
  const parentPort = createParentPort();
  const order = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      clearSensitiveInput(sessionId) { order.push(`clear:${sessionId}`); },
    },
    registerBridges(ipcMain) {
      ipcMain.on("netcatty:interrupt", (_event, payload) => order.push(`write:${payload.sessionId}`));
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "send",
    channel: "netcatty:interrupt",
    payload: { sessionId: "s1" },
    webContentsId: 7,
  });

  assert.deepEqual(order, ["clear:s1", "write:s1"]);
});

test("runtime routes terminal data over output messages", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages[0], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
  assert.deepEqual(parentPort.messages[1], {
    kind: "output",
    sessionId: "s1",
    data: "hello",
    tapped: true,
  });
});

test("runtime keeps the no-interceptor output path synchronous and allocation-free", async () => {
  const parentPort = createParentPort();
  let interceptCalls = 0;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 0; },
      async interceptOutput() { interceptCalls += 1; return "changed"; },
    },
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        assert.equal(parentPort.messages[1]?.data, "hello");
        return null;
      });
    },
  });
  runtime.start();
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-no-plugin",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interceptCalls, 0);
});

test("runtime sends transformed output to the renderer while host taps retain original data", async () => {
  const parentPort = createParentPort();
  const observed = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 3; },
      observeOutput(sessionId, data) { observed.push({ sessionId, data }); return true; },
      async interceptOutput(_sessionId, data) { return String(data).toUpperCase(); },
    },
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return null;
      });
    },
  });
  runtime.start();
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-plugin",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages[0], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
  assert.deepEqual(parentPort.messages[1], {
    kind: "output",
    sessionId: "s1",
    data: "HELLO",
    tapped: true,
    meta: { pluginPipelineIngressBytes: 5, pluginPipelineSensitiveInput: true },
  });
  assert.deepEqual(observed, [{ sessionId: "s1", data: "hello" }]);
});

test("runtime classifies original prompts when only an output interceptor is active", async () => {
  const parentPort = createParentPort();
  const observed = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput(sessionId, data) { observed.push({ sessionId, data }); return true; },
      async interceptOutput() { return "masked> "; },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "Password: " });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, [{ sessionId: "s1", data: "Password: " }]);
  assert.deepEqual(parentPort.messages.at(-1), {
    kind: "output",
    sessionId: "s1",
    data: "masked> ",
    tapped: true,
    meta: { pluginPipelineIngressBytes: 10, pluginPipelineSensitiveInput: true },
  });
});

test("runtime delivers pending intercepted output before closing the session", async () => {
  const parentPort = createParentPort();
  let releaseOutput;
  const detached = [];
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return 2; },
      observeOutput() { return false; },
      interceptOutput() {
        return new Promise((resolve) => { releaseOutput = resolve; });
      },
      detach(sessionId, direction, reason) { detached.push({ sessionId, direction, reason }); },
    },
    registerBridges() {},
  });
  runtime.start();
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "final" });
  runtime.createSender(7).send("netcatty:exit", { sessionId: "s1", reason: "closed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), ["output-tap"]);

  releaseOutput("FINAL");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), [
    "output-tap",
    "output",
    "renderer-event",
  ]);
  assert.equal(parentPort.messages[1].data, "FINAL");
  assert.equal(parentPort.messages[2].channel, "netcatty:exit");
  assert.deepEqual(detached, [{ sessionId: "s1", direction: undefined, reason: "session-closed" }]);
});

test("runtime keeps direct output ordered behind a pending chunk after interceptor disable", async () => {
  const parentPort = createParentPort();
  let mode = 2;
  let releaseOutput;
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline: {
      getOutputMode() { return mode; },
      observeOutput() { return false; },
      interceptOutput() {
        mode = 0;
        return new Promise((resolve) => { releaseOutput = resolve; });
      },
    },
    registerBridges() {},
  });
  runtime.start();

  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "first" });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentPort.messages.map((message) => message.kind), ["output-tap", "output-tap"]);

  releaseOutput("FIRST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    parentPort.messages.filter((message) => message.kind === "output").map((message) => message.data),
    ["FIRST", "second"],
  );
});

test("runtime routes terminal data over a transferred output port", async () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:data", { sessionId: "s1", data: "hello" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    data: {
      kind: "output-port",
      sessionId: "s1",
      bufferedOutput: ["early"],
    },
    ports: [outputPort],
  });
  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outputPort.started, true);
  assert.deepEqual(outputPort.messages, [
    { sessionId: "s1", data: "early" },
    { sessionId: "s1", data: "hello" },
  ]);
  assert.equal(parentPort.messages[0].kind, "output-port-ready");
  assert.deepEqual(parentPort.messages[1], {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
  assert.equal(parentPort.messages.some((message) => message.kind === "output"), false);
});

test("runtime.createSender uses the transferred output port", () => {
  const parentPort = createParentPort();
  const outputPort = new FakePort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges() {},
  });
  runtime.start();

  parentPort.emitMessage({
    data: { kind: "output-port", sessionId: "s1" },
    ports: [outputPort],
  });
  runtime.createSender(7).send("netcatty:data", { sessionId: "s1", data: "hello" });

  assert.deepEqual(outputPort.messages, [{ sessionId: "s1", data: "hello" }]);
  assert.deepEqual(parentPort.messages.at(-1), {
    kind: "output-tap",
    sessionId: "s1",
    data: "hello",
  });
});

test("runtime forwards non-output renderer events to the parent", async () => {
  const parentPort = createParentPort();
  const runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      ipcMain.handle("netcatty:test", (event) => {
        event.sender.send("netcatty:exit", { sessionId: "s1", reason: "closed" });
        return { done: true };
      });
    },
  });
  runtime.start();

  parentPort.emitMessage({
    kind: "request",
    requestId: "req-1",
    channel: "netcatty:test",
    payload: {},
    webContentsId: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(parentPort.messages[0], {
    kind: "renderer-event",
    webContentsId: 7,
    channel: "netcatty:exit",
    payload: { sessionId: "s1", reason: "closed" },
  });
});
