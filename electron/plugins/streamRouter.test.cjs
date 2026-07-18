"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginStreamRouter } = require("./streamRouter.cjs");

test("incoming stream credit is returned only after the consumer releases a chunk", async () => {
  const sent = [];
  const received = [];
  let router;
  router = new PluginStreamRouter({
    send(message) { sent.push(message); },
    onIncomingStream({ streamId }) {
      router.bindIncoming(streamId, {
        async onChunk(chunk, release) {
          received.push(chunk.value);
          assert.equal(sent.length, 0);
          release();
        },
      });
      return true;
    },
  });
  await router.accept({ frame: { streamId: "input", sequence: 0, kind: "open", windowBytes: 1024 } });
  const contract = await import("@netcatty/plugin-contract");
  await router.accept({
    frame: {
      streamId: "input",
      sequence: 1,
      kind: "chunk",
      data: contract.createJsonStreamChunk({ value: 1 }),
    },
  });
  assert.deepEqual(received, [{ value: 1 }]);
  assert.equal(sent[0].frame.kind, "windowUpdate");
});

test("outgoing stream applies byte backpressure and ordered credit updates", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("output", 1024);
  const source = new Uint8Array(1024);
  source[0] = 7;
  await stream.write(source);
  source[0] = 99;
  assert.equal(new Uint8Array(sent[1].transfer)[0], 7);
  let secondResolved = false;
  const second = stream.write(new Uint8Array(1)).then(() => { secondResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  await router.accept({
    frame: { streamId: "output", sequence: 0, kind: "windowUpdate", creditBytes: 1 },
  });
  await second;
  assert.equal(sent.filter((message) => message.frame.kind === "chunk").length, 2);
  await assert.rejects(
    router.accept({ frame: { streamId: "output", sequence: 0, kind: "windowUpdate", creditBytes: 1 } }),
    /Out-of-order/,
  );
  await assert.rejects(
    router.accept({ frame: { streamId: "output", sequence: 2, kind: "windowUpdate", creditBytes: 1 } }),
    /Out-of-order/,
  );
});

test("unhandled incoming streams are cancelled immediately", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  await router.accept({ frame: { streamId: "unhandled", sequence: 0, kind: "open", windowBytes: 1024 } });
  assert.equal(sent[0].frame.kind, "cancel");
});

test("stream envelopes reject extra fields and accessors before state changes", async () => {
  const router = new PluginStreamRouter({ send() {} });
  await assert.rejects(router.accept({
    frame: { streamId: "extra", sequence: 0, kind: "open", windowBytes: 1024 },
    unexpected: true,
  }), /unknown properties/);
  const accessor = {};
  Object.defineProperty(accessor, "frame", {
    enumerable: true,
    get() { throw new Error("accessor invoked"); },
  });
  await assert.rejects(router.accept(accessor), /data properties/);
});

test("peer cancellation closes only the matching outgoing stream", async () => {
  const sent = [];
  const router = new PluginStreamRouter({ send(message) { sent.push(message); } });
  const stream = await router.openOutgoing("cancelled", 1024);
  await router.accept({
    frame: { streamId: "cancelled", sequence: 1, kind: "cancel" },
  });
  await assert.rejects(stream.write(new Uint8Array([1])), /closed/);
  const other = await router.openOutgoing("other", 1024);
  await other.write(new Uint8Array([2]));
  assert.equal(sent.at(-1).frame.streamId, "other");
});
