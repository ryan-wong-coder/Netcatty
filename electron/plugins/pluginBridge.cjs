"use strict";

const { isPluginDevelopmentEnabled } = require("./constants.cjs");

const CHANNELS = Object.freeze({
  status: "netcatty:plugins:status",
  list: "netcatty:plugins:list",
  install: "netcatty:plugins:install",
  setEnabled: "netcatty:plugins:set-enabled",
  restart: "netcatty:plugins:restart",
  uninstall: "netcatty:plugins:uninstall",
});

function createTrustedPluginBridgeSender(options = {}) {
  const devServerOrigin = options.devServerUrl ? new URL(options.devServerUrl).origin : null;
  return (event) => {
    const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
    try {
      const url = new URL(senderUrl);
      if (url.protocol === "app:" && url.hostname === "netcatty") return true;
      return Boolean(devServerOrigin && url.origin === devServerOrigin);
    } catch {
      return false;
    }
  };
}

function registerPluginBridge(ipcMain, options) {
  const manager = options.manager;
  const env = options.env ?? process.env;
  const isTrustedSender = options.isTrustedSender;
  const available = isPluginDevelopmentEnabled(env) && Boolean(manager);
  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!available) throw new Error("Plugin development runtime is disabled or unavailable");
      if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
      return callback(payload);
    });
  };
  ipcMain.handle(CHANNELS.status, async (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    return { available, experimental: true };
  });
  handle(CHANNELS.list, async () => manager.list());
  handle(CHANNELS.install, async (payload) => manager.install(payload?.archivePath, { enable: payload?.enable === true }));
  handle(CHANNELS.setEnabled, async (payload) => manager.setEnabled(payload?.pluginId, payload?.enabled === true));
  handle(CHANNELS.restart, async (payload) => manager.restart(payload?.pluginId));
  handle(CHANNELS.uninstall, async (payload) => manager.uninstall(payload?.pluginId));
}

module.exports = { CHANNELS, createTrustedPluginBridgeSender, registerPluginBridge };
