"use strict";

class PluginManager {
  constructor(options) {
    this.database = options.database;
    this.packageStore = options.packageStore;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.initialized = false;
    this.initializePromise = null;
    this.mutationTail = Promise.resolve();
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  initialize() {
    this.initializePromise ??= this.#initialize();
    return this.initializePromise;
  }

  async #initialize() {
    await this.packageStore.initialize();
    await this.runtimeSupervisor.startEnabled();
    this.initialized = true;
  }

  async #ready() {
    await this.initialize();
  }

  #mutate(operation) {
    if (this.shuttingDown) return Promise.reject(new Error("Plugin manager is shutting down"));
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list() {
    await this.#ready();
    return this.database.listPlugins();
  }

  install(archivePath, options) {
    return this.#mutate(async () => {
      await this.#ready();
      let stoppedPlugin = null;
      let plugin;
      try {
        plugin = await this.packageStore.install(archivePath, {
          enable: options?.enable === true,
          beforeActivate: async ({ pluginId, previousPlugin }) => {
            if (!previousPlugin?.enabled) return;
            this.database.setEnabled(pluginId, false);
            stoppedPlugin = { pluginId, version: previousPlugin.activeVersion };
            await this.runtimeSupervisor.stop(pluginId);
          },
        });
      } catch (error) {
        if (stoppedPlugin) {
          const current = this.database.getActivePlugin(stoppedPlugin.pluginId);
          if (current?.activeVersion === stoppedPlugin.version) {
            this.database.setEnabled(stoppedPlugin.pluginId, true);
            try {
              await this.runtimeSupervisor.start(stoppedPlugin.pluginId);
            } catch {
              this.database.setEnabled(stoppedPlugin.pluginId, false);
            }
          }
        }
        throw error;
      }
      if (plugin?.enabled) {
        try {
          await this.runtimeSupervisor.start(plugin.id);
        } catch (error) {
          this.database.setEnabled(plugin.id, false);
          if (stoppedPlugin && stoppedPlugin.version !== plugin.activeVersion) {
            try {
              this.database.setActiveVersion(stoppedPlugin.pluginId, stoppedPlugin.version, {
                enabled: true,
                expectedActiveVersion: plugin.activeVersion,
              });
              await this.runtimeSupervisor.start(stoppedPlugin.pluginId);
            } catch {
              const restored = this.database.getActivePlugin(stoppedPlugin.pluginId);
              if (restored?.activeVersion === stoppedPlugin.version && restored.enabled) {
                this.database.setEnabled(stoppedPlugin.pluginId, false);
              }
            }
          }
          throw error;
        }
      }
      return plugin;
    });
  }

  setEnabled(pluginId, enabled) {
    return this.#mutate(async () => {
      await this.#ready();
      if (enabled) {
        const plugin = this.database.getActivePlugin(pluginId);
        if (plugin?.runtime?.quarantinedAt != null) {
          this.database.clearQuarantine(pluginId, plugin.activeVersion);
        }
        this.database.setEnabled(pluginId, true);
        try { await this.runtimeSupervisor.start(pluginId); }
        catch (error) {
          this.database.setEnabled(pluginId, false);
          throw error;
        }
      } else {
        this.database.setEnabled(pluginId, false);
        await this.runtimeSupervisor.stop(pluginId);
      }
      return this.database.getActivePlugin(pluginId);
    });
  }

  restart(pluginId) {
    return this.#mutate(async () => {
      await this.#ready();
      await this.runtimeSupervisor.restart(pluginId);
      return this.database.getActivePlugin(pluginId);
    });
  }

  uninstall(pluginId) {
    return this.#mutate(async () => {
      await this.#ready();
      const plugin = this.database.getActivePlugin(pluginId);
      if (plugin) this.database.setEnabled(pluginId, false);
      await this.runtimeSupervisor.stop(pluginId);
      return this.packageStore.uninstall(pluginId);
    });
  }

  shutdown() {
    this.shutdownPromise ??= this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    this.shuttingDown = true;
    let supervisorError;
    const supervisorShutdown = Promise.resolve()
      .then(() => this.runtimeSupervisor.shutdown())
      .catch((error) => { supervisorError = error; });
    await this.mutationTail;
    if (this.initializePromise) {
      try { await this.initializePromise; } catch {}
    }
    await supervisorShutdown;
    this.database.close();
    if (supervisorError) throw supervisorError;
  }
}

module.exports = { PluginManager };
