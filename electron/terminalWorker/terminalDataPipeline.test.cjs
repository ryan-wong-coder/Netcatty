"use strict";

const assert = require("node:assert/strict");
const { MessageChannel } = require("node:worker_threads");
const test = require("node:test");

const {
  createTerminalDataPipeline,
} = require("./terminalDataPipeline.cjs");

function listen(port, listener) {
  port.on("message", listener);
  port.start?.();
}

function attachTransform(pipeline, options = {}) {
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  const seen = [];
  listen(channel.port2, (message) => {
    if (message.type !== "netcatty:terminal-interceptor:chunk") return;
    seen.push({ sequence: message.sequence, data: Buffer.from(message.data).toString("utf8") });
    if (options.hold) return;
    const transformed = Buffer.from(options.transform?.(Buffer.from(message.data).toString("utf8"))
      ?? Buffer.from(message.data).toString("utf8").toUpperCase());
    const data = Uint8Array.from(transformed).buffer;
    channel.port2.postMessage({
      type: "netcatty:terminal-interceptor:result",
      sequence: message.sequence,
      status: "ok",
      creditBytes: Buffer.from(message.data).byteLength,
      data,
    }, [data]);
  });
  pipeline.attach({
    sessionId: options.sessionId ?? "session-1",
    direction: options.direction ?? "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  return { channel, seen };
}

test("terminal input interception transfers bounded UTF-8 chunks and preserves ordering", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(await pipeline.interceptInput("session-1", "hello"), "HELLO");
  assert.equal(await pipeline.interceptInput("session-1", "world"), "WORLD");
  assert.deepEqual(seen, [
    { sequence: 1, data: "hello" },
    { sequence: 2, data: "world" },
  ]);
  pipeline.shutdown();
});

test("sensitive input bypasses the third-party port unconditionally", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(await pipeline.interceptInput("session-1", "password\r", { sensitive: true }), "password\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  assert.equal(pipeline.has("session-1", "input"), true);
  pipeline.shutdown();
});

test("sensitive passthrough stays ordered behind earlier intercepted input", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  let firstChunk;
  listen(channel.port2, (message) => {
    if (message.type === "netcatty:terminal-interceptor:chunk") firstChunk = message;
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  const order = [];
  const ordinary = pipeline.interceptInput("session-1", "a").then((value) => order.push(value));
  const sensitive = pipeline.interceptInput("session-1", "secret", { sensitive: true })
    .then((value) => order.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(firstChunk);
  assert.deepEqual(order, []);
  const result = Uint8Array.from(Buffer.from("A")).buffer;
  channel.port2.postMessage({
    type: "netcatty:terminal-interceptor:result",
    sequence: firstChunk.sequence,
    status: "ok",
    creditBytes: 1,
    data: result,
  }, [result]);
  await Promise.all([ordinary, sensitive]);
  assert.deepEqual(order, ["A", "secret"]);
  pipeline.shutdown();
});

test("original output protects password input even when a plugin could hide the prompt", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(pipeline.getOutputMode("session-1"), 1);
  pipeline.observeOutput("session-1", "\u001b[31mPass");
  pipeline.observeOutput("session-1", "word:\u001b[0m ");
  assert.equal(await pipeline.interceptInput("session-1", "hunter2"), "hunter2");
  assert.equal(await pipeline.interceptInput("session-1", "\r"), "\r");
  assert.deepEqual(seen, []);
  assert.equal(await pipeline.interceptInput("session-1", "next"), "NEXT");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.observeOutput("session-1", "Pass\u001b[0");
  assert.equal(pipeline.observeOutput("session-1", "mword: "), true);
  assert.equal(await pipeline.interceptInput("session-1", "split-secret\r"), "split-secret\r");
  pipeline.observeOutput("session-1", "Custom authentication> ");
  assert.equal(await pipeline.interceptInput("session-1", "opaque\r"), "opaque\r");
  pipeline.observeOutput("session-1", "请输入验证码：");
  assert.equal(await pipeline.interceptInput("session-1", "123456\r"), "123456\r");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.shutdown();
});

test("an input deadline failure fails open, disables the session binding, and warns once", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 5, onWarning: (value) => warnings.push(value) });
  attachTransform(pipeline, { hold: true });
  assert.equal(await pipeline.interceptInput("session-1", "slow"), "slow");
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "timeout");
  assert.equal(await pipeline.interceptInput("session-1", "later"), "later");
  assert.equal(warnings.length, 1);
});

test("an elapsed deadline rejects a late response before its delayed timer callback runs", async () => {
  const warnings = [];
  let now = 1_000;
  const pipeline = createTerminalDataPipeline({
    inputDeadlineMs: 100,
    now: () => now,
    onWarning: (value) => warnings.push(value),
  });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  listen(channel.port2, (message) => {
    if (message.type !== "netcatty:terminal-interceptor:chunk") return;
    now += 100;
    const data = Uint8Array.from(Buffer.from("LATE")).buffer;
    channel.port2.postMessage({
      type: "netcatty:terminal-interceptor:result",
      sequence: message.sequence,
      status: "ok",
      creditBytes: Buffer.from(message.data).byteLength,
      data,
    }, [data]);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);

  assert.equal(await pipeline.interceptInput("session-1", "original"), "original");
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "timeout");
});

test("output interception is credit bounded and fails open under backpressure", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    outputDeadlineMs: 100,
    outputWindowBytes: 5,
    onWarning: (value) => warnings.push(value),
  });
  attachTransform(pipeline, { direction: "output", hold: true });
  const order = [];
  const first = pipeline.interceptOutput("session-1", "1234")
    .then((value) => { order.push(value); return value; });
  const second = pipeline.interceptOutput("session-1", "5678")
    .then((value) => { order.push(value); return value; });
  assert.deepEqual(await Promise.all([first, second]), ["1234", "5678"]);
  assert.deepEqual(order, ["1234", "5678"]);
  assert.equal(warnings[0].code, "backpressure");
  assert.equal(pipeline.has("session-1", "output"), false);
});

test("invalid interceptor UTF-8 fails open and permanently trips the circuit breaker", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100, onWarning: (value) => warnings.push(value) });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  listen(channel.port2, (message) => {
    if (message.type !== "netcatty:terminal-interceptor:chunk") return;
    const data = Uint8Array.from([0xff]).buffer;
    channel.port2.postMessage({
      type: "netcatty:terminal-interceptor:result",
      sequence: message.sequence,
      status: "ok",
      creditBytes: 4,
      data,
    }, [data]);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  assert.equal(await pipeline.interceptInput("session-1", "safe"), "safe");
  assert.equal(warnings[0].code, "encoding");
  assert.equal(pipeline.has("session-1", "input"), false);
});
