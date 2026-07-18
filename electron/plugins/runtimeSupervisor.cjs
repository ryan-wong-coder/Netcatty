"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { BrowserPluginRuntime } = require("./browserPluginRuntime.cjs");
const {
  PLUGIN_API_VERSION,
  PLUGIN_CRASH_QUARANTINE_THRESHOLD,
  PLUGIN_CRASH_WINDOW_MS,
} = require("./constants.cjs");
const { PluginLogger } = require("./pluginLogger.cjs");
const { UtilityPluginRuntime } = require("./utilityPluginRuntime.cjs");

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
    this.runtimeFactories = options.runtimeFactories ?? {
      browser: (runtimeOptions) => new BrowserPluginRuntime(runtimeOptions),
      utility: (runtimeOptions) => new UtilityPluginRuntime(runtimeOptions),
    };
    this.runtimes = new Map();
    this.starting = new Map();
    this.shuttingDown = false;
  }

  async startEnabled() {
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.enabled || plugin.runtime.quarantinedAt != null) continue;
      try { await this.start(plugin.id); } catch {}
    }
  }

  async start(pluginId) {
    if (this.shuttingDown) throw new Error("Plugin runtime supervisor is shutting down");
    if (this.runtimes.has(pluginId)) return this.runtimes.get(pluginId);
    if (this.starting.has(pluginId)) return this.starting.get(pluginId);
    const promise = this.#start(pluginId).finally(() => this.starting.delete(pluginId));
    this.starting.set(pluginId, promise);
    return promise;
  }

  async #start(pluginId) {
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin?.manifest || !plugin.packageRelativePath) throw new Error(`Plugin is not installed: ${pluginId}`);
    if (!plugin.enabled) throw new Error(`Plugin is disabled: ${pluginId}`);
    if (plugin.runtime.quarantinedAt != null) throw new Error(`Plugin is quarantined: ${pluginId}`);
    const pluginCli = await import("@netcatty/plugin-cli");
    const compatibility = pluginCli.checkPluginCompatibility(plugin.manifest, {
      netcattyVersion: this.netcattyVersion,
      apiVersion: this.apiVersion,
      features: this.supportedFeatures,
    });
    if (!compatibility.compatible) throw new Error(`Plugin is incompatible: ${compatibility.errors.join("; ")}`);
    const packageRoot = this.packageStore.resolvePackageRoot(plugin);
    const kind = plugin.manifest.main.browser ? "browser" : "utility";
    const logger = new PluginLogger({ pluginId, logsDirectory: this.paths.logs });
    const handlers = this.#createHandlers(pluginId, logger);
    const onExit = (details) => { void this.#handleExit(pluginId, runtime, details); };
    const onProtocolError = (error) => logger.write("error", "Plugin protocol violation", {
      error: error?.message ?? String(error),
    });
    const runtime = kind === "browser"
      ? this.runtimeFactories.browser({
          electron: this.electron,
          protocol: this.protocol,
          plugin,
          packageRoot,
          preloadPath: path.join(this.runtimeDirectory, "browserPreload.cjs"),
          handlers,
          logger,
          onExit,
          onProtocolError,
        })
      : this.runtimeFactories.utility({
          utilityProcess: this.electron.utilityProcess,
          plugin,
          packageRoot,
          bootstrapPath: path.join(this.runtimeDirectory, "utilityRuntime.mjs"),
          moduleMappings: {
            "@netcatty/plugin-sdk": pathToFileURL(path.join(
              this.appRoot, "node_modules", "@netcatty", "plugin-sdk", "dist", "index.js",
            )).href,
            "@netcatty/plugin-contract": pathToFileURL(path.join(
              this.appRoot, "node_modules", "@netcatty", "plugin-contract", "dist", "index.js",
            )).href,
          },
          handlers,
          logger,
          onExit,
          onProtocolError,
        });
    this.runtimes.set(pluginId, runtime);
    this.database.setRuntimeState(pluginId, "starting", { kind });
    try {
      const initialized = await runtime.start({
        pluginId,
        pluginVersion: plugin.activeVersion,
        netcattyVersion: this.netcattyVersion,
        apiVersion: this.apiVersion,
        supportedFeatures: this.supportedFeatures,
        enabledFeatures: compatibility.enabledFeatures,
      });
      if (
        initialized.pluginId !== pluginId
        || initialized.pluginVersion !== plugin.activeVersion
        || initialized.apiVersion !== this.apiVersion
        || JSON.stringify([...initialized.enabledFeatures].sort())
          !== JSON.stringify([...compatibility.enabledFeatures].sort())
      ) {
        throw new Error("Plugin initialization identity or feature negotiation mismatch");
      }
      this.database.setRuntimeState(pluginId, "running", { kind });
      return runtime;
    } catch (error) {
      const stillOwned = this.runtimes.get(pluginId) === runtime;
      if (stillOwned) this.runtimes.delete(pluginId);
      try { await runtime.stop(); } catch {}
      if (stillOwned) await this.#recordFailure(pluginId, kind, error);
      throw error;
    }
  }

  #createHandlers(pluginId, logger) {
    return {
      "storage.get": async (params) => {
        const { key } = assertStorageParams(params);
        const value = this.database.getValue(pluginId, key);
        return value === undefined ? { found: false } : { found: true, value };
      },
      "storage.set": async (params) => {
        const { key, value } = assertStorageParams(params, { value: true });
        this.database.setValue(pluginId, key, value);
        return null;
      },
      "storage.delete": async (params) => {
        const { key } = assertStorageParams(params);
        this.database.deleteValue(pluginId, key);
        return null;
      },
      "storage.keys": async (params) => {
        if (params && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 0)) {
          throw new TypeError("storage.keys does not accept parameters");
        }
        return { keys: this.database.listKeys(pluginId) };
      },
      "log.write": async (params) => {
        if (!params || typeof params !== "object" || Array.isArray(params)) return;
        await logger.write(params.level, params.message, params.fields);
      },
    };
  }

  async #handleExit(pluginId, runtime, details) {
    if (this.runtimes.get(pluginId) !== runtime) return;
    this.runtimes.delete(pluginId);
    if (details.expected || this.shuttingDown) {
      this.database.setRuntimeState(pluginId, "stopped");
      return;
    }
    const plugin = this.database.getActivePlugin(pluginId);
    await this.#recordFailure(pluginId, plugin?.runtime?.kind, details.error);
  }

  async #recordFailure(pluginId, kind, error) {
    const crash = this.database.recordCrash(
      pluginId,
      PLUGIN_CRASH_WINDOW_MS,
      PLUGIN_CRASH_QUARANTINE_THRESHOLD,
    );
    this.database.setRuntimeState(pluginId, crash.quarantined ? "quarantined" : "error", {
      kind,
      error: error?.message ?? String(error),
      quarantinedAt: crash.quarantinedAt,
    });
  }

  async stop(pluginId) {
    const starting = this.starting.get(pluginId);
    if (starting) {
      try { await starting; } catch {}
    }
    const plugin = this.database.getActivePlugin(pluginId);
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) {
      if (plugin && plugin.runtime.quarantinedAt == null) this.database.setRuntimeState(pluginId, "stopped");
      return;
    }
    this.runtimes.delete(pluginId);
    let stopError;
    try {
      await runtime.stop();
    } catch (error) {
      stopError = error;
    } finally {
      this.database.setRuntimeState(pluginId, "stopped", {
        kind: plugin.runtime?.kind,
        error: stopError?.message,
      });
    }
  }

  async restart(pluginId) {
    await this.stop(pluginId);
    this.database.clearQuarantine(pluginId);
    return this.start(pluginId);
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await Promise.allSettled([...this.runtimes.keys()].map((pluginId) => this.stop(pluginId)));
  }
}

module.exports = { RuntimeSupervisor, assertStorageParams };
