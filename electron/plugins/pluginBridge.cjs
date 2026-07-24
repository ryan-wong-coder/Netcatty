"use strict";

const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

const { isPluginDevelopmentEnabled } = require("./constants.cjs");
const { raceWithAbort } = require("./rpcRouter.cjs");

const CHANNELS = Object.freeze({
  status: "netcatty:plugins:status",
  list: "netcatty:plugins:list",
  install: "netcatty:plugins:install",
  setEnabled: "netcatty:plugins:set-enabled",
  restart: "netcatty:plugins:restart",
  uninstall: "netcatty:plugins:uninstall",
  contributions: "netcatty:plugins:contributions",
  contributionIcon: "netcatty:plugins:contribution-icon",
  contributionsChanged: "netcatty:plugins:contributions-changed",
  executeCommand: "netcatty:plugins:execute-command",
  updateSetting: "netcatty:plugins:update-setting",
  resetSetting: "netcatty:plugins:reset-setting",
  setEnvironment: "netcatty:plugins:set-environment",
  terminalProviders: "netcatty:plugins:terminal-providers",
  terminalProvide: "netcatty:plugins:terminal-provide",
  terminalCancel: "netcatty:plugins:terminal-cancel",
  terminalSessionEvent: "netcatty:plugins:terminal-session-event",
  extensionProviders: "netcatty:plugins:extension-providers",
  extensionInvoke: "netcatty:plugins:extension-invoke",
  extensionCancel: "netcatty:plugins:extension-cancel",
  connectionStart: "netcatty:plugins:connection-start",
  connectionWrite: "netcatty:plugins:connection-write",
  connectionControl: "netcatty:plugins:connection-control",
  connectionData: "netcatty:plugins:connection-data",
  connectionClosed: "netcatty:plugins:connection-closed",
  credentialCatalogUpdate: "netcatty:plugins:credential-catalog-update",
  authenticationChallenge: "netcatty:plugins:authentication-challenge",
  authenticationRespond: "netcatty:plugins:authentication-respond",
  importerDetect: "netcatty:plugins:importer-detect",
  importerSelectFile: "netcatty:plugins:importer-select-file",
  importerReleaseFile: "netcatty:plugins:importer-release-file",
  importerParseFile: "netcatty:plugins:importer-parse-file",
  importerProgress: "netcatty:plugins:importer-progress",
  openView: "netcatty:plugins:open-view",
  closeView: "netcatty:plugins:close-view",
  setViewBounds: "netcatty:plugins:set-view-bounds",
  setViewVisibility: "netcatty:plugins:set-view-visibility",
  viewMessage: "netcatty:plugins:view-message",
  viewMessagePosted: "netcatty:plugins:view-message-posted",
  viewClosed: "netcatty:plugins:view-closed",
  getScopeCatalog: "netcatty:plugins:get-scope-catalog",
  setScopeCatalog: "netcatty:plugins:set-scope-catalog",
  scopeCatalogChanged: "netcatty:plugins:scope-catalog-changed",
});

const SCOPE_KINDS = Object.freeze(["workspace", "host", "session", "device"]);
const MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER = 64;
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_SELECTIONS_PER_SENDER = 8;
const IMPORT_SELECTION_TTL_MS = 5 * 60_000;
const DEFAULT_CONNECTION_STATUS_POLL_MS = 500;

function normalizePluginScopeCatalog(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  let total = 0;
  for (const kind of SCOPE_KINDS) {
    const entries = Array.isArray(source[kind]) ? source[kind] : [];
    const seen = new Set();
    result[kind] = [];
    for (const entry of entries) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (!id || id.length > 256 || id.includes("\0") || !label || label.length > 512 || seen.has(id)) continue;
      if (++total > 4096) throw new TypeError("Plugin setting scope catalog is too large");
      seen.add(id);
      result[kind].push(Object.freeze({ id, label }));
    }
    Object.freeze(result[kind]);
  }
  return Object.freeze(result);
}

function mergePluginScopeCatalogs(catalogs) {
  const result = {};
  let total = 0;
  for (const kind of SCOPE_KINDS) {
    const seen = new Set();
    result[kind] = [];
    for (const catalog of catalogs) {
      for (const entry of catalog?.[kind] ?? []) {
        if (seen.has(entry.id) || total >= 4096) continue;
        seen.add(entry.id);
        total += 1;
        result[kind].push(entry);
      }
    }
    Object.freeze(result[kind]);
  }
  return Object.freeze(result);
}

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
  const contributionService = options.contributionService;
  const terminalProviderService = options.terminalProviderService;
  const terminalDataPipelineService = options.terminalDataPipelineService;
  const extensionProviderService = options.extensionProviderService;
  const credentialResolver = options.credentialResolver;
  const connectionStatusPollMs = Number.isSafeInteger(options.connectionStatusPollMs)
    && options.connectionStatusPollMs >= 0
    && options.connectionStatusPollMs <= 60_000
    ? options.connectionStatusPollMs
    : DEFAULT_CONNECTION_STATUS_POLL_MS;
  const getTerminalWorkerManager = options.getTerminalWorkerManager ?? (() => null);
  const selectImporterFile = options.selectImporterFile;
  const viewHost = options.viewHost;
  const env = options.env ?? process.env;
  const isTrustedSender = options.isTrustedSender;
  const defaultScopeCatalog = normalizePluginScopeCatalog({ device: [{ id: "device", label: "This device" }] });
  const scopeCatalogs = new Map();
  const scopeCatalogOwners = new Map();
  const observedScopeCatalogSenders = new WeakSet();
  const terminalRequestsBySender = new WeakMap();
  const observedTerminalRequestSenders = new WeakSet();
  const extensionRequestsBySender = new WeakMap();
  const observedExtensionRequestSenders = new WeakSet();
  const connectionSessionsBySender = new WeakMap();
  const observedConnectionSenders = new WeakSet();
  const authenticationChallengesBySender = new WeakMap();
  const observedAuthenticationSenders = new WeakSet();
  const importerSelectionsBySender = new WeakMap();
  const observedImporterSelectionSenders = new WeakSet();
  const scopeCatalogSenderKey = (event) => {
    const id = event?.sender?.id;
    return Number.isSafeInteger(id) && id > 0 ? id : "default";
  };
  const currentScopeCatalog = () => mergePluginScopeCatalogs([
    ...scopeCatalogs.values(),
    defaultScopeCatalog,
  ]);
  const publishScopeCatalog = (event) => {
    const catalog = currentScopeCatalog();
    if (typeof options.broadcast === "function") options.broadcast(CHANNELS.scopeCatalogChanged, catalog);
    else event?.sender?.send?.(CHANNELS.scopeCatalogChanged, catalog);
  };
  const observeScopeCatalogSender = (event, key) => {
    const sender = event?.sender;
    if (!sender || typeof sender !== "object" || observedScopeCatalogSenders.has(sender)) return;
    observedScopeCatalogSenders.add(sender);
    sender.once?.("destroyed", () => {
      if (scopeCatalogOwners.get(key) !== sender) return;
      scopeCatalogOwners.delete(key);
      if (scopeCatalogs.delete(key)) publishScopeCatalog();
    });
  };
  const configured = isPluginDevelopmentEnabled(env)
    && Boolean(manager)
    && typeof manager.initialize === "function";
  const resolveManager = async () => {
    if (!configured) throw new Error("Plugin development runtime is disabled or unavailable");
    try {
      await manager.initialize();
    } catch (cause) {
      throw new Error("Plugin development runtime is disabled or unavailable", { cause });
    }
    return manager;
  };
  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
      const activeManager = await resolveManager();
      return callback(activeManager, payload, event);
    });
  };
  const terminalRequestMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin terminal request sender is unavailable");
    let requests = terminalRequestsBySender.get(sender);
    if (!requests) {
      requests = new Map();
      terminalRequestsBySender.set(sender, requests);
    }
    if (!observedTerminalRequestSenders.has(sender)) {
      observedTerminalRequestSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
      });
    }
    return requests;
  };
  const extensionRequestMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin extension request sender is unavailable");
    let requests = extensionRequestsBySender.get(sender);
    if (!requests) {
      requests = new Map();
      extensionRequestsBySender.set(sender, requests);
    }
    if (!observedExtensionRequestSenders.has(sender)) {
      observedExtensionRequestSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
      });
    }
    return requests;
  };
  const runExtensionRequest = async (event, payload, callback) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || requestId.includes("\0")) {
      throw new TypeError("Plugin extension request ID is invalid");
    }
    const requests = extensionRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error("Plugin extension request ID is already active");
    if (requests.size >= MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER) {
      throw new Error("Too many active Plugin extension requests");
    }
    const controller = new AbortController();
    requests.set(requestId, controller);
    try {
      await raceWithAbort(resolveManager(), controller.signal);
      return await callback(controller.signal);
    } finally {
      if (requests.get(requestId) === controller) requests.delete(requestId);
    }
  };
  const connectionSessionSet = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin connection sender is unavailable");
    let sessions = connectionSessionsBySender.get(sender);
    if (!sessions) {
      sessions = new Set();
      connectionSessionsBySender.set(sender, sessions);
    }
    if (!observedConnectionSenders.has(sender)) {
      observedConnectionSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const sessionId of sessions) extensionProviderService?.closeSessionLocal(sessionId);
        sessions.clear();
      });
    }
    return sessions;
  };
  const authenticationChallengeMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin authentication sender is unavailable");
    let challenges = authenticationChallengesBySender.get(sender);
    if (!challenges) {
      challenges = new Map();
      authenticationChallengesBySender.set(sender, challenges);
    }
    if (!observedAuthenticationSenders.has(sender)) {
      observedAuthenticationSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const pending of challenges.values()) pending.reject(new Error("Plugin authentication window closed"));
        challenges.clear();
      });
    }
    return challenges;
  };
  const requestAuthenticationChallenge = (event, requestId, challenge, signal) => {
    const challenges = authenticationChallengeMap(event.sender);
    const challengeRequestId = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (challenges.delete(challengeRequestId)) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const finish = (callback, value) => {
        signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      challenges.set(challengeRequestId, {
        requestId,
        challengeId: challenge.id,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        event.sender.send(CHANNELS.authenticationChallenge, {
          requestId,
          challengeRequestId,
          challenge,
        });
      } catch (error) {
        challenges.delete(challengeRequestId);
        finish(reject, error);
      }
    });
  };
  const closeImporterSelection = (selection) => {
    if (!selection?.handle) return;
    void selection.handle.close().catch(() => {});
  };
  const waitForConnectionStatusPoll = (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Plugin connection monitoring was cancelled", "AbortError"));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Plugin connection monitoring was cancelled", "AbortError"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, connectionStatusPollMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const pluginConnectionReadyMeta = Object.freeze({ pluginPipelineIngressBytes: 0 });
  const monitorPluginConnection = async ({ sessionId, sessions, controller, terminalWorkerManager }) => {
    try {
      while (!controller.signal.aborted && sessions.has(sessionId)) {
        await waitForConnectionStatusPoll(controller.signal);
        if (controller.signal.aborted || !sessions.has(sessionId)) return;
        const status = await extensionProviderService.control(
          sessionId,
          "getStatus",
          {},
          { signal: controller.signal },
        );
        if (status.status === "connected") {
          // A zero-byte terminal delivery transitions silent protocols out of
          // the connecting UI without inventing visible terminal output.
          await terminalWorkerManager.pushExternalOutput(sessionId, "", pluginConnectionReadyMeta);
          return;
        }
        if (status.status === "closed" || status.status === "error") {
          sessions.delete(sessionId);
          extensionProviderService.closeSessionLocal(sessionId);
          await terminalWorkerManager.finishExternalSession(sessionId, {
            reason: status.status,
            ...(status.message ? { error: status.message } : {}),
          });
          return;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      sessions.delete(sessionId);
      extensionProviderService.closeSessionLocal(sessionId);
      await terminalWorkerManager.finishExternalSession(sessionId, {
        reason: "error",
        error: error?.message || String(error),
      });
    }
  };
  const importerSelectionMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin importer sender is unavailable");
    let selections = importerSelectionsBySender.get(sender);
    if (!selections) {
      selections = new Map();
      importerSelectionsBySender.set(sender, selections);
    }
    if (!observedImporterSelectionSenders.has(sender)) {
      observedImporterSelectionSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const selection of selections.values()) closeImporterSelection(selection);
        selections.clear();
      });
    }
    const now = Date.now();
    for (const [token, selection] of selections) {
      if (selection.expiresAt <= now) {
        selections.delete(token);
        closeImporterSelection(selection);
      }
    }
    return selections;
  };
  ipcMain.handle(CHANNELS.status, async (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    let available = false;
    try {
      await resolveManager();
      available = true;
    } catch {}
    return { available, experimental: true };
  });
  handle(CHANNELS.list, async (activeManager) => activeManager.list());
  handle(CHANNELS.install, async (activeManager, payload) => activeManager.install(
    payload?.archivePath,
    { enable: payload?.enable === true },
  ));
  handle(CHANNELS.setEnabled, async (activeManager, payload) => activeManager.setEnabled(
    payload?.pluginId,
    payload?.enabled === true,
  ));
  handle(CHANNELS.restart, async (activeManager, payload) => activeManager.restart(payload?.pluginId));
  handle(CHANNELS.uninstall, async (activeManager, payload) => activeManager.uninstall(payload?.pluginId));
  handle(CHANNELS.contributions, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.snapshot(payload ?? {});
  });
  handle(CHANNELS.contributionIcon, async (_activeManager, payload) => {
    if (!options.resolveContributionIcon) throw new Error("Plugin contribution icons are unavailable");
    return options.resolveContributionIcon(payload);
  });
  handle(CHANNELS.executeCommand, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.executeCommand(payload?.command, payload?.args, {
      source: "renderer",
      context: payload?.context,
    });
  });
  handle(CHANNELS.updateSetting, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.updateSetting(
      payload?.pluginId,
      payload?.settingId,
      payload?.value,
      payload?.scopeId,
      { source: "host" },
    );
  });
  handle(CHANNELS.resetSetting, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.resetSetting(payload?.pluginId, payload?.settingId, payload?.scopeId);
  });
  handle(CHANNELS.setEnvironment, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    await contributionService.setEnvironment(payload ?? {});
    viewHost?.setEnvironment?.(payload ?? {});
    return null;
  });
  handle(CHANNELS.terminalProviders, async (_activeManager, payload) => {
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    return terminalProviderService.listProviders(payload ?? {});
  });
  ipcMain.handle(CHANNELS.terminalProvide, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || requestId.includes("\0")) {
      throw new TypeError("Plugin terminal request ID is invalid");
    }
    const requests = terminalRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error("Plugin terminal request ID is already active");
    if (requests.size >= MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER) {
      throw new Error("Too many active Plugin terminal requests");
    }
    const controller = new AbortController();
    requests.set(requestId, controller);
    try {
      await raceWithAbort(resolveManager(), controller.signal);
      const { requestId: _requestId, ...providerRequest } = payload;
      return await terminalProviderService.provide(providerRequest, { signal: controller.signal });
    } finally {
      if (requests.get(requestId) === controller) requests.delete(requestId);
    }
  });
  ipcMain.handle(CHANNELS.terminalCancel, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
      throw new TypeError("Plugin terminal request ID is invalid");
    }
    const requests = terminalRequestMap(event.sender);
    const controller = requests.get(requestId);
    controller?.abort();
    return controller != null;
  });
  handle(CHANNELS.terminalSessionEvent, async (_activeManager, payload, event) => {
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    if (terminalDataPipelineService?.acceptsSessionEvent
      && !terminalDataPipelineService.acceptsSessionEvent(payload, event?.sender?.id)) {
      return [];
    }
    const [providers] = await Promise.all([
      terminalProviderService.publishSessionEvent(payload),
      terminalDataPipelineService?.handleSessionEvent?.(payload, {
        webContentsId: event?.sender?.id,
      }) ?? [],
    ]);
    return providers;
  });
  handle(CHANNELS.extensionProviders, async (_activeManager, payload) => {
    if (!extensionProviderService) throw new Error("Plugin extension Providers are unavailable");
    return extensionProviderService.listProviders(payload ?? {});
  });
  handle(CHANNELS.credentialCatalogUpdate, async (_activeManager, payload) => {
    if (!credentialResolver || typeof credentialResolver.update !== "function") {
      throw new Error("Plugin Vault credential catalog is unavailable");
    }
    return credentialResolver.update(payload?.entries);
  });
  ipcMain.handle(CHANNELS.extensionInvoke, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin extension Providers are unavailable");
    if ((payload?.kind === "connection"
        && payload?.operation !== "validateConfiguration"
        && payload?.operation !== "probe")
      || payload?.kind === "authentication"
      || (payload?.kind === "importer" && payload?.operation === "parse")) {
      throw new TypeError("Stateful Provider operations require their dedicated host workflow");
    }
    return extensionProviderService.invoke(payload ?? {}, { signal });
  }));
  ipcMain.handle(CHANNELS.extensionCancel, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
      throw new TypeError("Plugin extension request ID is invalid");
    }
    const controller = extensionRequestMap(event.sender).get(requestId);
    controller?.abort();
    return controller != null;
  });
  ipcMain.handle(CHANNELS.connectionStart, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const terminalWorkerManager = getTerminalWorkerManager();
    if (!terminalWorkerManager?.startExternalSession) {
      throw new Error("Host terminal pipeline is unavailable for plugin connections");
    }
    const sessions = connectionSessionSet(event.sender);
    let credential = payload?.credential;
    if (payload?.authenticationProviderId) {
      const authentication = await extensionProviderService.authenticate({
        providerId: payload.authenticationProviderId,
        connectionProviderId: payload?.providerId,
        configuration: payload?.configuration,
        ...(credential === undefined ? {} : { credential }),
      }, (challenge) => requestAuthenticationChallenge(
        event,
        payload.requestId,
        challenge,
        signal,
      ), { signal });
      if (authentication.status !== "authenticated") {
        throw new Error(authentication.message || "Plugin authentication did not complete");
      }
      credential = authentication.credential;
    }
    const sessionId = payload?.sessionId;
    const outputDecoder = new TextDecoder("utf-8");
    let closedDuringStart = false;
    let providerOpened = false;
    let providerCloseStarted = false;
    const connectionController = new AbortController();
    const abortConnection = () => connectionController.abort(
      signal.reason ?? new DOMException("Plugin connection request was cancelled", "AbortError"),
    );
    if (signal.aborted) abortConnection();
    else signal.addEventListener("abort", abortConnection, { once: true });
    try {
      await terminalWorkerManager.startExternalSession({
        sessionId,
        webContentsId: event.sender.id,
        columns: payload?.columns,
        rows: payload?.rows,
        protocol: payload?.protocol,
        onInput: (data) => extensionProviderService.write(sessionId, data),
        onResize: ({ columns, rows }) => extensionProviderService.control(
          sessionId,
          "resize",
          { columns, rows },
        ),
        onClose: async () => {
          sessions.delete(sessionId);
          connectionController.abort(new DOMException("Terminal session closed", "AbortError"));
          providerCloseStarted = true;
          if (providerOpened) {
            try { await extensionProviderService.control(sessionId, "close", {}); }
            catch { extensionProviderService.closeSessionLocal(sessionId); }
          } else {
            extensionProviderService.closeSessionLocal(sessionId);
          }
        },
      });
      const opened = await extensionProviderService.openConnection({
        ...payload,
        ...(credential === undefined ? {} : { credential }),
      }, {
        signal: connectionController.signal,
        onData: async (bytes) => {
          const data = outputDecoder.decode(bytes, { stream: true });
          if (data) await terminalWorkerManager.pushExternalOutput(sessionId, data);
        },
        onOutputClose: async (reason) => {
          closedDuringStart = true;
          sessions.delete(sessionId);
          const finalData = outputDecoder.decode();
          if (finalData) await terminalWorkerManager.pushExternalOutput(sessionId, finalData);
          await terminalWorkerManager.finishExternalSession(sessionId, {
            reason: typeof reason === "string" ? reason : "closed",
          });
        },
      });
      providerOpened = true;
      if (!closedDuringStart) {
        sessions.add(opened.sessionId);
        if (opened.status === "connecting") {
          void monitorPluginConnection({
            sessionId: opened.sessionId,
            sessions,
            controller: connectionController,
            terminalWorkerManager,
          });
        } else if (opened.status === "connected") {
          // The terminal renderer treats the first delivery as the connection
          // readiness boundary. Preserve that boundary for silent protocols
          // whose Provider completes open before producing terminal bytes.
          await terminalWorkerManager.pushExternalOutput(opened.sessionId, "", pluginConnectionReadyMeta);
        }
      }
      return opened;
    } catch (error) {
      sessions.delete(sessionId);
      connectionController.abort(error);
      if (!providerCloseStarted && providerOpened) {
        try { await extensionProviderService.control(sessionId, "close", {}); }
        catch { extensionProviderService.closeSessionLocal(sessionId); }
      } else if (!providerCloseStarted && !closedDuringStart) {
        extensionProviderService.closeSessionLocal(sessionId);
      }
      await terminalWorkerManager.finishExternalSession(sessionId, {
        reason: "error",
        error: error?.message || String(error),
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", abortConnection);
    }
  }));
  ipcMain.handle(CHANNELS.authenticationRespond, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const challengeRequestId = payload?.challengeRequestId;
    if (typeof challengeRequestId !== "string" || challengeRequestId.length < 1 || challengeRequestId.length > 128) {
      throw new TypeError("Plugin authentication challenge request ID is invalid");
    }
    const challenges = authenticationChallengeMap(event.sender);
    const pending = challenges.get(challengeRequestId);
    if (!pending
      || pending.requestId !== payload?.requestId
      || pending.challengeId !== payload?.challengeId) {
      throw new Error("Plugin authentication challenge is not owned by this window");
    }
    challenges.delete(challengeRequestId);
    if (payload?.cancelled === true) pending.reject(new DOMException("Cancelled", "AbortError"));
    else pending.resolve(payload?.response);
    return null;
  });
  handle(CHANNELS.connectionWrite, async (_activeManager, payload, event) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const sessions = connectionSessionSet(event.sender);
    if (!sessions.has(payload?.sessionId)) throw new Error("Plugin connection session is not owned by this window");
    await extensionProviderService.write(payload.sessionId, payload.data);
    return null;
  });
  handle(CHANNELS.connectionControl, async (_activeManager, payload, event) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const sessions = connectionSessionSet(event.sender);
    if (!sessions.has(payload?.sessionId)) throw new Error("Plugin connection session is not owned by this window");
    const result = await extensionProviderService.control(
      payload.sessionId,
      payload.operation,
      payload.payload ?? {},
    );
    if (payload.operation === "close") sessions.delete(payload.sessionId);
    return result;
  });
  ipcMain.handle(CHANNELS.importerDetect, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin importer Providers are unavailable");
    return extensionProviderService.detectImporter({ ...payload, sample: payload?.sample }, { signal });
  }));
  handle(CHANNELS.importerSelectFile, async (_activeManager, _payload, event) => {
    if (typeof selectImporterFile !== "function") throw new Error("Plugin importer file selection is unavailable");
    const filePath = await selectImporterFile(event);
    if (!filePath) return null;
    const handle = await fs.open(filePath, "r");
    let retained = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMPORT_FILE_BYTES) {
        throw new TypeError("Plugin importer file is not a supported regular file");
      }
      const sample = Buffer.allocUnsafe(Math.min(stat.size, 128 * 1024));
      const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
      if (bytesRead !== sample.byteLength) throw new Error("Plugin importer file changed while sampling");
      const selections = importerSelectionMap(event.sender);
      if (selections.size >= MAX_IMPORT_SELECTIONS_PER_SENDER) {
        throw new Error("Too many pending Plugin importer file selections");
      }
      const selectionToken = randomUUID();
      selections.set(selectionToken, {
        handle,
        filePath,
        fileName: filePath.split(/[\\/]/u).at(-1) || "import",
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        expiresAt: Date.now() + IMPORT_SELECTION_TTL_MS,
      });
      retained = true;
      return { selectionToken, fileName: selections.get(selectionToken).fileName, sample: sample.subarray(0, bytesRead) };
    } finally {
      if (!retained) await handle.close();
    }
  });
  handle(CHANNELS.importerReleaseFile, async (_activeManager, payload, event) => {
    const selectionToken = payload?.selectionToken;
    if (typeof selectionToken !== "string" || selectionToken.length < 1 || selectionToken.length > 128) {
      throw new TypeError("Plugin importer selection token is invalid");
    }
    const selections = importerSelectionMap(event.sender);
    const selection = selections.get(selectionToken);
    const deleted = selections.delete(selectionToken);
    closeImporterSelection(selection);
    return deleted;
  });
  ipcMain.handle(CHANNELS.importerParseFile, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin importer Providers are unavailable");
    const selectionToken = payload?.selectionToken;
    if (typeof selectionToken !== "string" || selectionToken.length < 1 || selectionToken.length > 128) {
      throw new TypeError("Plugin importer selection token is invalid");
    }
    const selections = importerSelectionMap(event.sender);
    const selection = selections.get(selectionToken);
    selections.delete(selectionToken);
    if (!selection || selection.expiresAt <= Date.now()) throw new Error("Plugin importer file selection expired");
    const handle = selection.handle;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== selection.size || stat.dev !== selection.dev
        || stat.ino !== selection.ino || stat.mtimeMs !== selection.mtimeMs) {
        throw new Error("Plugin importer file changed after selection");
      }
      return await extensionProviderService.parseImporter({
        ...payload,
        fileName: selection.fileName,
        source: handle.createReadStream({ autoClose: false, signal, start: 0 }),
        sourceByteLength: stat.size,
      }, {
        signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed?.()) {
            event.sender.send(CHANNELS.importerProgress, {
              requestId: payload.requestId,
              providerId: payload.providerId,
              progress,
            });
          }
        },
      });
    } finally {
      await handle.close();
    }
  }));
  handle(CHANNELS.openView, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    return viewHost.open(payload, event.sender);
  });
  handle(CHANNELS.closeView, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    await viewHost.close(payload?.instanceId, event.sender);
    return null;
  });
  handle(CHANNELS.setViewBounds, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    viewHost.setBounds(payload?.instanceId, payload?.bounds, event.sender);
    return null;
  });
  handle(CHANNELS.setViewVisibility, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    viewHost.setVisible(payload?.instanceId, payload?.visible, event.sender);
    return null;
  });
  handle(CHANNELS.viewMessage, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    await viewHost.postMessage(payload?.instanceId, payload?.message, event.sender);
    return null;
  });
  handle(CHANNELS.getScopeCatalog, async () => currentScopeCatalog());
  handle(CHANNELS.setScopeCatalog, async (_activeManager, payload, event) => {
    const key = scopeCatalogSenderKey(event);
    const scopeCatalog = normalizePluginScopeCatalog(payload);
    scopeCatalogs.set(key, scopeCatalog);
    scopeCatalogOwners.set(key, event?.sender);
    observeScopeCatalogSender(event, key);
    publishScopeCatalog(event);
    return null;
  });
  contributionService?.onDidChange?.((event) => options.broadcast?.(CHANNELS.contributionsChanged, event));
  contributionService?.onDidPostViewMessage?.((event) => options.broadcast?.(CHANNELS.viewMessagePosted, event));
  viewHost?.onDidClose?.((event) => options.broadcast?.(CHANNELS.viewClosed, event));
}

module.exports = {
  CHANNELS,
  createTrustedPluginBridgeSender,
  mergePluginScopeCatalogs,
  normalizePluginScopeCatalog,
  registerPluginBridge,
};
