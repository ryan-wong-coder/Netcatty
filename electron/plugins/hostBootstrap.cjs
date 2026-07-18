"use strict";

const { isPluginDevelopmentEnabled } = require("./constants.cjs");

function startDevelopmentPluginHost(options) {
  if (!isPluginDevelopmentEnabled(options.env)) return null;
  const reportFailure = (message, error) => {
    try { options.logger?.error?.(message, error); } catch {}
  };
  let service;
  try {
    service = options.createService();
    const initialization = Promise.resolve(service.manager.initialize());
    options.registerShutdown(() => service.manager.shutdown());
    void initialization.catch((error) => {
      reportFailure("[Plugins] Failed to initialize plugin host:", error);
    });
    return service;
  } catch (error) {
    reportFailure("[Plugins] Failed to create plugin host:", error);
    if (typeof service?.manager?.shutdown === "function") {
      try { void Promise.resolve(service.manager.shutdown()).catch(() => {}); } catch {}
    }
    return null;
  }
}

module.exports = { startDevelopmentPluginHost };
