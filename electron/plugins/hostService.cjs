"use strict";

const path = require("node:path");

const { PLUGIN_API_VERSION } = require("./constants.cjs");
const { PluginDatabase } = require("./database.cjs");
const { PackageStore } = require("./packageStore.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { PluginManager } = require("./pluginManager.cjs");
const { PluginProtocol } = require("./pluginProtocol.cjs");
const { RuntimeSupervisor } = require("./runtimeSupervisor.cjs");

function createPluginHostService(options) {
  const paths = createPluginPaths(options.app.getPath("userData"));
  const appRoot = options.appRoot ?? options.app.getAppPath();
  const runtimeDirectory = options.runtimeDirectory ?? path.join(__dirname, "runtime");
  const database = new PluginDatabase(paths.database);
  const packageStore = new PackageStore({
    paths,
    database,
    netcattyVersion: options.app.getVersion(),
    apiVersion: PLUGIN_API_VERSION,
    supportedFeatures: options.supportedFeatures ?? [],
  });
  const protocol = new PluginProtocol({
    runtimeDirectory,
    sdkDirectory: path.join(appRoot, "node_modules", "@netcatty", "plugin-sdk", "dist"),
    contractDirectory: path.join(appRoot, "node_modules", "@netcatty", "plugin-contract", "dist"),
  });
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
  });
  const manager = new PluginManager({ database, packageStore, runtimeSupervisor });
  return { database, manager, packageStore, paths, protocol, runtimeSupervisor };
}

module.exports = { createPluginHostService };
