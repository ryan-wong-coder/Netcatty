"use strict";

const dns = require("node:dns");

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_FAILURE_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 256;
const MAX_CONCURRENT_PROBES = 8;

function createTcpConnectLatencyProbe({
  net,
  lookup = dns.lookup,
  now = () => performance.now(),
  cacheNow = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  failureCacheTtlMs = DEFAULT_FAILURE_CACHE_TTL_MS,
  maxCacheEntries = MAX_CACHE_ENTRIES,
  maxConcurrentProbes = MAX_CONCURRENT_PROBES,
}) {
  const resultCache = new Map();
  const inFlight = new Map();
  const queue = [];
  let activeProbeCount = 0;

  function runProbe({ hostname, port, timeoutMs }) {
    return new Promise((resolve) => {
      let startedAt = net.isIP?.(hostname) ? now() : null;
      let settled = false;
      let socket = null;

      const finish = (latencyMs) => {
        if (settled) return;
        settled = true;
        try { socket?.destroy(); } catch { /* best-effort cleanup */ }
        resolve(latencyMs);
      };

      try {
        const connectOptions = { host: hostname, port };
        if (startedAt === null) {
          connectOptions.lookup = (host, options, callback) => {
            lookup(host, options, (err, address, family) => {
              startedAt = now();
              callback(err, address, family);
            });
          };
        }
        socket = net.createConnection(connectOptions, () => {
          const connectedAt = now();
          finish(Math.max(0, Math.round(connectedAt - (startedAt ?? connectedAt))));
        });
        socket.once("error", () => finish(null));
        socket.setTimeout(timeoutMs, () => finish(null));
      } catch {
        finish(null);
      }
    });
  }

  function startScheduledProbe(task) {
    activeProbeCount += 1;
    let result;
    try {
      result = Promise.resolve(task());
    } catch (err) {
      result = Promise.reject(err);
    }
    return result.finally(() => {
      activeProbeCount -= 1;
      while (activeProbeCount < maxConcurrentProbes && queue.length > 0) {
        const next = queue.shift();
        startScheduledProbe(next.task).then(next.resolve, next.reject);
      }
    });
  }

  function scheduleProbe(task) {
    if (activeProbeCount < maxConcurrentProbes) return startScheduledProbe(task);
    return new Promise((resolve, reject) => queue.push({ task, resolve, reject }));
  }

  function cacheResult(key, value) {
    resultCache.delete(key);
    resultCache.set(key, {
      value,
      expiresAt: cacheNow() + (value === null ? failureCacheTtlMs : cacheTtlMs),
    });
    while (resultCache.size > maxCacheEntries) {
      resultCache.delete(resultCache.keys().next().value);
    }
  }

  return function measureTcpConnectLatency({ hostname, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.resolve(null);
    }

    const key = `${String(hostname).toLowerCase()}\u0000${port}`;
    const pending = inFlight.get(key);
    if (pending) return pending;

    const cached = resultCache.get(key);
    const checkedAt = cacheNow();
    if (cached && cached.expiresAt > checkedAt) {
      resultCache.delete(key);
      resultCache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    resultCache.delete(key);

    const promise = scheduleProbe(() => runProbe({ hostname, port, timeoutMs }))
      .catch(() => null)
      .then((value) => {
        inFlight.delete(key);
        cacheResult(key, value);
        return value;
      });
    inFlight.set(key, promise);
    return promise;
  };
}

module.exports = {
  createTcpConnectLatencyProbe,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  MAX_CONCURRENT_PROBES,
};
