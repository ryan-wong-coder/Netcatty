"use strict";

const { randomUUID } = require("node:crypto");

const {
  assertProviderRequest,
  assertProviderResult,
} = require("./contractValidator.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
const MAX_TERMINAL_PROVIDERS_PER_REQUEST = 32;
const DEFAULT_PROVIDER_DEADLINE_MS = 1_500;
const TERMINAL_PROVIDER_KINDS = Object.freeze([
  "terminal.completion",
  "terminal.decoration",
  "terminal.link",
  "terminal.hover",
  "terminal.matcher",
  "terminal.semantic",
  "terminal.prompt",
  "terminal.background",
]);
const TERMINAL_PROVIDER_KIND_SET = new Set(TERMINAL_PROVIDER_KINDS);
const TERMINAL_PROVIDER_PERMISSIONS = new Map([
  ["terminal.completion", ["provider.terminal", "terminal.complete"]],
  ["terminal.decoration", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.link", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.hover", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.matcher", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.semantic", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.prompt", ["provider.terminal", "terminal.output", "terminal.decorate"]],
  ["terminal.background", ["provider.terminal", "terminal.decorate"]],
]);
const TERMINAL_EVENT_TYPES = new Set([
  "snapshot",
  "created",
  "connected",
  "reconnected",
  "cwdChanged",
  "titleChanged",
  "resized",
  "alternateScreenChanged",
  "commandSubmitted",
  "disconnected",
  "disposed",
]);
const TERMINAL_PROTOCOLS = new Set(["ssh", "telnet", "local", "serial"]);
const TERMINAL_STATUSES = new Set(["connecting", "connected", "disconnected"]);
const TERMINAL_SHELL_TYPES = new Set(["posix", "fish", "powershell", "cmd", "unknown"]);

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

function freezeJson(value) {
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function assertBoundedJson(value, label) {
  try {
    assertPluginJsonValue(value, { maxBytes: MAX_PROVIDER_JSON_BYTES });
  } catch (error) {
    throw invalidArgument(`${label} must be a bounded JSON value: ${error?.message ?? error}`);
  }
  return value;
}

function assertBoundedString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw invalidArgument(`${label} is invalid`);
  }
  return value;
}

function assertTerminalProviderKind(kind) {
  if (!TERMINAL_PROVIDER_KIND_SET.has(kind)) {
    if (kind === "terminal.interceptor.input" || kind === "terminal.interceptor.output") {
      throw new PluginRpcError(
        RPC_ERRORS.unsupported,
        "Raw terminal interceptor providers require the privileged PR 6 transport",
      );
    }
    throw invalidArgument("Terminal Provider kind is invalid");
  }
  return kind;
}

function normalizeDeadlineMs(value) {
  const deadlineMs = value ?? DEFAULT_PROVIDER_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300_000) {
    throw invalidArgument("Terminal Provider deadline is invalid");
  }
  return deadlineMs;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new PluginRpcError(RPC_ERRORS.cancelled, "Terminal Provider request was cancelled");
  }
}

function optionalString(value, label, maximum = 512) {
  if (value == null) return undefined;
  return assertBoundedString(value, label, maximum);
}

function normalizeTerminalSessionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument("Terminal session snapshot must be an object");
  }
  const protocol = value.protocol;
  const status = value.status;
  if (!TERMINAL_PROTOCOLS.has(protocol)) throw invalidArgument("Terminal session protocol is invalid");
  if (!TERMINAL_STATUSES.has(status)) throw invalidArgument("Terminal session status is invalid");
  if (value.shellType != null && !TERMINAL_SHELL_TYPES.has(value.shellType)) {
    throw invalidArgument("Terminal session shell type is invalid");
  }
  if (value.alternateScreen != null && typeof value.alternateScreen !== "boolean") {
    throw invalidArgument("Terminal alternate-screen state is invalid");
  }
  const normalizeDimension = (dimension, label) => {
    if (dimension == null) return undefined;
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 16_384) {
      throw invalidArgument(`Terminal session ${label} is invalid`);
    }
    return dimension;
  };
  return freezeJson({
    sessionId: assertBoundedString(value.sessionId, "Terminal session ID"),
    ...(value.hostId == null ? {} : { hostId: optionalString(value.hostId, "Terminal host ID") }),
    ...(value.workspaceId == null ? {} : { workspaceId: optionalString(value.workspaceId, "Terminal workspace ID") }),
    protocol,
    status,
    ...(value.cwd == null ? {} : { cwd: optionalString(value.cwd, "Terminal working directory", 4_096) }),
    ...(value.title == null ? {} : { title: optionalString(value.title, "Terminal title", 1_024) }),
    ...(value.shellType == null ? {} : { shellType: value.shellType }),
    ...(value.cols == null ? {} : { cols: normalizeDimension(value.cols, "column count") }),
    ...(value.rows == null ? {} : { rows: normalizeDimension(value.rows, "row count") }),
    ...(value.alternateScreen == null ? {} : { alternateScreen: value.alternateScreen === true }),
  });
}

function normalizeTerminalSessionEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !TERMINAL_EVENT_TYPES.has(value.type)) {
    throw invalidArgument("Terminal session event is invalid");
  }
  const event = {
    type: value.type,
    session: normalizeTerminalSessionSnapshot(value.session),
    ...(value.exitCode == null ? {} : { exitCode: value.exitCode }),
  };
  if (event.exitCode != null && (!Number.isInteger(event.exitCode) || event.exitCode < -255 || event.exitCode > 255)) {
    throw invalidArgument("Terminal session exit code is invalid");
  }
  // PR 5 lifecycle events intentionally exclude command text and raw output.
  // Sensitive input/output interception belongs to the privileged PR 6 path.
  assertBoundedJson(event, "Terminal session event");
  return freezeJson(event);
}

function providerFailure(requestId, error) {
  if (error instanceof PluginRpcError && error.code === RPC_ERRORS.cancelled) {
    return Object.freeze({ requestId, status: "cancelled" });
  }
  return freezeJson({
    requestId,
    status: "failed",
    error: {
      code: error instanceof PluginRpcError ? error.code : RPC_ERRORS.internal,
      message: String(error?.message ?? "Plugin Provider failed").slice(0, 2_048) || "Plugin Provider failed",
    },
  });
}

function normalizeActivationIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || typeof identity.pluginId !== "string"
    || identity.pluginId !== activation.plugin.id
    || typeof identity.pluginVersion !== "string"
    || identity.pluginVersion !== activation.plugin.activeVersion
    || typeof identity.runtimeId !== "string"
    || identity.runtimeId.length < 1
    || typeof identity.runtimeKind !== "string"
    || identity.runtimeKind.length < 1
    || typeof identity.securityPrincipal !== "string"
    || identity.securityPrincipal.length < 1) {
    throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin Provider activation identity is unavailable or stale");
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

function runtimeIdentityMatches(current, expected) {
  return current?.pluginId === expected.pluginId
    && current?.pluginVersion === expected.pluginVersion
    && current?.runtimeId === expected.runtimeId
    && current?.runtimeKind === expected.runtimeKind
    && current?.securityPrincipal === expected.securityPrincipal;
}

class PluginTerminalProviderService {
  constructor(options) {
    if (!options?.contributionService || !options?.runtimeSupervisor || !options?.permissionEngine) {
      throw new TypeError("Terminal Provider service requires contribution, runtime, and permission services");
    }
    this.contributionService = options.contributionService;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.permissionEngine = options.permissionEngine;
    this.lifecycleAuthorizations = new Map();
  }

  lifecycleAuthorizationKey(pluginId, sessionId) {
    return `${pluginId}\0${sessionId}`;
  }

  rememberLifecycleAuthorization(activation, identity, sessionId) {
    this.lifecycleAuthorizations.set(
      this.lifecycleAuthorizationKey(activation.plugin.id, sessionId),
      Object.freeze({
        context: Object.freeze({
          pluginId: activation.plugin.id,
          pluginVersion: activation.plugin.activeVersion,
          runtimeId: identity.runtimeId,
          runtimeKind: identity.runtimeKind,
          manifest: activation.plugin.manifest,
          securityPrincipal: identity.securityPrincipal,
        }),
        identity,
      }),
    );
  }

  listProviders(options = {}) {
    const kind = assertTerminalProviderKind(options.kind);
    const preferredProviderIds = options.preferredProviderIds ?? [];
    if (!Array.isArray(preferredProviderIds)
      || preferredProviderIds.length > 256
      || preferredProviderIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 256)
      || new Set(preferredProviderIds).size !== preferredProviderIds.length) {
      throw invalidArgument("Preferred Terminal Provider IDs are invalid");
    }
    if (options.locale != null
      && (typeof options.locale !== "string" || options.locale.length < 1 || options.locale.length > 128)) {
      throw invalidArgument("Terminal Provider locale is invalid");
    }
    const preferred = new Map(preferredProviderIds.map((id, index) => [id, index]));
    const providers = [...this.contributionService.listProviders({ kind, locale: options.locale })];
    providers.sort((left, right) => {
      const leftRank = preferred.get(left.provider.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = preferred.get(right.provider.id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank
        || left.pluginId.localeCompare(right.pluginId)
        || left.provider.id.localeCompare(right.provider.id);
    });
    return freezeJson(providers);
  }

  async invokeProvider(params, options = {}) {
    const kind = assertTerminalProviderKind(params?.kind);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const request = {
      providerId: params?.providerId,
      operation: params?.operation,
      requestId: params?.requestId ?? `provider-${randomUUID()}`,
      ...(params?.payload === undefined ? {} : { payload: assertBoundedJson(params.payload, "Provider payload") }),
      deadlineMs,
    };
    try { assertProviderRequest(request); }
    catch (error) { throw invalidArgument(error?.message ?? "Provider request is invalid"); }
    throwIfCancelled(options.signal);
    const activation = await this.contributionService.activateProvider(request.providerId);
    throwIfCancelled(options.signal);
    if (activation.provider.kind !== kind) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Plugin Provider kind changed during activation");
    }
    const identity = normalizeActivationIdentity(activation);
    const invocationSession = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
      ? request.payload.session
      : null;
    const permissionSession = invocationSession == null
      ? null
      : normalizeTerminalSessionSnapshot(invocationSession);
    let providerPermissionScope;
    for (const permission of TERMINAL_PROVIDER_PERMISSIONS.get(kind) ?? []) {
      const grant = await this.permissionEngine.authorize({
        pluginId: activation.plugin.id,
        pluginVersion: activation.plugin.activeVersion,
        runtimeId: identity.runtimeId,
        runtimeKind: identity.runtimeKind,
        manifest: activation.plugin.manifest,
        securityPrincipal: identity.securityPrincipal,
        signal: options.signal,
      }, {
        permission,
        resources: ["*"],
        reason: `Use ${activation.provider.id} for ${kind}`,
        operationId: `${kind}:${activation.provider.id}`,
        ...(permissionSession == null ? {} : { sessionId: permissionSession.sessionId }),
      });
      if (permission === "provider.terminal") providerPermissionScope = grant?.scope;
    }
    const expectedIdentity = { expectedIdentity: identity };
    if (permissionSession != null) {
      await this.runtimeSupervisor.notify(activation.plugin.id, "plugin.terminal.event", {
        type: "snapshot",
        session: permissionSession,
      }, expectedIdentity);
    }
    const rawResult = await this.runtimeSupervisor.request(activation.plugin.id, "provider.invoke", {
      ...request,
      kind,
    }, {
      signal: options.signal,
      timeoutMs: deadlineMs,
      ...expectedIdentity,
    });
    let result;
    try {
      assertProviderResult(rawResult);
      assertBoundedJson(rawResult, "Provider result");
      result = rawResult;
    } catch (error) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, `Plugin Provider returned an invalid result: ${error?.message ?? error}`);
    }
    if (result.requestId !== request.requestId) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin Provider returned a mismatched request ID");
    }
    if (result.status === "ok" && permissionSession != null && providerPermissionScope !== "once") {
      this.rememberLifecycleAuthorization(activation, identity, permissionSession.sessionId);
    }
    return freezeJson({
      pluginId: activation.plugin.id,
      pluginVersion: activation.plugin.activeVersion,
      runtimeId: identity.runtimeId,
      providerId: activation.provider.id,
      kind,
      ...result,
    });
  }

  async provide(params, options = {}) {
    const kind = assertTerminalProviderKind(params?.kind);
    const operation = assertBoundedString(params?.operation, "Terminal Provider operation", 128);
    const session = normalizeTerminalSessionSnapshot(params?.session);
    const providedPayload = params?.payload === undefined
      ? undefined
      : assertBoundedJson(params.payload, "Provider payload");
    const payload = freezeJson(providedPayload && typeof providedPayload === "object" && !Array.isArray(providedPayload)
      ? { ...providedPayload, session }
      : { session, ...(providedPayload === undefined ? {} : { value: providedPayload }) });
    assertBoundedJson(payload, "Provider request payload");
    const providers = this.listProviders({
      kind,
      locale: params?.locale,
      preferredProviderIds: params?.preferredProviderIds,
    }).slice(0, MAX_TERMINAL_PROVIDERS_PER_REQUEST);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    return freezeJson(await Promise.all(providers.map(async (entry) => {
      const { provider } = entry;
      const requestId = `provider-${randomUUID()}`;
      try {
        return await this.invokeProvider({
          providerId: provider.id,
          kind,
          operation,
          requestId,
          payload,
          deadlineMs,
        }, options);
      } catch (error) {
        return freezeJson({
          pluginId: entry.pluginId,
          pluginVersion: entry.pluginVersion,
          providerId: provider.id,
          kind,
          ...providerFailure(requestId, options.signal?.aborted
            ? new PluginRpcError(RPC_ERRORS.cancelled, "Terminal Provider request was cancelled")
            : error),
        });
      }
    })));
  }

  async publishSessionEvent(event) {
    const normalized = normalizeTerminalSessionEvent(event);
    const sessionId = normalized.session.sessionId;
    const pluginIds = new Set();
    for (const entry of this.contributionService.listProviders()) {
      if (TERMINAL_PROVIDER_KIND_SET.has(entry.provider.kind)) pluginIds.add(entry.pluginId);
    }
    const deliveries = await Promise.all([...pluginIds].sort().map(async (pluginId) => {
      const key = this.lifecycleAuthorizationKey(pluginId, sessionId);
      const authorization = this.lifecycleAuthorizations.get(key);
      if (!authorization) return Object.freeze({ pluginId, delivered: false });
      const identity = this.runtimeSupervisor.getRuntimeIdentity(pluginId);
      if (!runtimeIdentityMatches(identity, authorization.identity)) {
        this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: false });
      }
      try {
        await this.permissionEngine.authorize(authorization.context, {
          permission: "provider.terminal",
          resources: ["*"],
          reason: "Receive Terminal Provider lifecycle metadata",
          operationId: `terminal.lifecycle:${sessionId}`,
          sessionId,
          interactive: false,
        });
        await this.runtimeSupervisor.notify(pluginId, "plugin.terminal.event", normalized, {
          expectedIdentity: authorization.identity,
        });
        if (normalized.type === "disposed") this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: true });
      } catch {
        this.lifecycleAuthorizations.delete(key);
        return Object.freeze({ pluginId, delivered: false });
      }
    }));
    return freezeJson(deliveries);
  }
}

module.exports = {
  DEFAULT_PROVIDER_DEADLINE_MS,
  MAX_PROVIDER_JSON_BYTES,
  MAX_TERMINAL_PROVIDERS_PER_REQUEST,
  PluginTerminalProviderService,
  TERMINAL_PROVIDER_KINDS,
  TERMINAL_PROVIDER_PERMISSIONS,
  assertTerminalProviderKind,
  normalizeTerminalSessionEvent,
  normalizeTerminalSessionSnapshot,
};
