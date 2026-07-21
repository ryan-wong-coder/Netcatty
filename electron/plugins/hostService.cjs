"use strict";

const path = require("node:path");

const { PLUGIN_API_VERSION } = require("./constants.cjs");
const { PluginDatabase } = require("./database.cjs");
const { PluginCompanionSupervisor } = require("./companionSupervisor.cjs");
const { PluginCredentialBroker, assertLeaseParams } = require("./credentialBroker.cjs");
const { PluginContributionService } = require("./contributionService.cjs");
const { PluginContributionIconService } = require("./contributionIconService.cjs");
const { PluginFilesystemBroker } = require("./filesystemBroker.cjs");
const { createDefaultPluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const {
  createDefaultPluginModuleResources,
  createUtilityModuleMappings,
  normalizePluginModuleResources,
} = require("./moduleResources.cjs");
const { PackageStore } = require("./packageStore.cjs");
const { createPluginPaths } = require("./paths.cjs");
const { PluginManager } = require("./pluginManager.cjs");
const { PluginNetworkBroker } = require("./networkBroker.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const { PluginProtocol } = require("./pluginProtocol.cjs");
const { PluginViewHost } = require("./pluginViewHost.cjs");
const {
  RuntimeSupervisor,
  assertStorageParams,
  resolveDefaultRuntimeKind,
} = require("./runtimeSupervisor.cjs");
const { PluginQuotaManager } = require("./quotaManager.cjs");
const { registerSecurePluginCapabilities } = require("./secureCapabilities.cjs");
const { PluginSecretStore } = require("./secretStore.cjs");
const { SecretLeaseStore } = require("./secretLease.cjs");
const { PluginTerminalProviderService } = require("./terminalProviderService.cjs");
const { PluginTerminalDataPipelineService } = require("./terminalDataPipelineService.cjs");

function getElectronProcessMetrics(app, pid) {
  const metric = app.getAppMetrics?.().find((candidate) => candidate.pid === pid);
  if (!metric) return null;
  return {
    cpuPercent: Number(metric.cpu?.percentCPUUsage ?? 0),
    memoryBytes: Number(metric.memory?.workingSetSize ?? 0) * 1024,
  };
}

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
    const contributionIconService = new PluginContributionIconService({
      database,
      packageStore,
      BrowserWindow: options.electron.BrowserWindow,
      rasterizeIcon: options.rasterizeContributionIcon,
    });
    const moduleResources = options.moduleResources
      ? normalizePluginModuleResources(options.moduleResources)
      : createDefaultPluginModuleResources(appRoot, options.additionalModuleResources ?? []);
    const protocol = new PluginProtocol({
      runtimeDirectory,
      moduleResources,
    });
    const permissionEngine = new PluginPermissionEngine({
      database,
      requestDecision: options.requestPermissionDecision,
    });
    const quotaManager = new PluginQuotaManager({
      getProcessMetrics: options.getProcessMetrics
        ?? ((pid) => getElectronProcessMetrics(options.app, pid)),
      quotas: options.quotas,
    });
    const secretStore = new PluginSecretStore({
      database,
      safeStorage: options.safeStorage ?? options.electron.safeStorage,
    });
    const leaseStore = new SecretLeaseStore({ secretStore });
    const credentialBroker = new PluginCredentialBroker({
      secretStore,
      leaseStore,
      credentialResolver: options.credentialResolver,
    });
    const filesystemBroker = new PluginFilesystemBroker({
      quotaManager,
      openDirectoryHandle: options.openPluginDirectoryHandle,
    });
    const networkBroker = new PluginNetworkBroker({
      fetch: options.fetch ?? (options.electron.net?.fetch
        ? (...args) => options.electron.net.fetch(...args)
        : undefined),
      permissionEngine,
      quotaManager,
    });
    let runtimeSupervisor;
    const companionSupervisor = new PluginCompanionSupervisor({
      paths,
      quotaManager,
      spawn: options.spawnCompanion,
      onContainmentFailure: (identity, error) => (
        runtimeSupervisor?.enforcePolicyViolation(identity, error)
      ),
    });
    const rpcRegistry = options.rpcRegistry ?? createDefaultPluginHostRpcRegistry({
      assertStorageParams,
      database,
    });
    const runtimeAccess = Object.freeze({
      start: (...args) => runtimeSupervisor.start(...args),
      request: (...args) => runtimeSupervisor.request(...args),
      notify: (...args) => runtimeSupervisor.notify(...args),
      getRuntimeIdentity: (...args) => runtimeSupervisor.getRuntimeIdentity(...args),
    });
    const contributionService = new PluginContributionService({
      database,
      runtimeSupervisor: runtimeAccess,
      secretStore,
      getLocale: options.getLocale,
    });
    contributionService.registerRpcCapabilities(rpcRegistry);
    registerSecurePluginCapabilities(rpcRegistry, {
      assertLeaseParams,
      companionSupervisor,
      credentialBroker,
      filesystemBroker,
      networkBroker,
      permissionEngine,
      quotaManager,
      secretStore,
    });
    const configuredRegistry = options.configureRpcRegistry?.(rpcRegistry);
    if (configuredRegistry && typeof configuredRegistry.then === "function") {
      throw new TypeError("Plugin host RPC registry configuration must be synchronous");
    }
    const requestedRuntimeResolver = options.resolveRuntimeKind ?? resolveDefaultRuntimeKind;
    const resolveRuntimeKind = async (context) => {
      const kind = await requestedRuntimeResolver(context);
      if (
        (kind !== "browser" && kind !== "utility")
        || !context.availableKinds.includes(kind)
      ) throw new Error(`Plugin runtime selection is unavailable: ${String(kind)}`);
      await permissionEngine.authorizeRequired(context.plugin, {
        securityPrincipal: context.securityPrincipal,
        signal: context.signal,
        skipPermissions: ["runtime.advanced"],
      });
      if (kind === "utility") {
        await permissionEngine.authorize({
          pluginId: context.plugin.id,
          pluginVersion: context.plugin.activeVersion,
          runtimeId: null,
          manifest: context.plugin.manifest,
          securityPrincipal: context.securityPrincipal,
          signal: context.signal,
        }, {
          permission: "runtime.advanced",
          resources: ["*"],
          reason: "Start an advanced runtime with full Node, filesystem, and network authority",
          operationId: `runtime.advanced:${context.plugin.activeVersion}`,
        });
      }
      return kind;
    };
    const runtimeMessageGuard = (identity, message) => {
      quotaManager.guardMessage(identity, message);
      return options.runtimeMessageGuard?.(identity, message);
    };
    runtimeSupervisor = new RuntimeSupervisor({
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
      resolveRuntimeKind,
      resolveSecurityPrincipal: options.resolveSecurityPrincipal,
      runtimeMessageGuard,
      getInitialEnvironment: () => contributionService.getEnvironment(),
      runtimeResourceMonitor: quotaManager,
      runtimeCleanup: async (identity) => {
        leaseStore.revokeRuntime(identity.runtimeId);
        await companionSupervisor.releaseRuntime(identity.runtimeId);
      },
      utilityModuleMappings: options.utilityModuleMappings ?? createUtilityModuleMappings(moduleResources),
    });
    runtimeSupervisor.onDidChangeRuntime((event) => contributionService.onRuntimeStateChanged(event));
    const terminalProviderService = new PluginTerminalProviderService({
      contributionService,
      permissionEngine,
      runtimeSupervisor,
    });
    const terminalDataPipelineService = options.electron.MessageChannelMain
      ? new PluginTerminalDataPipelineService({
          contributionService,
          permissionEngine,
          runtimeSupervisor,
          MessageChannelMain: options.electron.MessageChannelMain,
          requestSelection: options.requestTerminalInterceptorSelection,
          showWarning: options.showTerminalInterceptorWarning,
        })
      : null;
    quotaManager.setViolationHandler((identity, error) => (
      runtimeSupervisor.enforcePolicyViolation(identity, error)
    ));
    const viewHost = options.electron.WebContentsView && options.electron.ipcMain
      ? new PluginViewHost({
          electron: options.electron,
          protocol,
          packageStore,
          database,
          contributionService,
        })
      : null;
    const manager = new PluginManager({
      database,
      packageStore,
      runtimeSupervisor,
      contributionService,
      beforeClose: async () => {
        terminalDataPipelineService?.shutdown();
        await viewHost?.shutdown();
        await companionSupervisor.shutdown();
        leaseStore.shutdown();
        permissionEngine.shutdown();
        quotaManager.shutdown();
      },
    });
    return {
      companionSupervisor,
      contributionIconService,
      contributionService,
      credentialBroker,
      database,
      filesystemBroker,
      leaseStore,
      manager,
      moduleResources,
      packageStore,
      paths,
      protocol,
      networkBroker,
      permissionEngine,
      quotaManager,
      rpcRegistry,
      runtimeSupervisor,
      secretStore,
      terminalProviderService,
      terminalDataPipelineService,
      viewHost,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = { createPluginHostService, getElectronProcessMetrics };
