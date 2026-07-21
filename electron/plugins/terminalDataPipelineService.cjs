"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { normalizeTerminalSessionSnapshot } = require("./terminalProviderService.cjs");

const DIRECTIONS = Object.freeze(["input", "output"]);

function runtimeIdentityMatches(left, right) {
  return left?.pluginId === right?.pluginId
    && left?.pluginVersion === right?.pluginVersion
    && left?.runtimeId === right?.runtimeId
    && left?.runtimeKind === right?.runtimeKind
    && left?.securityPrincipal === right?.securityPrincipal;
}

function normalizeActivationIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || identity.pluginId !== activation?.plugin?.id
    || identity.pluginVersion !== activation?.plugin?.activeVersion
    || typeof identity.runtimeId !== "string" || identity.runtimeId.length < 1
    || identity.runtimeKind !== "utility"
    || typeof identity.securityPrincipal !== "string" || identity.securityPrincipal.length < 1) {
    throw new PluginRpcError(
      RPC_ERRORS.unavailable,
      "Terminal interceptor activation identity is unavailable, stale, or not an advanced utility runtime",
    );
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

class PluginTerminalDataPipelineService {
  constructor(options) {
    if (!options?.contributionService || !options?.permissionEngine
      || !options?.runtimeSupervisor || !options?.MessageChannelMain) {
      throw new TypeError("Terminal data pipeline requires contribution, permission, runtime, and MessagePort services");
    }
    this.contributionService = options.contributionService;
    this.permissionEngine = options.permissionEngine;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.MessageChannelMain = options.MessageChannelMain;
    this.requestSelection = options.requestSelection ?? (async () => null);
    this.showWarning = options.showWarning ?? (() => {});
    this.terminalWorkerManager = null;
    this.workerWarningSubscription = null;
    this.active = new Map();
    this.operations = new Map();
    this.sessionEpochs = new Map();
    this.closed = false;
    this.runtimeSupervisor.onDidChangeRuntime?.((event) => {
      if (event.status === "running") return;
      for (const [key, binding] of this.active) {
        if (binding.identity.pluginId === event.pluginId
          && (event.runtimeId == null || binding.identity.runtimeId === event.runtimeId)) {
          this.#detachKey(key, "runtime-stopped");
        }
      }
    });
    this.contributionService.onDidChange?.(() => this.#pruneContributions());
  }

  bindTerminalWorkerManager(manager) {
    this.workerWarningSubscription?.dispose?.();
    this.workerWarningSubscription = null;
    this.terminalWorkerManager = manager ?? null;
    if (manager?.onTerminalInterceptorWarning) {
      this.workerWarningSubscription = manager.onTerminalInterceptorWarning((warning) => {
        if (warning?.code === "worker-exit") {
          this.active.clear();
          return;
        }
        const key = `${warning?.sessionId}\0${warning?.direction}`;
        this.active.delete(key);
        if (!["detached", "replaced", "shutdown"].includes(warning?.code)) {
          this.showWarning(warning);
        }
      });
    }
  }

  #key(sessionId, direction) {
    return `${sessionId}\0${direction}`;
  }

  #providers(direction, locale) {
    const kind = `terminal.interceptor.${direction}`;
    return this.contributionService.listProviders({ kind, locale });
  }

  #pruneContributions() {
    for (const [key, binding] of this.active) {
      const providers = this.#providers(binding.direction);
      if (!providers.some((entry) => entry.provider.id === binding.providerId
        && entry.pluginId === binding.identity.pluginId
        && entry.pluginVersion === binding.identity.pluginVersion)) {
        this.#detachKey(key, "contribution-removed");
      }
    }
  }

  #detachKey(key, reason) {
    const binding = this.active.get(key);
    if (!binding) return;
    this.active.delete(key);
    this.terminalWorkerManager?.detachTerminalInterceptor?.(
      binding.sessionId,
      binding.direction,
      reason,
    );
  }

  detachSession(sessionId, reason = "session-disposed") {
    for (const direction of DIRECTIONS) this.#detachKey(this.#key(sessionId, direction), reason);
  }

  async configureDirection(sessionValue, direction, options = {}) {
    const session = normalizeTerminalSessionSnapshot(sessionValue);
    if (!DIRECTIONS.includes(direction)) throw new TypeError("Terminal interceptor direction is invalid");
    const key = this.#key(session.sessionId, direction);
    const epoch = options.sessionEpoch ?? this.sessionEpochs.get(session.sessionId) ?? 0;
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => (
      this.#configureDirection(session, direction, { ...options, sessionEpoch: epoch })
    ));
    this.operations.set(key, operation);
    try { return await operation; }
    finally {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    }
  }

  #assertSessionCurrent(sessionId, epoch) {
    if (this.closed || (this.sessionEpochs.get(sessionId) ?? 0) !== epoch) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Terminal session changed during interceptor activation");
    }
  }

  #assertAttachmentCurrent(session, direction, providerId, identity, options) {
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    if (options.webContentsId != null
      && !this.terminalWorkerManager?.ownsSession?.(session.sessionId, options.webContentsId)) {
      throw new PluginRpcError(
        RPC_ERRORS.permissionDenied,
        "Terminal interceptor session ownership changed during activation",
      );
    }
    const declared = this.#providers(direction).some((entry) => (
      entry.provider.id === providerId
      && entry.pluginId === identity.pluginId
      && entry.pluginVersion === identity.pluginVersion
    ));
    if (!declared) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Terminal interceptor contribution changed during activation",
      );
    }
  }

  async #configureDirection(session, direction, options) {
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    if (!this.terminalWorkerManager?.attachTerminalInterceptor) {
      return Object.freeze({ status: "unavailable", direction });
    }
    if (options.webContentsId != null
      && !this.terminalWorkerManager.ownsSession?.(session.sessionId, options.webContentsId)) {
      if (options.deferUntilOwned === true) {
        return Object.freeze({ status: "pending-session", direction });
      }
      throw new PluginRpcError(
        RPC_ERRORS.permissionDenied,
        "Terminal interceptor session is not owned by the requesting window",
      );
    }
    const providers = this.#providers(direction, options.locale);
    if (providers.length === 0) return Object.freeze({ status: "none", direction });
    const key = this.#key(session.sessionId, direction);
    const existing = this.active.get(key);
    if (existing && existing.sessionEpoch === options.sessionEpoch
      && providers.some((entry) => entry.provider.id === existing.providerId)
      && runtimeIdentityMatches(
        this.runtimeSupervisor.getRuntimeIdentity(existing.identity.pluginId),
        existing.identity,
      )) {
      return Object.freeze({
        status: "active",
        direction,
        providerId: existing.providerId,
        pluginId: existing.identity.pluginId,
      });
    }
    let providerId = options.providerId;
    if (providerId == null && providers.length === 1) providerId = providers[0].provider.id;
    if (providerId == null) {
      providerId = await this.requestSelection(Object.freeze({ session, direction, providers }));
      this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    }
    if (providerId == null) return Object.freeze({ status: "declined", direction });
    const selected = providers.find((entry) => entry.provider.id === providerId);
    if (!selected) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Selected Terminal interceptor is unavailable");

    const activation = await this.contributionService.activateProvider(providerId);
    this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    const identity = normalizeActivationIdentity(activation);
    if (activation.plugin.manifest.main?.node == null
      || activation.provider.kind !== `terminal.interceptor.${direction}`) {
      throw new PluginRpcError(
        RPC_ERRORS.failedPrecondition,
        "Terminal interceptors require an active advanced utility plugin",
      );
    }
    const context = {
      pluginId: activation.plugin.id,
      pluginVersion: activation.plugin.activeVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
      manifest: activation.plugin.manifest,
      securityPrincipal: identity.securityPrincipal,
    };
    for (const permission of ["provider.terminal", `terminal.intercept.${direction}`]) {
      await this.permissionEngine.authorize(context, {
        permission,
        resources: ["*"],
        sessionId: session.sessionId,
        reason: `Use ${providerId} to intercept Terminal ${direction} data`,
        operationId: `terminal.interceptor.${direction}:${providerId}`,
      });
      this.#assertSessionCurrent(session.sessionId, options.sessionEpoch);
    }
    const currentIdentity = this.runtimeSupervisor.getRuntimeIdentity(activation.plugin.id);
    if (!runtimeIdentityMatches(currentIdentity, identity)) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Terminal interceptor runtime changed during authorization");
    }
    this.#assertAttachmentCurrent(session, direction, providerId, identity, options);

    if (existing?.sessionEpoch === options.sessionEpoch
      && existing.providerId === providerId
      && runtimeIdentityMatches(existing.identity, identity)) {
      return Object.freeze({ status: "active", direction, providerId, pluginId: identity.pluginId });
    }
    if (existing) this.#detachKey(key, "replaced");

    const channel = new this.MessageChannelMain();
    const descriptor = Object.freeze({
      sessionId: session.sessionId,
      direction,
      providerId,
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      runtimeId: identity.runtimeId,
      runtimeKind: identity.runtimeKind,
      securityPrincipal: identity.securityPrincipal,
      session,
    });
    let workerAttached = false;
    try {
      this.terminalWorkerManager.attachTerminalInterceptor(descriptor, channel.port1);
      workerAttached = true;
      await this.runtimeSupervisor.attachTerminalInterceptor(
        identity.pluginId,
        { providerId, direction, session },
        channel.port2,
        { expectedIdentity: identity },
      );
      this.#assertAttachmentCurrent(session, direction, providerId, identity, options);
    } catch (error) {
      if (workerAttached) {
        this.terminalWorkerManager.detachTerminalInterceptor(session.sessionId, direction);
      }
      try { channel.port1.close?.(); } catch {}
      try { channel.port2.close?.(); } catch {}
      throw error;
    }
    this.active.set(key, Object.freeze({
      sessionId: session.sessionId,
      direction,
      providerId,
      identity: Object.freeze({ ...identity }),
      sessionEpoch: options.sessionEpoch,
    }));
    return Object.freeze({ status: "active", direction, providerId, pluginId: identity.pluginId });
  }

  async handleSessionEvent(event, options = {}) {
    const session = normalizeTerminalSessionSnapshot(event?.session);
    if (event?.type === "disposed") {
      this.sessionEpochs.set(session.sessionId, (this.sessionEpochs.get(session.sessionId) ?? 0) + 1);
      this.detachSession(session.sessionId);
      return Object.freeze([]);
    }
    if (event?.type !== "created" && event?.type !== "connected" && event?.type !== "snapshot") {
      return Object.freeze([]);
    }
    if (event.type === "created") {
      this.detachSession(session.sessionId, "session-replaced");
      this.sessionEpochs.set(session.sessionId, (this.sessionEpochs.get(session.sessionId) ?? 0) + 1);
    }
    if (!this.sessionEpochs.has(session.sessionId)) this.sessionEpochs.set(session.sessionId, 0);
    const sessionEpoch = this.sessionEpochs.get(session.sessionId) ?? 0;
    const results = [];
    for (const direction of DIRECTIONS) {
      try {
        results.push(await this.configureDirection(session, direction, {
          ...options,
          sessionEpoch,
          deferUntilOwned: event.type === "created",
        }));
      }
      catch (error) {
        this.showWarning(Object.freeze({
          sessionId: session.sessionId,
          direction,
          code: "activation",
          message: error?.message ?? String(error),
        }));
        results.push(Object.freeze({ status: "failed", direction }));
      }
    }
    return Object.freeze(results);
  }

  shutdown() {
    this.closed = true;
    for (const sessionId of this.sessionEpochs.keys()) {
      this.sessionEpochs.set(sessionId, (this.sessionEpochs.get(sessionId) ?? 0) + 1);
    }
    for (const key of [...this.active.keys()]) this.#detachKey(key, "shutdown");
    this.workerWarningSubscription?.dispose?.();
    this.workerWarningSubscription = null;
  }
}

module.exports = {
  DIRECTIONS,
  PluginTerminalDataPipelineService,
  normalizeActivationIdentity,
  runtimeIdentityMatches,
};
