import {
  CancellationTokenSource,
  DisposableStore,
  PluginError,
  pluginErrorToRpcError,
} from "@netcatty/plugin-sdk";
import { createMessagePortStreamEnvelope } from "@netcatty/plugin-contract";

const RPC_ERRORS = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  cancelled: -32001,
  unsupported: -32012,
};

function messageData(value) {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

function createTransportAdapter(port) {
  const listeners = new Set();
  const handle = (event) => {
    const value = messageData(event);
    for (const listener of listeners) listener(value);
  };
  if (typeof port.addEventListener === "function") port.addEventListener("message", handle);
  else port.on("message", handle);
  port.start?.();
  return {
    post(message, transfer = []) {
      port.postMessage(message, transfer);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      port.close?.();
    },
  };
}

function makeRpcFailure(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function cancelUnhandledStream(transport, message) {
  const keys = Reflect.ownKeys(message);
  if (keys.some((key) => typeof key !== "string" || (key !== "frame" && key !== "transfer"))) {
    throw new TypeError("Plugin stream envelope contains unknown properties");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Plugin stream envelope must contain enumerable data properties");
    }
  }
  const envelope = createMessagePortStreamEnvelope(message.frame, message.transfer);
  if (envelope.frame.kind !== "open") {
    throw new Error(`Unknown incoming plugin stream: ${envelope.frame.streamId}`);
  }
  transport.post(createMessagePortStreamEnvelope({
    streamId: envelope.frame.streamId,
    sequence: 1,
    kind: "cancel",
  }));
}

function normalizeError(error) {
  if (error instanceof PluginError) {
    return pluginErrorToRpcError(error);
  }
  return { code: RPC_ERRORS.internal, message: "Plugin operation failed" };
}

function createHostClient(transport) {
  let nextId = 0;
  const pending = new Map();
  function accept(message) {
    if (!message || typeof message !== "object" || !Object.hasOwn(message, "id")) return false;
    if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) return false;
    const request = pending.get(`${typeof message.id}:${String(message.id)}`);
    if (!request) return false;
    pending.delete(`${typeof message.id}:${String(message.id)}`);
    if (message.error) {
      request.reject(new PluginError(
        message.error.data?.pluginCode ?? "unknown",
        message.error.message,
        message.error.data?.details,
      ));
    } else request.resolve(message.result);
    return true;
  }
  function request(method, params) {
    const id = nextId;
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 0 : nextId + 1;
    return new Promise((resolve, reject) => {
      pending.set(`${typeof id}:${String(id)}`, { resolve, reject });
      transport.post({ jsonrpc: "2.0", id, method, params });
    });
  }
  function notify(method, params) {
    transport.post({ jsonrpc: "2.0", method, params });
  }
  function close() {
    const error = new PluginError("unavailable", "Plugin host disconnected");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  return { accept, request, notify, close };
}

function assertStorageKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new PluginError("invalid_argument", "Plugin storage key is invalid");
  }
  return key;
}

function createPluginContext(config, client) {
  const subscriptions = new DisposableStore();
  const storage = {
    get: (key) => client.request("storage.get", { key: assertStorageKey(key) })
      .then((result) => result?.found ? result.value : undefined),
    set: (key, value) => client.request("storage.set", { key: assertStorageKey(key), value })
      .then(() => undefined),
    delete: (key) => client.request("storage.delete", { key: assertStorageKey(key) })
      .then(() => undefined),
    keys: () => client.request("storage.keys", {}).then((result) => result?.keys ?? []),
  };
  const secrets = {
    get: () => Promise.reject(new PluginError("unsupported", "Plugin secrets require the permission runtime")),
    set: () => Promise.reject(new PluginError("unsupported", "Plugin secrets require the permission runtime")),
    delete: () => Promise.reject(new PluginError("unsupported", "Plugin secrets require the permission runtime")),
  };
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
    level,
    (message, fields) => client.notify("log.write", {
      level,
      message: String(message).slice(0, 2_048),
      ...(fields === undefined ? {} : { fields }),
    }),
  ]));
  return {
    pluginId: config.pluginId,
    netcattyVersion: config.netcattyVersion,
    apiVersion: config.apiVersion,
    enabledFeatures: new Set(config.enabledFeatures),
    subscriptions,
    storage,
    secrets,
    logger,
  };
}

export async function startPluginRuntime({ port, config, loadPlugin }) {
  const transport = createTransportAdapter(port);
  const client = createHostClient(transport);
  const cancellation = new Map();
  let plugin;
  let context;
  let activated = false;
  let deactivated = false;
  const pluginModule = await loadPlugin(config.entryUrl);
  plugin = pluginModule?.default;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error("Plugin entrypoint must default-export a plugin with activate(context)");
  }

  async function handleRequest(message) {
    if (message.method === "plugin.initialize") {
      if (context) throw new PluginError("failed_precondition", "Plugin is already initialized");
      context = createPluginContext(config, client);
      return {
        pluginId: config.pluginId,
        pluginVersion: config.pluginVersion,
        apiVersion: config.apiVersion,
        enabledFeatures: [...config.enabledFeatures],
      };
    }
    if (message.method === "plugin.activate") {
      if (!context) throw new PluginError("failed_precondition", "Plugin must be initialized first");
      if (!activated) {
        const disposable = await plugin.activate(context);
        if (disposable && typeof disposable.dispose === "function") context.subscriptions.add(disposable);
        activated = true;
      }
      return null;
    }
    if (message.method === "plugin.deactivate") {
      if (!deactivated) {
        deactivated = true;
        await plugin.deactivate?.();
        context?.subscriptions.dispose();
      }
      return null;
    }
    throw new PluginError("unsupported", `Unsupported host method: ${message.method}`);
  }

  const dispose = transport.onMessage((message) => {
    if (message && typeof message === "object" && Object.hasOwn(message, "frame")) {
      try { cancelUnhandledStream(transport, message); }
      catch { transport.close(); }
      return;
    }
    if (client.accept(message)) return;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "$/cancelRequest") {
      cancellation.get(message.params?.cancellationId)?.cancel();
      return;
    }
    if (!Object.hasOwn(message, "id")) return;
    const cancellationId = message.cancellationId;
    const source = new CancellationTokenSource();
    if (cancellationId) cancellation.set(cancellationId, source);
    void handleRequest(message).then(
      (result) => transport.post({ jsonrpc: "2.0", id: message.id, result }),
      (error) => {
        const rpcError = normalizeError(error);
        transport.post(makeRpcFailure(message.id, rpcError.code, rpcError.message, rpcError.data));
      },
    ).finally(() => {
      if (cancellationId) cancellation.delete(cancellationId);
      source.dispose();
    });
  });

  return {
    async dispose() {
      dispose();
      client.close();
      for (const source of cancellation.values()) source.cancel();
      cancellation.clear();
      if (!deactivated) {
        await plugin.deactivate?.();
        context?.subscriptions.dispose();
      }
      transport.close();
    },
  };
}
