import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CancellationError,
  CancellationTokenSource,
  definePlugin,
  DisposableStore,
  PluginError,
  PLUGIN_ERROR_WIRE_CODES,
  pluginErrorToRpcError,
  throwIfCancellationRequested,
} from "./index.ts";
import type { PluginSecretStore, SecretRef } from "./index.ts";

const testSecretRef: SecretRef = {
  kind: "secret",
  id: "secret-reference-1",
  key: "token",
};

const testSecretStore: PluginSecretStore = {
  async get() {
    return testSecretRef;
  },
  async set() {
    return testSecretRef;
  },
  async delete() {},
};

test("PluginError maps stable SDK codes to stable JSON-RPC wire errors", () => {
  const error = new PluginError("permission_denied", "Approval required", { scope: "terminal" });
  assert.deepEqual(pluginErrorToRpcError(error), {
    code: -32007,
    message: "Approval required",
    data: {
      pluginCode: "permission_denied",
      details: { scope: "terminal" },
    },
  });
  assert.equal(PLUGIN_ERROR_WIRE_CODES.cancelled, -32001);
  assert.equal(PLUGIN_ERROR_WIRE_CODES.internal, -32013);
  assert.equal(new Set(Object.values(PLUGIN_ERROR_WIRE_CODES)).size, 16);
  for (const code of Object.keys(PLUGIN_ERROR_WIRE_CODES)) {
    const mapped = pluginErrorToRpcError(new PluginError(
      code as keyof typeof PLUGIN_ERROR_WIRE_CODES,
      code,
    ));
    assert.equal(mapped.code, PLUGIN_ERROR_WIRE_CODES[code as keyof typeof PLUGIN_ERROR_WIRE_CODES]);
    assert.deepEqual(mapped.data, { pluginCode: code });
  }
});

test("PluginError wire mapping covers the exact contract schema enums", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../plugin-contract/schema/plugin-contract.schema.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(
    Object.keys(PLUGIN_ERROR_WIRE_CODES).sort(),
    [...schema.$defs.PluginErrorName.enum].sort(),
  );
  assert.deepEqual(
    Object.values(PLUGIN_ERROR_WIRE_CODES).sort((left, right) => left - right),
    [...schema.$defs.PluginWireErrorCode.enum].sort((left, right) => left - right),
  );
});

test("definePlugin preserves the exact plugin object", () => {
  const plugin = definePlugin({ activate() {} });
  assert.equal(typeof plugin.activate, "function");
});

test("PluginSecretStore exposes opaque references instead of plaintext reads", async () => {
  assert.deepEqual(await testSecretStore.get("token"), testSecretRef);
  assert.deepEqual(await testSecretStore.set("token", "already-known-value"), testSecretRef);
  assert.equal("value" in testSecretRef, false);
  assert.equal(testSecretRef.key, "token");
});

test("terminal interceptor typing stays specialized while broad ProviderKind helpers remain compatible", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /kind: Exclude<ProviderKind, TerminalInterceptorKind>,\s*handler: PluginProviderHandler/u,
  );
  assert.match(
    source,
    /type ProviderHandlerForKind<[\s\S]*K extends TerminalInterceptorKind[\s\S]*TerminalInterceptorHandler/u,
  );
  assert.match(
    source,
    /kind: K,\s*handler: ProviderHandlerForKind<NoInfer<K>, TPayload, TResult>/u,
  );
});

test("DisposableStore disposes every item once", () => {
  const store = new DisposableStore();
  const calls: string[] = [];
  store.add({ dispose: () => calls.push("first") });
  store.add({ dispose: () => calls.push("second") });

  store.dispose();
  store.dispose();

  assert.deepEqual(calls, ["first", "second"]);
});

test("DisposableStore disposes rejected late additions", () => {
  const store = new DisposableStore();
  store.dispose();
  let disposed = false;

  assert.throws(
    () => store.add({ dispose: () => { disposed = true; } }),
    (error) => error instanceof PluginError && error.code === "unavailable",
  );
  assert.equal(disposed, true);
});

test("CancellationTokenSource notifies listeners once", () => {
  const source = new CancellationTokenSource();
  let count = 0;
  source.token.onCancellationRequested(() => count += 1);

  source.cancel();
  source.cancel();

  assert.equal(count, 1);
  assert.equal(source.token.isCancellationRequested, true);
  assert.throws(
    () => throwIfCancellationRequested(source.token),
    CancellationError,
  );
});

test("CancellationTokenSource notifies every listener before reporting failures", () => {
  const source = new CancellationTokenSource();
  const calls: string[] = [];
  source.token.onCancellationRequested(() => {
    calls.push("failing");
    throw new Error("listener failed");
  });
  source.token.onCancellationRequested(() => calls.push("surviving"));

  assert.throws(
    () => source.cancel(),
    (error) => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] instanceof Error
      && error.errors[0].message === "listener failed",
  );
  assert.deepEqual(calls, ["failing", "surviving"]);
  assert.equal(source.token.isCancellationRequested, true);
  assert.doesNotThrow(() => source.cancel());
});

test("CancellationTokenSource finishes disposal when a cancellation listener fails", () => {
  const source = new CancellationTokenSource();
  source.token.onCancellationRequested(() => {
    throw new Error("listener failed");
  });

  assert.throws(() => source.dispose(true), AggregateError);
  assert.doesNotThrow(() => source.dispose(true));
});
