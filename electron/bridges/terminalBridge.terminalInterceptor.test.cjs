"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");

function createHarness() {
  const writes = [];
  const intercepted = [];
  const sessions = new Map([["session-1", {
    type: "local",
    proc: { write(data) { writes.push(String(data)); } },
  }]]);
  terminalBridge.init({
    sessions,
    electronModule: {},
    terminalDataPipeline: {
      has(sessionId, direction) { return sessionId === "session-1" && direction === "input"; },
      async interceptInput(sessionId, data, options) {
        if (options?.bypass || options?.sensitive) return data;
        intercepted.push({ sessionId, data, options });
        return String(data).toUpperCase();
      },
    },
  });
  return { writes, intercepted };
}

test("ordinary terminal input uses the worker-owned interceptor before transport encoding", async () => {
  const h = createHarness();
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted.map((entry) => entry.data), ["hello"]);
  assert.deepEqual(h.writes, ["HELLO"]);
});

test("host-classified sensitive input bypasses interceptors and preserves original bytes", async () => {
  const h = createHarness();
  terminalBridge.writeToSession(null, {
    sessionId: "session-1",
    data: "secret\r",
    sensitive: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted, []);
  assert.deepEqual(h.writes, ["secret\r"]);
});

test("host terminal protocol replies bypass third-party interceptors", async () => {
  const h = createHarness();
  terminalBridge.writeToSession(null, { sessionId: "session-1", data: "\x1b[1;2R" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.intercepted, []);
  assert.deepEqual(h.writes, ["\x1b[1;2R"]);
});
