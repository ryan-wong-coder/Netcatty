"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { BrowserPluginRuntime } = require("./browserPluginRuntime.cjs");
const {
  PLUGIN_API_VERSION,
  PLUGIN_CRASH_QUARANTINE_THRESHOLD,
  PLUGIN_CRASH_WINDOW_MS,
} = require("./constants.cjs");
const { PluginLogger } = require("./pluginLogger.cjs");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const {
  assertHostMethod,
  createDefaultPluginHostRpcRegistry,
} = require("./hostRpcRegistry.cjs");
const {
  PLUGIN_CONTAINMENT_ERROR_CODE,
  UtilityPluginRuntime,
} = require("./utilityPluginRuntime.cjs");

function assertStorageParams(params, options = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("Plugin storage parameters must be an object");
  }
  if (typeof params.key !== "string" || params.key.length < 1 || params.key.length > 256 || params.key.includes("\0")) {
    throw new TypeError("Plugin storage key is invalid");
  }
  if (options.value && !Object.hasOwn(params, "value")) throw new TypeError("Plugin storage value is required");
  return params;
}

function freezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) freezeJson(item);
  return Object.freeze(value);
}

class RuntimeSupervisor {
  constructor(options) {
    this.electron = options.electron;
    this.database = options.database;
    this.packageStore = options.packageStore;
    this.protocol = options.protocol;
    this.paths = options.paths;
    this.netcattyVersion = options.netcattyVersion;
    this.apiVersion = options.apiVersion ?? PLUGIN_API_VERSION;
    this.supportedFeatures = [...(options.supportedFeatures ?? [])];
    this.runtimeDirectory = options.runtimeDirectory;
    this.appRoot = options.appRoot;
    this.rpcRegistry = options.rpcRegistry ?? createDefaultPluginHostRpcRegistry({
      assertStorageParams,
      database: this.database,
    });
    this.runtimeMessageGuard = options.runtimeMessageGuard ?? null;
    if (this.runtimeMessageGuard != null && typeof this.runtimeMessageGuard !== "function") {
      throw new TypeError("Plugin runtime message guard must be a function");
    }
    this.resolveRuntimeKind = options.resolveRuntimeKind ?? (({ plugin }) => (
      plugin.manifest.main.browser ? "browser" : "utility"
    ));
    this.utilityModuleMappings = options.utilityModuleMappings ?? {
      "@netcatty/plugin-sdk": pathToFileURL(path.join(
        this.appRoot, "node_modules", "@netcatty", "plugin-sdk", "dist", "index.js",
      )).href,
      "@netcatty/plugin-contract": pathToFileURL(path.join(
        this.appRoot, "node_modules", "@netcatty", "plugin-contract", "dist", "index.js",
      )).href,
    };
    this.runtimeFactories = options.runtimeFactories ?? {
      browser: (runtimeOptions) => new BrowserPluginRuntime(runtimeOptions),
      utility: (runtimeOptions) => new UtilityPluginRuntime(runtimeOptions),
    };
    this.runtimes = new Map();
    this.runtimeIdentities = new Map();
    this.starting = new Map();
    this.startControllers = new Map();
    this.stopping = new Map();
    this.runtimeListeners = new Set();
    this.progressListeners = new Set();
    this.uncontainedPlugins = new Set();
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  onDidChangeRuntime(listener) {
    if (typeof listener !== "function") throw new TypeError("Plugin runtime listener must be a function");
    this.runtimeListeners.add(listener);
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.runtimeListeners.delete(listener);
      },
    });
  }

  onDidReportProgress(listener) {
    if (typeof listener !== "function") throw new TypeError("Plugin progress listener must be a function");
    this.progressListeners.add(listener);
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.progressListeners.delete(listener);
      },
    });
  }

  #emitProgress(identity, params) {
    identity.assertCurrent();
    const event = Object.freeze({
      type: "runtime-progress",
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
      token: params.token,
      value: freezeJson(structuredClone(params.value)),
    });
    for (const listener of [...this.progressListeners]) {
      try { listener(event); } catch {}
    }
  }

  #emitRuntimeState(identity, status, details = {}) {
    const event = Object.freeze({
      type: "runtime-state",
      pluginId: identity?.pluginId ?? details.pluginId,
      pluginVersion: identity?.pluginVersion ?? details.pluginVersion ?? null,
      runtimeId: identity?.runtimeId ?? null,
      runtimeKind: identity?.runtimeKind ?? details.kind ?? null,
      status,
      error: details.error == null ? null : String(details.error),
      quarantinedAt: details.quarantinedAt ?? null,
    });
    for (const listener of [...this.runtimeListeners]) {
      try { listener(event); } catch {}
    }
  }

  #isInstalledVersion(identity) {
    return Boolean(identity && this.database.getVersion(identity.pluginId, identity.pluginVersion));
  }

  #setRuntimeState(identity, status, details = {}) {
    const pluginId = identity?.pluginId ?? details.pluginId;
    if (!identity || this.#isInstalledVersion(identity)) {
      this.database.setRuntimeState(pluginId, status, {
        pluginVersion: identity?.pluginVersion ?? details.pluginVersion,
        kind: identity?.runtimeKind ?? details.kind,
        error: details.error,
        quarantinedAt: details.quarantinedAt,
      });
    }
    this.#emitRuntimeState(identity, status, details);
  }

  async startEnabled() {
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled || plugin.runtime.quarantinedAt != null) continue;
      try { await this.start(plugin.id); } catch {}
    }
  }

  async start(pluginId) {
    if (this.shuttingDown) throw new Error("Plugin runtime supervisor is shutting down");
    if (this.uncontainedPlugins.has(pluginId)) {
      throw this.#restoreContainmentBlock(pluginId);
    }
    const stopping = this.stopping.get(pluginId);
    if (stopping) await stopping;
    if (this.shuttingDown) throw new Error("Plugin runtime supervisor is shutting down");
    if (this.starting.has(pluginId)) return this.starting.get(pluginId);
    if (this.runtimes.has(pluginId)) {
      await this.#getRunningRuntime(pluginId);
      return this.getRuntimeIdentity(pluginId);
    }
    const controller = new AbortController();
    const promise = this.#start(pluginId, controller.signal).finally(() => {
      this.starting.delete(pluginId);
      this.startControllers.delete(pluginId);
    });
    this.starting.set(pluginId, promise);
    this.startControllers.set(pluginId, controller);
    return promise;
  }

  async #start(pluginId, signal) {
    signal.throwIfAborted();
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin?.manifest || !plugin.packageRelativePath) throw new Error(`Plugin is not installed: ${pluginId}`);
    if (!plugin.enabled) throw new Error(`Plugin is disabled: ${pluginId}`);
    if (plugin.runtime.quarantinedAt != null) throw new Error(`Plugin is quarantined: ${pluginId}`);
    const pluginCli = await import("@netcatty/plugin-cli");
    signal.throwIfAborted();
    const compatibility = pluginCli.checkPluginCompatibility(plugin.manifest, {
      netcattyVersion: this.netcattyVersion,
      apiVersion: this.apiVersion,
      features: this.supportedFeatures,
    });
    if (!compatibility.compatible) throw new Error(`Plugin is incompatible: ${compatibility.errors.join("; ")}`);
    const packageRoot = await this.packageStore.preparePackageRoot(plugin);
    signal.throwIfAborted();
    const availableKinds = Object.freeze([
      ...(plugin.manifest.main.browser ? ["browser"] : []),
      ...(plugin.manifest.main.node ? ["utility"] : []),
    ]);
    const placementPlugin = freezeJson(structuredClone(plugin));
    const kind = await raceWithAbort(Promise.resolve(this.resolveRuntimeKind(Object.freeze({
      plugin: placementPlugin,
      availableKinds,
      signal,
    }))), signal);
    signal.throwIfAborted();
    if ((kind !== "browser" && kind !== "utility") || !availableKinds.includes(kind)) {
      throw new Error(`Plugin runtime selection is unavailable: ${String(kind)}`);
    }
    const currentPlugin = this.database.getActivePlugin(pluginId);
    if (
      !currentPlugin?.enabled
      || currentPlugin.activeVersion !== plugin.activeVersion
      || currentPlugin.runtime.quarantinedAt != null
    ) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin changed while runtime placement was resolved");
    }
    const logger = new PluginLogger({ pluginId, logsDirectory: this.paths.logs });
    let runtime;
    const identity = Object.freeze({
      pluginId,
      pluginVersion: plugin.activeVersion,
      runtimeId: randomUUID(),
      runtimeKind: kind,
      manifest: freezeJson(structuredClone(plugin.manifest)),
      packageRoot,
      logger,
      assertCurrent: () => {
        const active = this.database.getActivePlugin(pluginId);
        if (
          this.runtimes.get(pluginId) !== runtime
          || !active?.enabled
          || active.activeVersion !== plugin.activeVersion
          || (active.runtime.status !== "starting" && active.runtime.status !== "running")
        ) {
          throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin runtime identity is stale or inactive");
        }
      },
    });
    const routes = this.rpcRegistry.createRoutes(identity);
    const onExit = (details) => { void this.#handleExit(pluginId, runtime, identity, details); };
    const onProtocolError = (error) => logger.write("error", "Plugin protocol violation", {
      error: error?.message ?? String(error),
    });
    runtime = kind === "browser"
      ? this.runtimeFactories.browser({
          electron: this.electron,
          protocol: this.protocol,
          plugin,
          packageRoot,
          preloadPath: path.join(this.runtimeDirectory, "browserPreload.cjs"),
          requestHandlers: routes.requestHandlers,
          notificationHandlers: routes.notificationHandlers,
          onBeforeMessage: this.runtimeMessageGuard
            ? (message) => this.runtimeMessageGuard(identity, message)
            : undefined,
          onIncomingStream: routes.onIncomingStream,
          onProgress: (params) => this.#emitProgress(identity, params),
          logger,
          onExit,
          onProtocolError,
        })
      : this.runtimeFactories.utility({
          utilityProcess: this.electron.utilityProcess,
          plugin,
          packageRoot,
          bootstrapPath: path.join(this.runtimeDirectory, "utilityRuntime.mjs"),
          moduleMappings: this.utilityModuleMappings,
          requestHandlers: routes.requestHandlers,
          notificationHandlers: routes.notificationHandlers,
          onBeforeMessage: this.runtimeMessageGuard
            ? (message) => this.runtimeMessageGuard(identity, message)
            : undefined,
          onIncomingStream: routes.onIncomingStream,
          onProgress: (params) => this.#emitProgress(identity, params),
          logger,
          onExit,
          onProtocolError,
        });
    this.runtimes.set(pluginId, runtime);
    this.runtimeIdentities.set(pluginId, identity);
    this.#setRuntimeState(identity, "starting");
    try {
      const initialized = await raceWithAbort(Promise.resolve(runtime.start({
        pluginId,
        pluginVersion: plugin.activeVersion,
        netcattyVersion: this.netcattyVersion,
        apiVersion: this.apiVersion,
        supportedFeatures: this.supportedFeatures,
        enabledFeatures: compatibility.enabledFeatures,
      }, { signal })), signal);
      if (
        initialized.pluginId !== pluginId
        || initialized.pluginVersion !== plugin.activeVersion
        || initialized.apiVersion !== this.apiVersion
        || JSON.stringify([...initialized.enabledFeatures].sort())
          !== JSON.stringify([...compatibility.enabledFeatures].sort())
      ) {
        throw new Error("Plugin initialization identity or feature negotiation mismatch");
      }
      identity.assertCurrent();
      this.#setRuntimeState(identity, "running");
      return this.getRuntimeIdentity(pluginId);
    } catch (error) {
      const stillOwned = this.runtimes.get(pluginId) === runtime;
      let cleanupError;
      if (stillOwned) {
        this.runtimes.delete(pluginId);
        this.runtimeIdentities.delete(pluginId);
        try { await runtime.stop(); } catch (stopError) { cleanupError = stopError; }
      }
      if (stillOwned && cleanupError?.code === PLUGIN_CONTAINMENT_ERROR_CODE) {
        this.#recordContainmentFailure(identity, cleanupError);
        throw cleanupError;
      }
      if (stillOwned) await this.#recordFailure(identity, error);
      throw error;
    }
  }

  #restoreContainmentBlock(pluginId) {
    const error = new PluginRpcError(
      RPC_ERRORS.unavailable,
      `Plugin runtime containment failed; restart Netcatty before starting it again: ${pluginId}`,
    );
    const active = this.database.getActivePlugin(pluginId);
    if (active?.activeVersion) {
      if (active.enabled) this.database.setEnabled(pluginId, false);
      this.#setRuntimeState(null, "quarantined", {
        pluginId,
        pluginVersion: active.activeVersion,
        kind: active.runtime.kind,
        error: active.runtime.lastError ?? error.message,
        quarantinedAt: active.runtime.quarantinedAt ?? Date.now(),
      });
    }
    return error;
  }

  #recordContainmentFailure(identity, error) {
    this.uncontainedPlugins.add(identity.pluginId);
    const active = this.database.getActivePlugin(identity.pluginId);
    if (active?.activeVersion === identity.pluginVersion && active.enabled) {
      this.database.setEnabled(identity.pluginId, false);
    }
    this.#setRuntimeState(identity, "quarantined", {
      error: error?.message ?? String(error),
      quarantinedAt: Date.now(),
    });
  }

  async #handleExit(pluginId, runtime, identity, details) {
    if (this.runtimes.get(pluginId) !== runtime) return;
    this.runtimes.delete(pluginId);
    this.runtimeIdentities.delete(pluginId);
    if (details.containmentFailed) {
      this.#recordContainmentFailure(identity, details.error);
      return;
    }
    if (details.expected || this.shuttingDown) {
      this.#setRuntimeState(identity, "stopped");
      return;
    }
    await this.#recordFailure(identity, details.error);
  }

  async #recordFailure(identity, error) {
    const pluginId = identity.pluginId;
    if (!this.#isInstalledVersion(identity)) {
      this.#emitRuntimeState(identity, "error", {
        error: error?.message ?? String(error),
      });
      return;
    }
    const crash = this.database.recordCrash(
      pluginId,
      identity.pluginVersion,
      PLUGIN_CRASH_WINDOW_MS,
      PLUGIN_CRASH_QUARANTINE_THRESHOLD,
    );
    this.#setRuntimeState(identity, crash.quarantined ? "quarantined" : "error", {
      error: error?.message ?? String(error),
      quarantinedAt: crash.quarantinedAt,
    });
  }

  stop(pluginId) {
    if (this.stopping.has(pluginId)) return this.stopping.get(pluginId);
    const promise = this.#stop(pluginId).finally(() => this.stopping.delete(pluginId));
    this.stopping.set(pluginId, promise);
    return promise;
  }

  async #stop(pluginId) {
    const starting = this.starting.get(pluginId);
    this.startControllers.get(pluginId)?.abort(new PluginRpcError(
      RPC_ERRORS.cancelled,
      `Plugin startup was stopped: ${pluginId}`,
    ));
    const plugin = this.database.getActivePlugin(pluginId);
    const runtime = this.runtimes.get(pluginId);
    const identity = this.runtimeIdentities.get(pluginId);
    if (!runtime) {
      if (starting) {
        try { await starting; } catch {}
      }
      if (plugin && plugin.runtime.quarantinedAt == null && plugin.runtime.status !== "stopped") {
        this.#setRuntimeState(identity, "stopped", {
          pluginId,
          pluginVersion: plugin.activeVersion,
          kind: plugin.runtime.kind,
        });
      }
      return;
    }
    this.runtimes.delete(pluginId);
    this.runtimeIdentities.delete(pluginId);
    let stopError;
    try {
      await runtime.stop();
    } catch (error) {
      stopError = error;
    } finally {
      if (stopError?.code === PLUGIN_CONTAINMENT_ERROR_CODE) {
        this.#recordContainmentFailure(identity, stopError);
      } else {
        this.#setRuntimeState(identity, "stopped", {
          kind: plugin?.runtime?.kind,
          error: stopError?.message,
        });
      }
    }
    if (stopError?.code === PLUGIN_CONTAINMENT_ERROR_CODE) throw stopError;
  }

  async restart(pluginId) {
    await this.stop(pluginId);
    this.database.clearQuarantine(pluginId);
    return this.start(pluginId);
  }

  getRuntimeIdentity(pluginId) {
    const identity = this.runtimeIdentities.get(pluginId);
    if (!identity) return null;
    return Object.freeze({
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
    });
  }

  async #getRunningRuntime(pluginId) {
    const starting = this.starting.get(pluginId);
    if (starting) await starting;
    const runtime = this.runtimes.get(pluginId);
    const identity = this.runtimeIdentities.get(pluginId);
    if (!runtime || !identity) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime is unavailable: ${pluginId}`);
    }
    const active = this.database.getActivePlugin(pluginId);
    if (
      !active?.enabled
      || active.activeVersion !== identity.pluginVersion
      || active.runtime.status !== "running"
    ) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime identity is stale or inactive: ${pluginId}`);
    }
    return { identity, runtime };
  }

  async request(pluginId, method, params, options) {
    assertHostMethod(method);
    const { identity, runtime } = await this.#getRunningRuntime(pluginId);
    if (typeof runtime.request !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime cannot receive requests: ${pluginId}`);
    }
    const result = await runtime.request(method, params, options);
    const current = await this.#getRunningRuntime(pluginId);
    if (current.runtime !== runtime || current.identity.runtimeId !== identity.runtimeId) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime changed while handling request: ${pluginId}`);
    }
    return result;
  }

  async notify(pluginId, method, params) {
    assertHostMethod(method);
    const { identity, runtime } = await this.#getRunningRuntime(pluginId);
    if (typeof runtime.notify !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime cannot receive notifications: ${pluginId}`);
    }
    runtime.notify(method, params);
    const current = await this.#getRunningRuntime(pluginId);
    if (current.runtime !== runtime || current.identity.runtimeId !== identity.runtimeId) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime changed while sending notification: ${pluginId}`);
    }
  }

  async openStream(pluginId, streamId, windowBytes) {
    const { identity, runtime } = await this.#getRunningRuntime(pluginId);
    if (typeof runtime.openStream !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime cannot receive streams: ${pluginId}`);
    }
    const stream = await runtime.openStream(streamId, windowBytes);
    try {
      const current = await this.#getRunningRuntime(pluginId);
      if (current.runtime !== runtime || current.identity.runtimeId !== identity.runtimeId) {
        throw new PluginRpcError(RPC_ERRORS.unavailable, `Plugin runtime changed while opening stream: ${pluginId}`);
      }
      return stream;
    } catch (error) {
      try { stream?.cancel?.(); } catch {}
      throw error;
    }
  }

  shutdown() {
    this.shutdownPromise ??= this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    this.shuttingDown = true;
    for (const [pluginId, controller] of this.startControllers) {
      controller.abort(new PluginRpcError(
        RPC_ERRORS.unavailable,
        `Plugin runtime supervisor is shutting down: ${pluginId}`,
      ));
    }
    await Promise.allSettled([...this.runtimes.keys()].map((pluginId) => this.stop(pluginId)));
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.stopping.values()]);
    this.runtimeListeners.clear();
    this.progressListeners.clear();
  }
}

module.exports = { RuntimeSupervisor, assertStorageParams, freezeJson };
