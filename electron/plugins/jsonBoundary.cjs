"use strict";

const PLUGIN_JSON_MAX_DEPTH = 128;
const PLUGIN_JSON_MAX_NODES = 100_000;

function assertPluginJsonValue(value) {
  const stack = [{ value, depth: 0 }];
  const ancestors = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.exit) {
      ancestors.delete(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > PLUGIN_JSON_MAX_NODES) {
      throw new RangeError(`Plugin JSON exceeds ${PLUGIN_JSON_MAX_NODES} values`);
    }
    if (current.depth > PLUGIN_JSON_MAX_DEPTH) {
      throw new RangeError(`Plugin JSON exceeds ${PLUGIN_JSON_MAX_DEPTH} levels`);
    }
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Plugin JSON numbers must be finite");
      continue;
    }
    if (typeof item !== "object") throw new TypeError("Plugin wire values must be JSON values");
    if (ancestors.has(item)) throw new TypeError("Plugin JSON values must not contain cycles");
    ancestors.add(item);
    stack.push({ value: item, depth: current.depth, exit: true });
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Reflect.ownKeys(item).length !== item.length + 1) {
        throw new TypeError("Plugin JSON arrays must be dense and contain no named properties");
      }
      for (let index = item.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Plugin JSON arrays must contain enumerable data properties only");
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Plugin JSON objects must be plain objects");
    }
    const stringKeys = Object.keys(item);
    if (Reflect.ownKeys(item).length !== stringKeys.length) {
      throw new TypeError("Plugin JSON objects must not contain symbols or non-enumerable properties");
    }
    for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
      const descriptor = Object.getOwnPropertyDescriptor(item, stringKeys[index]);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Plugin JSON objects must contain own data properties");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return value;
}

module.exports = {
  PLUGIN_JSON_MAX_DEPTH,
  PLUGIN_JSON_MAX_NODES,
  assertPluginJsonValue,
};
