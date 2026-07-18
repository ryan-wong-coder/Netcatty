"use strict";

const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_DEACTIVATION_TIMEOUT_MS,
} = require("./constants.cjs");
const { PluginRpcRouter } = require("./rpcRouter.cjs");
const { isPathInside } = require("./paths.cjs");

async function resolveUtilityEntrypoint(packageRoot, packagePath) {
  const candidate = path.resolve(packageRoot, ...packagePath.split("/"));
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(packageRoot), fs.realpath(candidate)]);
  if (!isPathInside(realRoot, realCandidate)) throw new Error("Plugin utility entrypoint escapes its package");
  const stats = await fs.lstat(realCandidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Plugin utility entrypoint is not a regular file");
  return realCandidate;
}

function waitForUtilityReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Plugin utility process did not become ready"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
    };
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (message?.type !== "netcatty-plugin:ready") return;
      cleanup();
      resolve();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Plugin utility process exited during startup (${code})`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

class UtilityPluginRuntime {
  constructor(options) {
    this.utilityProcess = options.utilityProcess;
    this.plugin = options.plugin;
    this.packageRoot = options.packageRoot;
    this.bootstrapPath = options.bootstrapPath;
    this.moduleMappings = options.moduleMappings;
    this.requestHandlers = options.requestHandlers ?? options.handlers;
    this.notificationHandlers = options.notificationHandlers ?? options.handlers;
    this.onIncomingStream = options.onIncomingStream;
    this.onProgress = options.onProgress;
    this.logger = options.logger;
    this.onExit = options.onExit ?? (() => {});
    this.onProtocolError = options.onProtocolError ?? (() => {});
    this.child = null;
    this.router = null;
    this.stopping = false;
  }

  #assertStarting(signal) {
    signal?.throwIfAborted();
    if (this.stopping) throw new Error("Plugin utility runtime startup was stopped");
  }

  async start(runtimeConfig, options = {}) {
    const { signal } = options;
    this.#assertStarting(signal);
    if (!this.utilityProcess?.fork) throw new Error("Electron utility plugin runtime is unavailable");
    const entryUrl = pathToFileURL(await resolveUtilityEntrypoint(
      this.packageRoot,
      this.plugin.manifest.main.node,
    )).href;
    this.#assertStarting(signal);
    const config = { ...runtimeConfig, entryUrl, moduleMappings: this.moduleMappings };
    this.child = this.utilityProcess.fork(this.bootstrapPath, [], {
      cwd: this.packageRoot,
      env: {
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: `Netcatty Plugin: ${this.plugin.id}`,
      allowLoadingUnsignedLibraries: false,
      disclaim: process.platform === "darwin",
    });
    this.child.stdout?.on("data", (chunk) => this.logger.write("info", "utility stdout", { output: String(chunk).slice(0, 8_192) }));
    this.child.stderr?.on("data", (chunk) => this.logger.write("warn", "utility stderr", { output: String(chunk).slice(0, 8_192) }));
    this.router = new PluginRpcRouter({
      pluginId: this.plugin.id,
      send: (message) => this.child?.postMessage(message),
      requestHandlers: this.requestHandlers,
      notificationHandlers: this.notificationHandlers,
      onIncomingStream: this.onIncomingStream,
      onProgress: this.onProgress,
      onProtocolError: (error) => {
        this.onProtocolError(error);
        this.#handleExit(error);
      },
    });
    this.child.on("message", (event) => {
      const message = event?.data ?? event;
      if (message?.type === "netcatty-plugin:ready") return;
      this.router?.accept(message);
    });
    this.child.on("error", (_type, location) => this.#handleExit(new Error(`Plugin utility fatal error at ${location}`)));
    this.child.on("exit", (code) => this.#handleExit(new Error(`Plugin utility exited (${code})`)));
    const ready = waitForUtilityReady(this.child, PLUGIN_ACTIVATION_TIMEOUT_MS);
    this.child.postMessage({ type: "netcatty-plugin:bootstrap", config });
    await ready;
    this.#assertStarting(signal);
    const initialized = await this.router.request("plugin.initialize", {
      netcattyVersion: config.netcattyVersion,
      apiVersion: config.apiVersion,
      supportedFeatures: config.supportedFeatures,
    }, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    await this.router.request("plugin.activate", {}, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    return initialized;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.router?.request("plugin.deactivate", {}, { timeoutMs: PLUGIN_DEACTIVATION_TIMEOUT_MS });
    } finally {
      const router = this.router;
      this.router = null;
      router?.close();
      this.child?.kill();
    }
  }

  request(method, params, options) {
    if (!this.router) return Promise.reject(new Error("Plugin utility runtime is not connected"));
    return this.router.request(method, params, options);
  }

  notify(method, params) {
    if (!this.router) throw new Error("Plugin utility runtime is not connected");
    this.router.notify(method, params);
  }

  openStream(streamId, windowBytes) {
    if (!this.router) return Promise.reject(new Error("Plugin utility runtime is not connected"));
    return this.router.streams.openOutgoing(streamId, windowBytes);
  }

  #handleExit(error) {
    if (!this.router) return;
    const router = this.router;
    this.router = null;
    router.close(error);
    this.child?.kill();
    const expected = this.stopping;
    this.onExit({ expected, error });
  }
}

module.exports = { UtilityPluginRuntime, resolveUtilityEntrypoint, waitForUtilityReady };
