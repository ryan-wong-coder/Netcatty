"use strict";

const path = require("node:path");

const { PLUGIN_API_VERSION } = require("./constants.cjs");
const { PluginDatabase } = require("./database.cjs");
const { createDefaultPluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const {
  createDefaultPluginModuleResources,
  createUtilityModuleMappings,
  normalizePluginModuleResources,
} = require("./moduleResources.cjs");
const { PackageStore } = require("./packageStore.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { PluginManager } = require("./pluginManager.cjs");
const { PluginProtocol } = require("./pluginProtocol.cjs");
const { RuntimeSupervisor, assertStorageParams } = require("./runtimeSupervisor.cjs");

function createPluginHostService(options) {
  const paths = createPluginPaths(options.app.getPath("userData"));
  const appRoot = options.appRoot ?? options.app.getAppPath();
  const runtimeDirectory = options.runtimeDirectory ?? path.join(__dirname, "runtime");
  const database = new PluginDatabase(paths.database);
  try {
    const packageStore = new PackageStore({
      paths,
      database,
      netcattyVersion: options.app.getVersion(),
      apiVersion: PLUGIN_API_VERSION,
      supportedFeatures: options.supportedFeatures ?? [],
    });
    const moduleResources = options.moduleResources
      ? normalizePluginModuleResources(options.moduleResources)
      : createDefaultPluginModuleResources(appRoot, options.additionalModuleResources ?? []);
    const protocol = new PluginProtocol({
      runtimeDirectory,
      moduleResources,
    });
    const rpcRegistry = options.rpcRegistry ?? createDefaultPluginHostRpcRegistry({
      assertStorageParams,
      database,
    });
    const configuredRegistry = options.configureRpcRegistry?.(rpcRegistry);
    if (configuredRegistry && typeof configuredRegistry.then === "function") {
      throw new TypeError("Plugin host RPC registry configuration must be synchronous");
    }
    const runtimeSupervisor = new RuntimeSupervisor({
      electron: options.electron,
      database,
      packageStore,
      protocol,
      paths,
      netcattyVersion: options.app.getVersion(),
      apiVersion: PLUGIN_API_VERSION,
      supportedFeatures: options.supportedFeatures ?? [],
      runtimeDirectory,
      appRoot,
      rpcRegistry,
      resolveRuntimeKind: options.resolveRuntimeKind,
      runtimeMessageGuard: options.runtimeMessageGuard,
      utilityModuleMappings: options.utilityModuleMappings ?? createUtilityModuleMappings(moduleResources),
    });
    const manager = new PluginManager({ database, packageStore, runtimeSupervisor });
    return {
      database,
      manager,
      moduleResources,
      packageStore,
      paths,
      protocol,
      rpcRegistry,
      runtimeSupervisor,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = { createPluginHostService };
