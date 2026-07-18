"use strict";

const {
  PLUGIN_DEACTIVATION_TIMEOUT_MS,
  PLUGIN_UTILITY_FORCE_EXIT_TIMEOUT_MS,
  PLUGIN_UTILITY_TERMINATION_GRACE_MS,
} = require("./constants.cjs");

let shutdownHandler = null;
let shutdownPromise = null;

function registerPluginShutdown(handler) {
  if (typeof handler !== "function") throw new TypeError("Plugin shutdown handler must be a function");
  shutdownHandler = handler;
  shutdownPromise = null;
  return () => {
    if (shutdownHandler === handler) shutdownHandler = null;
  };
}

function runPluginShutdown(options = {}) {
  if (shutdownPromise) return shutdownPromise;
  if (!shutdownHandler) return Promise.resolve({ timedOut: false });
  const timeoutMs = options.timeoutMs
    ?? PLUGIN_DEACTIVATION_TIMEOUT_MS
      + PLUGIN_UTILITY_TERMINATION_GRACE_MS
      + PLUGIN_UTILITY_FORCE_EXIT_TIMEOUT_MS
      + 500;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  shutdownPromise = Promise.race([
    Promise.resolve().then(shutdownHandler).then(() => ({ timedOut: false })),
    timeout,
  ]).finally(() => clearTimeout(timer));
  return shutdownPromise;
}

function resetPluginShutdownForTests() {
  shutdownHandler = null;
  shutdownPromise = null;
}

module.exports = {
  registerPluginShutdown,
  resetPluginShutdownForTests,
  runPluginShutdown,
};
