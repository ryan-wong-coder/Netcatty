"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PLUGIN_JSON_MAX_DEPTH,
  PLUGIN_JSON_MAX_NODES,
  assertPluginJsonValue,
} = require("./jsonBoundary.cjs");

test("main-process JSON boundary matches the public contract budgets", async () => {
  const contract = await import("@netcatty/plugin-contract");
  assert.equal(PLUGIN_JSON_MAX_DEPTH, contract.PLUGIN_JSON_MAX_DEPTH);
  assert.equal(PLUGIN_JSON_MAX_NODES, contract.PLUGIN_JSON_MAX_NODES);
});

test("main-process JSON boundary rejects deep, sparse, cyclic, and accessor values", () => {
  let deep = null;
  for (let index = 0; index <= PLUGIN_JSON_MAX_DEPTH; index += 1) deep = [deep];
  assert.throws(() => assertPluginJsonValue(deep), /levels/);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => assertPluginJsonValue(sparse), /dense/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => assertPluginJsonValue(cyclic), /cycles/);
  const accessor = {};
  Object.defineProperty(accessor, "value", { get: () => 1, enumerable: true });
  assert.throws(() => assertPluginJsonValue(accessor), /data properties/);
});
