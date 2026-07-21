"use strict";

const { TextDecoder, TextEncoder } = require("node:util");
const { performance } = require("node:perf_hooks");

const INPUT_DEADLINE_MS = 4;
const OUTPUT_DEADLINE_MS = 50;
const MAX_CHUNK_BYTES = 64 * 1024;
const OUTPUT_WINDOW_BYTES = 256 * 1024;
const PROMPT_TAIL_CHARS = 2_048;
const SENSITIVE_LABELS = [
  "pass(?:word|phrase|code)", "passwd", "one[\\s-]?time", "otp", "verification",
  "authentication", "security[\\s-]+(?:code|token|passcode|pin)", "\\bpin\\b",
  "\\btoken\\b", "2fa", "two[\\s-]?factor", "multi[\\s-]?factor", "\\bmfa\\b",
  "second[\\s-]+factor", "secondary", "re[\\s-]?enter", "confirm", "\\bedr\\b",
  "\\bduo\\b", "密码", "密碼", "口令", "动态", "動態", "一次性", "验证码",
  "驗證碼", "验证信息", "驗證資訊", "令牌", "双因素", "雙因素", "多因素",
  "短信验证", "簡訊驗證", "手机验证", "手機驗證", "二次", "安全密码", "安全密碼",
  "挑战码", "挑戰碼", "парол",
].join("|");
const SENSITIVE_PROMPT = new RegExp(
  `(?:${SENSITIVE_LABELS})[^\\r\\n]{0,160}[:：?>›»]?\\s*$`,
  "iu",
);

function messageData(value) {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

function addPortListener(port, listener) {
  if (typeof port.addEventListener === "function") {
    port.addEventListener("message", listener);
    port.start?.();
    return () => port.removeEventListener?.("message", listener);
  }
  port.on?.("message", listener);
  port.start?.();
  return () => port.off?.("message", listener) ?? port.removeListener?.("message", listener);
}

function toTransferBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function visibleTerminalTail(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(-PROMPT_TAIL_CHARS);
}

function createTerminalDataPipeline(options = {}) {
  const encoder = options.encoder ?? new TextEncoder();
  const decoder = options.decoder ?? new TextDecoder("utf-8", { fatal: true });
  const now = options.now ?? (() => performance.now());
  const onWarning = options.onWarning ?? (() => {});
  const inputDeadlineMs = options.inputDeadlineMs ?? INPUT_DEADLINE_MS;
  const outputDeadlineMs = options.outputDeadlineMs ?? OUTPUT_DEADLINE_MS;
  const outputWindowBytes = options.outputWindowBytes ?? OUTPUT_WINDOW_BYTES;
  const bindings = new Map();
  const outputModes = new Map();
  const outputRawTails = new Map();
  const sensitiveInputSessions = new Set();

  const keyOf = (sessionId, direction) => `${sessionId}\0${direction}`;

  function refreshOutputMode(sessionId) {
    const input = bindings.has(keyOf(sessionId, "input"));
    const output = bindings.has(keyOf(sessionId, "output"));
    const mode = (input ? 1 : 0) | (output ? 2 : 0);
    if (mode) outputModes.set(sessionId, mode);
    else outputModes.delete(sessionId);
    if (!mode) {
      outputRawTails.delete(sessionId);
      sensitiveInputSessions.delete(sessionId);
    } else if (!input) {
      sensitiveInputSessions.delete(sessionId);
    }
  }

  function warn(binding, code, message) {
    try {
      onWarning(Object.freeze({
        sessionId: binding.sessionId,
        direction: binding.direction,
        providerId: binding.providerId,
        pluginId: binding.pluginId,
        pluginVersion: binding.pluginVersion,
        runtimeId: binding.runtimeId,
        runtimeKind: binding.runtimeKind,
        securityPrincipal: binding.securityPrincipal,
        code,
        message,
      }));
    } catch {}
  }

  function disable(binding, code, message) {
    if (!binding.active) return;
    binding.active = false;
    bindings.delete(keyOf(binding.sessionId, binding.direction));
    refreshOutputMode(binding.sessionId);
    binding.removeListener?.();
    for (const pending of binding.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    binding.pending.clear();
    try { binding.port.close?.(); } catch {}
    if (!["detached", "replaced", "shutdown", "session-closed"].includes(code)) {
      warn(binding, code, message);
    }
  }

  function attach(descriptor, port) {
    const sessionId = typeof descriptor?.sessionId === "string" ? descriptor.sessionId : "";
    const direction = descriptor?.direction;
    const identityFields = [
      descriptor?.pluginId,
      descriptor?.pluginVersion,
      descriptor?.runtimeId,
      descriptor?.securityPrincipal,
      descriptor?.providerId,
    ];
    if (!sessionId || sessionId.length > 256
      || (direction !== "input" && direction !== "output")
      || descriptor?.runtimeKind !== "utility"
      || identityFields.some((value) => typeof value !== "string" || value.length < 1 || value.length > 512)
      || !port?.postMessage) {
      throw new TypeError("Terminal interceptor attachment is invalid");
    }
    const key = keyOf(sessionId, direction);
    const previous = bindings.get(key);
    if (previous) disable(previous, "replaced", "Terminal interceptor was replaced for this session");
    const binding = {
      sessionId,
      direction,
      providerId: String(descriptor.providerId ?? ""),
      pluginId: String(descriptor.pluginId ?? ""),
      pluginVersion: descriptor.pluginVersion,
      runtimeId: descriptor.runtimeId,
      runtimeKind: descriptor.runtimeKind,
      securityPrincipal: descriptor.securityPrincipal,
      port,
      active: true,
      nextSequence: 1,
      pending: new Map(),
      queuedBytes: 0,
      queue: Promise.resolve(),
      removeListener: null,
    };
    binding.removeListener = addPortListener(port, (event) => {
      const message = messageData(event);
      if (!message || message.type !== "netcatty:terminal-interceptor:result") return;
      const pending = binding.pending.get(message.sequence);
      if (!pending) return;
      binding.pending.delete(message.sequence);
      clearTimeout(pending.timer);
      if (now() - pending.startedAt >= pending.deadlineMs) {
        pending.resolve(null);
        disable(binding, "timeout", `Terminal ${binding.direction} interceptor exceeded its ${pending.deadlineMs} ms budget`);
        return;
      }
      if (message.status !== "ok" || message.creditBytes !== pending.sentBytes
        || !(message.data instanceof ArrayBuffer)
        || message.data.byteLength > MAX_CHUNK_BYTES) {
        pending.resolve(null);
        disable(binding, "protocol", "Terminal interceptor returned an invalid response and was disabled");
        return;
      }
      pending.resolve(new Uint8Array(message.data));
    });
    port.on?.("close", () => disable(binding, "closed", "Terminal interceptor stopped and was disabled"));
    port.postMessage({
      type: "netcatty:terminal-interceptor:ready",
      sessionId,
      direction,
      windowBytes: direction === "output" ? outputWindowBytes : MAX_CHUNK_BYTES,
    });
    bindings.set(key, binding);
    refreshOutputMode(sessionId);
  }

  function detach(sessionId, direction, reason = "detached") {
    const directions = direction ? [direction] : ["input", "output"];
    for (const item of directions) {
      const binding = bindings.get(keyOf(sessionId, item));
      if (binding) disable(binding, reason, "Terminal interceptor was detached from this session");
    }
  }

  function requestChunk(binding, bytes, deadlineMs) {
    if (!binding.active) return Promise.resolve(null);
    const sequence = binding.nextSequence++;
    const data = toTransferBuffer(bytes);
    return new Promise((resolve) => {
      const startedAt = now();
      const timer = setTimeout(() => {
        binding.pending.delete(sequence);
        resolve(null);
        disable(binding, "timeout", `Terminal ${binding.direction} interceptor exceeded its ${deadlineMs} ms budget`);
      }, deadlineMs);
      binding.pending.set(sequence, {
        resolve,
        timer,
        startedAt,
        deadlineMs,
        sentBytes: bytes.byteLength,
      });
      try {
        binding.port.postMessage({
          type: "netcatty:terminal-interceptor:chunk",
          sequence,
          direction: binding.direction,
          creditBytes: binding.direction === "output"
            ? Math.max(0, outputWindowBytes - binding.queuedBytes)
            : MAX_CHUNK_BYTES,
          data,
        }, [data]);
      } catch {
        clearTimeout(timer);
        binding.pending.delete(sequence);
        resolve(null);
        disable(binding, "closed", "Terminal interceptor transport failed and was disabled");
      }
    });
  }

  function observeOutput(sessionId, data) {
    const mode = outputModes.get(sessionId) ?? 0;
    let sensitivePrompt = false;
    if (mode !== 0) {
      // Retain bounded raw output so an ANSI sequence split across chunks can
      // be stripped only after its terminating byte arrives. Persisting the
      // already-stripped tail would turn an incomplete CSI into visible text
      // and could split a password label such as "Pass\x1b[0" + "mword:".
      const rawTail = `${outputRawTails.get(sessionId) ?? ""}${data}`
        .slice(-(PROMPT_TAIL_CHARS * 2));
      outputRawTails.set(sessionId, rawTail);
      const tail = visibleTerminalTail(rawTail);
      const lastLine = tail.split(/[\r\n]/u).at(-1) ?? "";
      sensitivePrompt = SENSITIVE_PROMPT.test(lastLine);
      if ((mode & 1) !== 0 && sensitivePrompt) sensitiveInputSessions.add(sessionId);
    }
    return (mode & 1) !== 0 ? sensitiveInputSessions.has(sessionId) : sensitivePrompt;
  }

  async function transform(sessionId, direction, data, options = {}) {
    const binding = bindings.get(keyOf(sessionId, direction));
    if (!binding?.active) {
      return data;
    }
    const hostSensitive = direction === "input" && sensitiveInputSessions.has(sessionId);
    if (options.bypass === true || (direction === "input" && options.sensitive === true) || hostSensitive) {
      const finishPassthrough = () => {
        if (hostSensitive && /[\r\n]/u.test(String(data))) {
          sensitiveInputSessions.delete(sessionId);
          outputRawTails.delete(sessionId);
        }
        return data;
      };
      const passthrough = binding.queue.then(finishPassthrough, finishPassthrough);
      binding.queue = passthrough.then(() => undefined, () => undefined);
      return passthrough;
    }
    const bytes = encoder.encode(String(data));
    if (bytes.byteLength === 0) return data;
    if (direction === "output" && binding.queuedBytes + bytes.byteLength > outputWindowBytes) {
      // Chain the fail-open chunk behind all earlier work before disabling the
      // binding. disable() releases pending requests, and this queue barrier
      // ensures callers cannot deliver the newer chunk first.
      const passthrough = binding.queue.then(() => data, () => data);
      binding.queue = passthrough.then(() => undefined, () => undefined);
      disable(binding, "backpressure", "Terminal output interceptor exceeded its bounded credit window");
      return passthrough;
    }
    binding.queuedBytes += bytes.byteLength;
    const run = async () => {
      const output = [];
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
        if (!binding.active) return data;
        const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_CHUNK_BYTES));
        const result = await requestChunk(
          binding,
          chunk,
          direction === "input" ? inputDeadlineMs : outputDeadlineMs,
        );
        if (!result) return data;
        output.push(result);
      }
      try {
        const total = output.reduce((sum, item) => sum + item.byteLength, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const item of output) {
          combined.set(item, offset);
          offset += item.byteLength;
        }
        return decoder.decode(combined);
      } catch {
        disable(binding, "encoding", "Terminal interceptor returned invalid UTF-8 and was disabled");
        return data;
      }
    };
    const result = binding.queue.then(run, run);
    binding.queue = result.then(() => undefined, () => undefined);
    try { return await result; }
    finally { binding.queuedBytes = Math.max(0, binding.queuedBytes - bytes.byteLength); }
  }

  return Object.freeze({
    attach,
    detach,
    interceptInput: (sessionId, data, options) => transform(sessionId, "input", data, options),
    interceptOutput: (sessionId, data, options) => transform(sessionId, "output", data, options),
    has: (sessionId, direction) => bindings.has(keyOf(sessionId, direction)),
    getOutputMode: (sessionId) => outputModes.get(sessionId) ?? 0,
    observeOutput,
    shutdown() {
      for (const binding of [...bindings.values()]) disable(binding, "shutdown", "Terminal interceptor stopped");
    },
  });
}

module.exports = {
  INPUT_DEADLINE_MS,
  MAX_CHUNK_BYTES,
  OUTPUT_DEADLINE_MS,
  OUTPUT_WINDOW_BYTES,
  visibleTerminalTail,
  createTerminalDataPipeline,
};
