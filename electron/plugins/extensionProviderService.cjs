"use strict";

const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const {
  assertProviderRequest,
  assertProviderResult,
  createDefinitionValidator,
  formatValidationErrors,
} = require("./contractValidator.cjs");
const { assertPluginJsonValue } = require("./jsonBoundary.cjs");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");
const { compileRestrictedJsonSchema } = require("./restrictedJsonSchema.cjs");

const EXTENSION_PROVIDER_KINDS = Object.freeze(["connection", "authentication", "importer"]);
const PROVIDER_PERMISSIONS = Object.freeze({
  connection: "provider.connection",
  authentication: "provider.authentication",
  importer: "provider.importer",
});
const OPERATIONS = Object.freeze({
  connection: new Set(["validateConfiguration", "probe", "open", "resize", "signal", "reconnect", "close", "getStatus"]),
  authentication: new Set(["begin", "respond", "cancel"]),
  importer: new Set(["detect", "parse"]),
});
const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;
const STREAM_WINDOW_BYTES = 256 * 1024;
const MAX_AUTH_CHALLENGES = 32;
const AUTHENTICATION_SECRET_LEASE_TTL_MS = 30_000;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 10_000;
const MAX_IMPORT_LINE_BYTES = 256 * 1024;
const definitionValidators = Object.freeze({
  AuthenticationResult: createDefinitionValidator("AuthenticationResult"),
  ConnectionOpenResult: createDefinitionValidator("ConnectionOpenResult"),
  ConnectionProbeResult: createDefinitionValidator("ConnectionProbeResult"),
  ConnectionStatusResult: createDefinitionValidator("ConnectionStatusResult"),
  ConnectionValidateResult: createDefinitionValidator("ConnectionValidateResult"),
  ImporterDetectResult: createDefinitionValidator("ImporterDetectResult"),
  ImporterParseResult: createDefinitionValidator("ImporterParseResult"),
  ImporterRecord: createDefinitionValidator("ImporterRecord"),
});

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

function assertBoundedJson(value, label, maxBytes = MAX_PROVIDER_JSON_BYTES) {
  try { assertPluginJsonValue(value, { maxBytes }); }
  catch (error) { throw invalidArgument(`${label} must be bounded JSON: ${error?.message ?? error}`); }
  return value;
}

function assertString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw invalidArgument(`${label} is invalid`);
  }
  return value;
}

function assertDefinition(name, value, label = name) {
  const validator = definitionValidators[name];
  if (!validator(value)) {
    throw new TypeError(`${label} violates the plugin contract: ${formatValidationErrors(validator.errors)}`);
  }
  return value;
}

function assertKind(kind) {
  if (!EXTENSION_PROVIDER_KINDS.includes(kind)) throw invalidArgument("Extension Provider kind is invalid");
  return kind;
}

function assertOperation(kind, operation) {
  const value = assertString(operation, "Extension Provider operation", 128);
  if (!OPERATIONS[kind].has(value)) throw invalidArgument(`Unsupported ${kind} Provider operation: ${value}`);
  return value;
}

function normalizeDeadlineMs(value) {
  const deadline = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 300_000) {
    throw invalidArgument("Extension Provider deadline is invalid");
  }
  return deadline;
}

function normalizeIdentity(activation) {
  const identity = activation?.identity;
  if (!identity
    || identity.pluginId !== activation.plugin.id
    || identity.pluginVersion !== activation.plugin.activeVersion
    || typeof identity.runtimeId !== "string" || !identity.runtimeId
    || (identity.runtimeKind !== "browser" && identity.runtimeKind !== "utility")
    || typeof identity.securityPrincipal !== "string" || !identity.securityPrincipal) {
    throw new PluginRpcError(RPC_ERRORS.unavailable, "Extension Provider activation identity is unavailable or stale");
  }
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    securityPrincipal: identity.securityPrincipal,
  });
}

function runtimeContext(activation, identity, signal) {
  return Object.freeze({
    pluginId: activation.plugin.id,
    pluginVersion: activation.plugin.activeVersion,
    runtimeId: identity.runtimeId,
    runtimeKind: identity.runtimeKind,
    manifest: activation.plugin.manifest,
    securityPrincipal: identity.securityPrincipal,
    signal,
  });
}

function identityKey(identity, streamId) {
  return `${identity.pluginId}\0${identity.pluginVersion}\0${identity.runtimeId}\0${streamId}`;
}

function waitForStreamOrRequestFailure(streamPromise, requestPromise) {
  return Promise.race([
    streamPromise,
    requestPromise.then(
      () => new Promise(() => {}),
      (error) => Promise.reject(error),
    ),
  ]);
}

function waitUntilDeadline(promise, deadlineAt, signal, message) {
  const operation = signal ? raceWithAbort(Promise.resolve(promise), signal) : Promise.resolve(promise);
  const remainingMs = Math.max(0, Math.ceil(deadlineAt - performance.now()));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new PluginRpcError(RPC_ERRORS.deadlineExceeded, message));
    }, remainingMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function validateProviderResult(rawResult, requestId) {
  try {
    assertProviderResult(rawResult);
    assertBoundedJson(rawResult, "Extension Provider result");
  } catch (error) {
    throw new PluginRpcError(RPC_ERRORS.dataLoss, `Extension Provider returned an invalid result: ${error?.message ?? error}`);
  }
  if (rawResult.requestId !== requestId) {
    throw new PluginRpcError(RPC_ERRORS.dataLoss, "Extension Provider returned a mismatched request ID");
  }
  if (rawResult.status === "failed") {
    throw new PluginRpcError(rawResult.error.code, rawResult.error.message, rawResult.error.data);
  }
  if (rawResult.status === "cancelled") {
    throw new PluginRpcError(RPC_ERRORS.cancelled, "Extension Provider request was cancelled");
  }
  return rawResult.result;
}

function assertConnectionResult(operation, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (["resize", "signal", "reconnect", "close"].includes(operation) && value === null) return value;
    throw new TypeError(`Connection ${operation} result must be an object`);
  }
  if (operation === "validateConfiguration") {
    assertDefinition("ConnectionValidateResult", value, "Connection validation result");
    if (typeof value.valid !== "boolean" || !Array.isArray(value.issues)) throw new TypeError("Connection validation result is invalid");
  } else if (operation === "probe") {
    assertDefinition("ConnectionProbeResult", value, "Connection probe result");
    if (typeof value.available !== "boolean") throw new TypeError("Connection probe result is invalid");
  } else if (operation === "open") {
    assertDefinition("ConnectionOpenResult", value, "Connection open result");
    assertString(value.connectionId, "Plugin connection ID");
    if (value.status !== "connecting" && value.status !== "connected") throw new TypeError("Connection open status is invalid");
  } else if (operation === "getStatus") {
    assertDefinition("ConnectionStatusResult", value, "Connection status result");
    if (!["connecting", "connected", "reconnecting", "closed", "error"].includes(value.status)) {
      throw new TypeError("Connection status is invalid");
    }
  }
  assertBoundedJson(value, `Connection ${operation} result`);
  return freezeJson(value);
}

function assertAuthenticationResult(value) {
  assertDefinition("AuthenticationResult", value, "Authentication result");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["challenge", "authenticated", "cancelled", "failed"].includes(value.status)) {
    throw new TypeError("Authentication Provider result is invalid");
  }
  if (value.status === "challenge") {
    const challenge = value.challenge;
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
      throw new TypeError("Authentication challenge is missing");
    }
    assertString(challenge.id, "Authentication challenge ID", 128);
    if (!["text", "password", "otp", "choice", "confirmation", "browser", "deviceCode"].includes(challenge.kind)) {
      throw new TypeError("Authentication challenge kind is invalid");
    }
    assertString(challenge.title, "Authentication challenge title", 512);
  }
  assertBoundedJson(value, "Authentication result");
  return freezeJson(value);
}

function assertAuthenticationResponse(challenge, response) {
  if (["text", "password", "otp"].includes(challenge.kind)) {
    if (typeof response !== "string" || response.length < 1 || Buffer.byteLength(response, "utf8") > 8_192) {
      throw invalidArgument("Authentication text response is invalid or too large");
    }
    return response;
  }
  if (challenge.kind === "choice") {
    const allowed = new Set(challenge.choices.map((choice) => choice.id));
    if (challenge.multiple) {
      if (!Array.isArray(response) || response.length < 1 || response.length > 64
        || new Set(response).size !== response.length
        || response.some((choiceId) => typeof choiceId !== "string" || !allowed.has(choiceId))) {
        throw invalidArgument("Authentication choice response is invalid");
      }
      return Object.freeze([...response]);
    }
    if (typeof response !== "string" || !allowed.has(response)) {
      throw invalidArgument("Authentication choice response is invalid");
    }
    return response;
  }
  if (typeof response !== "boolean") throw invalidArgument("Authentication confirmation response is invalid");
  return response;
}

function assertImporterDetectResult(value) {
  assertDefinition("ImporterDetectResult", value, "Importer detection result");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) {
    throw new TypeError("Importer detection result is invalid");
  }
  assertBoundedJson(value, "Importer detection result");
  return freezeJson(value);
}

function normalizeImportRecord(value) {
  assertDefinition("ImporterRecord", value, "Importer record");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Importer record must be an object");
  if (value.type === "draft") {
    if (!value.draft || typeof value.draft !== "object" || Array.isArray(value.draft)
      || !["host", "identity", "key", "snippet", "group"].includes(value.draft.kind)) {
      throw new TypeError("Importer draft is invalid");
    }
  } else if (value.type === "warning" || value.type === "error") {
    assertString(value.message, "Importer diagnostic message", 2_048);
  } else if (value.type === "progress") {
    if (!Number.isSafeInteger(value.completed) || value.completed < 0) throw new TypeError("Importer progress is invalid");
    if (value.total != null && (!Number.isSafeInteger(value.total) || value.total < value.completed)) {
      throw new TypeError("Importer progress total is invalid");
    }
  } else {
    throw new TypeError("Importer record type is invalid");
  }
  assertBoundedJson(value, "Importer record", MAX_IMPORT_LINE_BYTES);
  return freezeJson(value);
}

class PluginExtensionProviderService {
  constructor(options) {
    if (!options?.contributionService || !options?.permissionEngine || !options?.runtimeSupervisor
      || !options?.rpcRegistry || !options?.leaseStore) {
      throw new TypeError("Extension Provider service requires contribution, permission, runtime, RPC, and secret lease services");
    }
    this.contributionService = options.contributionService;
    this.permissionEngine = options.permissionEngine;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.leaseStore = options.leaseStore;
    this.expectations = new Map();
    this.sessions = new Map();
    this.streamRegistration = options.rpcRegistry.registerIncomingStream((stream, context) => (
      this.acceptIncomingStream(stream, context)
    ));
    this.runtimeRegistration = this.runtimeSupervisor.onDidChangeRuntime?.((event) => {
      if (["running", "starting"].includes(event.status)) return;
      for (const [sessionId, session] of this.sessions) {
        if (session.identity.runtimeId === event.runtimeId || session.identity.pluginId === event.pluginId) {
          this.closeSessionLocal(sessionId, new PluginRpcError(RPC_ERRORS.unavailable, "Plugin connection runtime stopped"));
        }
      }
    });
  }

  listProviders(options = {}) {
    const kind = assertKind(options.kind);
    return freezeJson(this.contributionService.listProviders({ kind, locale: options.locale }));
  }

  async activate(providerId, kind, signal) {
    const activationOperation = Promise.resolve(this.contributionService.activateProvider(providerId));
    const activation = signal ? await raceWithAbort(activationOperation, signal) : await activationOperation;
    if (activation.provider.kind !== kind) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Extension Provider kind changed during activation");
    }
    const identity = normalizeIdentity(activation);
    await this.permissionEngine.authorize(runtimeContext(activation, identity, signal), {
      permission: PROVIDER_PERMISSIONS[kind],
      resources: [activation.provider.id],
      reason: `Use ${activation.provider.id} as a ${kind} Provider`,
      operationId: `${kind}:${activation.provider.id}`,
    });
    return { activation, identity };
  }

  async invoke(params, options = {}) {
    const kind = assertKind(params?.kind);
    const operation = assertOperation(kind, params?.operation);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const requestId = params?.requestId ?? `provider-${randomUUID()}`;
    const request = {
      providerId: params?.providerId,
      operation,
      requestId,
      ...(params?.payload === undefined ? {} : { payload: assertBoundedJson(params.payload, "Extension Provider payload") }),
      deadlineMs,
    };
    try { assertProviderRequest(request); }
    catch (error) { throw invalidArgument(error?.message ?? "Extension Provider request is invalid"); }
    const { activation, identity } = options.activation ?? await this.activate(request.providerId, kind, options.signal);
    const configuration = request.payload?.configuration;
    if (activation.provider.configurationSchema !== undefined && configuration !== undefined) {
      try {
        compileRestrictedJsonSchema(activation.provider.configurationSchema)(configuration);
      } catch (error) {
        throw invalidArgument(`Provider configuration failed host schema validation: ${error?.message ?? error}`);
      }
    }
    const rawResult = await this.runtimeSupervisor.request(activation.plugin.id, "provider.invoke", {
      ...request,
      kind,
    }, {
      signal: options.signal,
      timeoutMs: deadlineMs,
      expectedIdentity: identity,
    });
    const result = validateProviderResult(rawResult, requestId);
    try {
      if (kind === "connection") return assertConnectionResult(operation, result);
      if (kind === "authentication") return assertAuthenticationResult(result);
      if (kind === "importer" && operation === "detect") return assertImporterDetectResult(result);
      return freezeJson(assertBoundedJson(result, "Extension Provider result"));
    } catch (error) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, `Extension Provider result failed validation: ${error?.message ?? error}`);
    }
  }

  expectIncoming(identity, streamId, bind, signal, timeoutMs) {
    assertString(streamId, "Plugin stream ID", 128);
    const key = identityKey(identity, streamId);
    if (this.expectations.has(key)) throw new PluginRpcError(RPC_ERRORS.alreadyExists, "Plugin stream expectation already exists");
    let timer;
    let abortListener;
    const promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      const expectation = {
        bind,
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      };
      this.expectations.set(key, expectation);
      timer = setTimeout(() => {
        if (this.expectations.get(key) !== expectation) return;
        this.expectations.delete(key);
        expectation.reject(new PluginRpcError(RPC_ERRORS.deadlineExceeded, "Plugin output stream did not open"));
      }, timeoutMs);
      timer.unref?.();
      abortListener = () => {
        if (this.expectations.get(key) !== expectation) return;
        this.expectations.delete(key);
        expectation.reject(signal.reason ?? new PluginRpcError(RPC_ERRORS.cancelled, "Plugin stream was cancelled"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    return { key, promise, cancel: (error) => {
      const expectation = this.expectations.get(key);
      if (!expectation) return;
      this.expectations.delete(key);
      expectation.reject(error);
    } };
  }

  async acceptIncomingStream(stream, context) {
    const key = identityKey(context, stream.streamId);
    const expectation = this.expectations.get(key);
    if (!expectation) return false;
    this.expectations.delete(key);
    try {
      const value = await expectation.bind(stream, context);
      expectation.resolve(value);
      return true;
    } catch (error) {
      expectation.reject(error);
      throw error;
    }
  }

  async openConnection(params, options = {}) {
    const providerId = assertString(params?.providerId, "Connection Provider ID");
    const configuration = freezeJson(assertBoundedJson(params?.configuration ?? {}, "Connection configuration"));
    const columns = params?.columns;
    const rows = params?.rows;
    if (!Number.isInteger(columns) || columns < 1 || columns > 16_384
      || !Number.isInteger(rows) || rows < 1 || rows > 16_384) {
      throw invalidArgument("Plugin connection dimensions are invalid");
    }
    const activation = await this.activate(providerId, "connection", options.signal);
    const sessionId = assertString(params?.sessionId ?? `plugin-session-${randomUUID()}`, "Plugin session ID", 128);
    if (this.sessions.has(sessionId)) throw new PluginRpcError(RPC_ERRORS.alreadyExists, "Plugin session already exists");
    const operationId = `connection:${randomUUID()}`;
    const inputStreamId = `${operationId}:input`;
    const outputStreamId = `${operationId}:output`;
    let outputClosed = null;
    const expected = this.expectIncoming(activation.identity, outputStreamId, async (stream) => {
      stream.bind({
        onChunk: async (chunk, release) => {
          if (chunk.encoding !== "binary") throw new Error("Plugin connection output must be binary");
          await options.onData?.(chunk.bytes);
          release();
        },
        onClose: (reason) => {
          outputClosed = reason ?? "closed";
          this.closeSessionLocal(sessionId);
          return options.onOutputClose?.(reason);
        },
      });
      return stream;
    }, options.signal, normalizeDeadlineMs(params?.deadlineMs));
    const request = this.invoke({
      providerId,
      kind: "connection",
      operation: "open",
      payload: {
        operationId,
        configuration,
        columns,
        rows,
        inputStreamId,
        outputStreamId,
        windowBytes: STREAM_WINDOW_BYTES,
        ...(params.credential === undefined ? {} : { credential: params.credential }),
        ...(params.authenticationProviderId === undefined ? {} : { authenticationProviderId: params.authenticationProviderId }),
      },
      deadlineMs: params?.deadlineMs,
    }, { ...options, activation });
    let output;
    let input;
    try {
      output = await waitForStreamOrRequestFailure(expected.promise, request);
      input = await this.runtimeSupervisor.openStream(activation.activation.plugin.id, inputStreamId, STREAM_WINDOW_BYTES, {
        expectedIdentity: activation.identity,
      });
      const result = await request;
      if (outputClosed != null) throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin connection output closed during startup");
      const session = Object.freeze({
        sessionId,
        providerId,
        pluginConnectionId: result.connectionId,
        activation: activation.activation,
        identity: activation.identity,
        input,
        output,
        configuration,
      });
      this.sessions.set(sessionId, session);
      return freezeJson({ sessionId, providerId, status: result.status, diagnostics: result.diagnostics ?? [] });
    } catch (error) {
      expected.cancel(error);
      try { input?.cancel?.(); } catch {}
      try { output?.cancel?.(); } catch {}
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  getSession(sessionId) {
    const session = this.sessions.get(assertString(sessionId, "Plugin session ID", 128));
    if (!session) throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin connection session was not found");
    return session;
  }

  async write(sessionId, data) {
    const session = this.getSession(sessionId);
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
    await session.input.write(bytes);
  }

  async control(sessionId, operation, payload = {}, options = {}) {
    const session = this.getSession(sessionId);
    const operationId = `connection:${operation}:${randomUUID()}`;
    try {
      const result = await this.invoke({
        providerId: session.providerId,
        kind: "connection",
        operation,
        payload: { ...payload, connectionId: session.pluginConnectionId, operationId },
        deadlineMs: options.deadlineMs,
      }, { ...options, activation: { activation: session.activation, identity: session.identity } });
      if (operation === "close") this.closeSessionLocal(sessionId);
      return result;
    } finally {
      this.leaseStore.revokeOperation(session.identity.pluginId, operationId);
    }
  }

  closeSessionLocal(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    try { session.input.cancel?.(); } catch {}
    try { session.output.cancel?.(error); } catch {}
    return true;
  }

  async authenticate(params, requestChallenge, options = {}) {
    if (typeof requestChallenge !== "function") throw invalidArgument("Authentication challenge renderer is unavailable");
    const providerId = assertString(params?.providerId, "Authentication Provider ID");
    const operationId = `authentication:${randomUUID()}`;
    const activation = await this.activate(providerId, "authentication", options.signal);
    const connectionProviderId = assertString(params?.connectionProviderId, "Connection Provider ID");
    const connectionProvider = this.contributionService.listProviders({ kind: "connection" })
      .find((entry) => entry.provider.id === connectionProviderId);
    if (!connectionProvider) throw new PluginRpcError(RPC_ERRORS.notFound, "Connection Provider was not found");
    let completed = false;
    try {
      let result = await this.invoke({
        providerId,
        kind: "authentication",
        operation: "begin",
        payload: {
          operationId,
          connectionProviderId,
          configuration: freezeJson(assertBoundedJson(params?.configuration ?? {}, "Authentication configuration")),
          ...(params.credential === undefined ? {} : { credential: params.credential }),
        },
      }, { ...options, activation });
      for (let index = 0; result.status === "challenge"; index += 1) {
        if (index >= MAX_AUTH_CHALLENGES) throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Authentication challenge limit exceeded");
        let response = assertAuthenticationResponse(
          result.challenge,
          await requestChallenge(result.challenge, { signal: options.signal }),
        );
        if (result.challenge.kind === "password" || result.challenge.kind === "otp") {
          const secretValue = response;
          response = this.leaseStore.issue({
            pluginId: activation.identity.pluginId,
            runtimeId: activation.identity.runtimeId,
            credential: Object.freeze({
              kind: "authentication-challenge",
              challengeId: result.challenge.id,
            }),
            operationId,
            purpose: `Respond to ${result.challenge.kind} challenge ${result.challenge.id}`,
            ttlMs: AUTHENTICATION_SECRET_LEASE_TTL_MS,
            signal: options.signal,
            resolveSecret: () => secretValue,
          });
        }
        result = await this.invoke({
          providerId,
          kind: "authentication",
          operation: "respond",
          payload: { operationId, challengeId: result.challenge.id, response },
        }, { ...options, activation });
      }
      if (result.status === "authenticated" && result.credential?.kind === "secret"
        && connectionProvider.pluginId !== activation.identity.pluginId) {
        throw new PluginRpcError(
          RPC_ERRORS.failedPrecondition,
          "Cross-plugin authentication must return a host-owned CredentialRef",
        );
      }
      completed = true;
      return result;
    } catch (error) {
      if (!completed) {
        void this.invoke({
          providerId,
          kind: "authentication",
          operation: "cancel",
          payload: { operationId },
        }, { ...options, activation }).catch(() => {});
      }
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  async detectImporter(params, options = {}) {
    const bytes = params?.sample instanceof Uint8Array ? params.sample : new Uint8Array(params?.sample ?? []);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROVIDER_JSON_BYTES) throw invalidArgument("Importer sample size is invalid");
    return this.invoke({
      providerId: params.providerId,
      kind: "importer",
      operation: "detect",
      payload: {
        ...(params.fileName ? { fileName: assertString(params.fileName, "Import file name", 1_024) } : {}),
        ...(params.mediaType ? { mediaType: assertString(params.mediaType, "Import media type", 256) } : {}),
        sample: { encoding: "base64", data: Buffer.from(bytes).toString("base64") },
      },
      deadlineMs: params.deadlineMs,
    }, options);
  }

  async parseImporter(params, options = {}) {
    const providerId = assertString(params?.providerId, "Importer Provider ID");
    const bufferedSource = params?.data === undefined
      ? null
      : params.data instanceof Uint8Array ? params.data : new Uint8Array(params.data ?? []);
    const sourceByteLength = bufferedSource?.byteLength ?? params?.sourceByteLength;
    if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 1 || sourceByteLength > MAX_IMPORT_BYTES) {
      throw invalidArgument("Importer input size is invalid");
    }
    const source = bufferedSource ? [bufferedSource] : params?.source;
    if (!source || (typeof source[Symbol.asyncIterator] !== "function"
      && typeof source[Symbol.iterator] !== "function")) {
      throw invalidArgument("Importer input stream is unavailable");
    }
    const activation = await this.activate(providerId, "importer", options.signal);
    const deadlineMs = normalizeDeadlineMs(params?.deadlineMs);
    const deadlineAt = performance.now() + deadlineMs;
    const operationId = `importer:${randomUUID()}`;
    const inputStreamId = `${operationId}:input`;
    const outputStreamId = `${operationId}:output`;
    const records = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let outputBytes = 0;
    let resolveOutputDone;
    let rejectOutputDone;
    const outputDone = new Promise((resolve, reject) => {
      resolveOutputDone = resolve;
      rejectOutputDone = reject;
    });
    void outputDone.catch(() => {});
    const consumeLines = (final = false) => {
      const lines = pending.split("\n");
      pending = final ? "" : lines.pop();
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_IMPORT_LINE_BYTES || records.length >= MAX_IMPORT_RECORDS) {
          throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Importer output exceeds its record limits");
        }
        const record = normalizeImportRecord(JSON.parse(line));
        records.push(record);
        if (record.type === "progress") options.onProgress?.(record);
      }
    };
    const expected = this.expectIncoming(activation.identity, outputStreamId, async (stream) => {
      stream.bind({
        onChunk: (chunk, release) => {
          if (chunk.encoding !== "binary") throw new Error("Importer output must be UTF-8 JSONL bytes");
          outputBytes += chunk.bytes.byteLength;
          if (outputBytes > MAX_IMPORT_BYTES) throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Importer output is too large");
          pending += decoder.decode(chunk.bytes, { stream: true });
          consumeLines(false);
          release();
        },
        onClose: (reason) => {
          try {
            if (reason !== "end") throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer output stream did not end normally");
            pending += decoder.decode();
            if (pending) pending += "\n";
            consumeLines(true);
            resolveOutputDone();
          } catch (error) {
            rejectOutputDone(error);
          }
        },
      });
      return stream;
    }, options.signal, deadlineMs);
    const request = this.invoke({
      providerId,
      kind: "importer",
      operation: "parse",
      payload: {
        operationId,
        ...(params.fileName ? { fileName: assertString(params.fileName, "Import file name", 1_024) } : {}),
        ...(params.mediaType ? { mediaType: assertString(params.mediaType, "Import media type", 256) } : {}),
        inputStreamId,
        outputStreamId,
        windowBytes: STREAM_WINDOW_BYTES,
        ...(params.options === undefined ? {} : { options: assertBoundedJson(params.options, "Importer options") }),
      },
      deadlineMs,
    }, { ...options, activation });
    const waitForImporterIo = (promise, message) => waitUntilDeadline(
      waitForStreamOrRequestFailure(promise, request),
      deadlineAt,
      options.signal,
      message,
    );
    let output;
    let input;
    let sourceIterator;
    let sourceCompleted = false;
    try {
      sourceIterator = typeof source[Symbol.asyncIterator] === "function"
        ? source[Symbol.asyncIterator]()
        : source[Symbol.iterator]();
      output = await waitUntilDeadline(
        waitForStreamOrRequestFailure(expected.promise, request),
        deadlineAt,
        options.signal,
        "Importer output stream exceeded its deadline",
      );
      input = await waitForImporterIo(
        this.runtimeSupervisor.openStream(activation.activation.plugin.id, inputStreamId, STREAM_WINDOW_BYTES, {
          expectedIdentity: activation.identity,
        }),
        "Importer input stream exceeded its deadline",
      );
      let inputBytes = 0;
      while (true) {
        const next = await waitForImporterIo(
          Promise.resolve(sourceIterator.next()),
          "Importer input source exceeded its deadline",
        );
        if (next.done) {
          sourceCompleted = true;
          break;
        }
        const rawChunk = next.value;
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        inputBytes += chunk.byteLength;
        if (chunk.byteLength < 1 || inputBytes > sourceByteLength) {
          throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer input stream changed while it was being read");
        }
        for (let offset = 0; offset < chunk.byteLength; offset += STREAM_WINDOW_BYTES) {
          await waitForImporterIo(
            input.write(chunk.subarray(offset, Math.min(chunk.byteLength, offset + STREAM_WINDOW_BYTES))),
            "Importer input stream exceeded its deadline",
          );
        }
      }
      if (inputBytes !== sourceByteLength) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer input stream ended at an unexpected size");
      }
      await waitForImporterIo(input.end(), "Importer input stream exceeded its deadline");
      const result = await waitUntilDeadline(
        request,
        deadlineAt,
        options.signal,
        "Importer Provider exceeded its deadline",
      );
      await waitUntilDeadline(
        outputDone,
        deadlineAt,
        options.signal,
        "Importer output stream exceeded its deadline",
      );
      assertDefinition("ImporterParseResult", result, "Importer completion result");
      if (!result || typeof result !== "object" || Array.isArray(result)
        || !Number.isSafeInteger(result.parsed) || result.parsed < 0
        || !Number.isSafeInteger(result.warnings) || result.warnings < 0
        || !Number.isSafeInteger(result.errors) || result.errors < 0) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer completion result is invalid");
      }
      const observed = records.reduce((counts, record) => {
        if (record.type === "draft") counts.parsed += 1;
        else if (record.type === "warning") counts.warnings += 1;
        else if (record.type === "error") counts.errors += 1;
        return counts;
      }, { parsed: 0, warnings: 0, errors: 0 });
      if (result.parsed !== observed.parsed
        || result.warnings !== observed.warnings
        || result.errors !== observed.errors) {
        throw new PluginRpcError(RPC_ERRORS.dataLoss, "Importer completion counts do not match its streamed records");
      }
      return freezeJson({ providerId, result, records });
    } catch (error) {
      expected.cancel(error);
      if (!sourceCompleted && typeof sourceIterator?.return === "function") {
        try { void Promise.resolve(sourceIterator.return()).catch(() => {}); } catch {}
      }
      try { input?.cancel?.(); } catch {}
      try { output?.cancel?.(); } catch {}
      throw error;
    } finally {
      this.leaseStore.revokeOperation(activation.identity.pluginId, operationId);
    }
  }

  shutdown() {
    this.streamRegistration?.dispose();
    this.runtimeRegistration?.dispose();
    for (const sessionId of [...this.sessions.keys()]) this.closeSessionLocal(sessionId);
    const error = new PluginRpcError(RPC_ERRORS.unavailable, "Extension Provider service stopped");
    for (const expectation of this.expectations.values()) expectation.reject(error);
    this.expectations.clear();
  }
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  EXTENSION_PROVIDER_KINDS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_RECORDS,
  PluginExtensionProviderService,
  STREAM_WINDOW_BYTES,
  normalizeImportRecord,
};
