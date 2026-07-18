"use strict";

const {
  PLUGIN_RPC_MAX_PENDING,
} = require("./constants.cjs");
const { assertStreamFrameSchema } = require("./contractValidator.cjs");

let contractRuntimePromise;
function loadContractRuntime() {
  contractRuntimePromise ??= import("@netcatty/plugin-contract");
  return contractRuntimePromise;
}

function getTransferredBuffer(envelope) {
  return envelope && Object.prototype.hasOwnProperty.call(envelope, "transfer")
    ? envelope.transfer
    : undefined;
}

function assertStreamEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("Invalid plugin stream envelope");
  }
  const keys = Reflect.ownKeys(envelope);
  if (keys.some((key) => typeof key !== "string" || (key !== "frame" && key !== "transfer"))) {
    throw new TypeError("Plugin stream envelope contains unknown properties");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Plugin stream envelope must contain enumerable data properties");
    }
  }
  if (!Object.hasOwn(envelope, "frame")) throw new TypeError("Plugin stream envelope is missing its frame");
  return envelope;
}

class PluginStreamRouter {
  constructor(options) {
    this.send = options.send;
    this.onIncomingStream = options.onIncomingStream ?? (() => false);
    this.incoming = new Map();
    this.outgoing = new Map();
    this.maxStreams = options.maxStreams ?? PLUGIN_RPC_MAX_PENDING;
    this.closed = false;
  }

  async accept(rawEnvelope) {
    if (this.closed) throw new Error("Plugin stream router is closed");
    assertStreamEnvelopeShape(rawEnvelope);
    assertStreamFrameSchema(rawEnvelope.frame);
    const contract = await loadContractRuntime();
    const envelope = contract.createMessagePortStreamEnvelope(
      rawEnvelope.frame,
      getTransferredBuffer(rawEnvelope),
    );
    const frame = envelope.frame;
    if (frame.kind === "open") {
      if (
        this.incoming.has(frame.streamId)
        || this.outgoing.has(frame.streamId)
        || this.incoming.size + this.outgoing.size >= this.maxStreams
      ) {
        throw new Error(`Plugin stream cannot be opened: ${frame.streamId}`);
      }
      const state = {
        streamId: frame.streamId,
        nextSequence: 1,
        availableBytes: frame.windowBytes,
        updateSequence: -1,
        closed: false,
      };
      this.incoming.set(frame.streamId, state);
      const accepted = await this.onIncomingStream({
        streamId: frame.streamId,
        windowBytes: frame.windowBytes,
        cancel: () => this.#cancelIncoming(state),
      });
      if (accepted === false) await this.#cancelIncoming(state);
      return;
    }
    if (frame.kind === "windowUpdate") {
      const outgoing = this.outgoing.get(frame.streamId);
      if (!outgoing || outgoing.closed) throw new Error(`Unknown outgoing plugin stream: ${frame.streamId}`);
      if (frame.sequence !== outgoing.lastUpdateSequence + 1) {
        throw new Error(`Out-of-order stream credit update: ${frame.streamId}`);
      }
      outgoing.lastUpdateSequence = frame.sequence;
      outgoing.availableBytes += frame.creditBytes;
      if (outgoing.availableBytes > outgoing.maxCreditBytes) {
        throw new Error(`Plugin stream credit exceeds its negotiated window: ${frame.streamId}`);
      }
      this.#flushOutgoing(outgoing);
      return;
    }
    if (frame.kind === "cancel" && this.outgoing.has(frame.streamId)) {
      const outgoing = this.outgoing.get(frame.streamId);
      if (frame.sequence !== Math.max(1, outgoing.lastUpdateSequence + 1)) {
        throw new Error(`Out-of-order stream cancellation: ${frame.streamId}`);
      }
      outgoing.closed = true;
      this.outgoing.delete(frame.streamId);
      for (const pending of outgoing.queue) pending.reject(new Error(`Plugin stream cancelled: ${frame.streamId}`));
      outgoing.queue.length = 0;
      return;
    }
    const state = this.incoming.get(frame.streamId);
    if (!state || state.closed) throw new Error(`Unknown incoming plugin stream: ${frame.streamId}`);
    if (frame.sequence !== state.nextSequence) {
      throw new Error(`Out-of-order plugin stream frame: ${frame.streamId}`);
    }
    state.nextSequence += 1;
    if (frame.kind === "chunk") {
      const creditBytes = frame.data.byteLength;
      if (creditBytes > state.availableBytes) {
        throw new Error(`Plugin stream exceeded receive credit: ${frame.streamId}`);
      }
      state.availableBytes -= creditBytes;
      const materialized = contract.materializeStreamChunk(frame.data, envelope.transfer);
      const listener = state.onChunk;
      if (!listener) {
        await this.#cancelIncoming(state);
        return;
      }
      let released = false;
      const release = () => {
        if (released || state.closed) return;
        released = true;
        state.availableBytes += creditBytes;
        state.updateSequence += 1;
        this.send({
          frame: {
            streamId: state.streamId,
            sequence: state.updateSequence,
            kind: "windowUpdate",
            creditBytes,
          },
        });
      };
      await listener(materialized, release);
      return;
    }
    state.closed = true;
    this.incoming.delete(frame.streamId);
    state.onClose?.(frame.kind === "error" ? frame.error : frame.kind);
  }

  bindIncoming(streamId, handlers) {
    const state = this.incoming.get(streamId);
    if (!state || state.closed) throw new Error(`Unknown incoming plugin stream: ${streamId}`);
    state.onChunk = handlers.onChunk;
    state.onClose = handlers.onClose;
  }

  async openOutgoing(streamId, windowBytes) {
    if (
      this.closed
      || this.outgoing.has(streamId)
      || this.incoming.has(streamId)
      || this.incoming.size + this.outgoing.size >= this.maxStreams
    ) {
      throw new Error(`Plugin stream cannot be opened: ${streamId}`);
    }
    const contract = await loadContractRuntime();
    const envelope = contract.createMessagePortStreamEnvelope({
      streamId,
      sequence: 0,
      kind: "open",
      windowBytes,
    });
    const state = {
      streamId,
      nextSequence: 1,
      availableBytes: windowBytes,
      maxCreditBytes: windowBytes,
      lastUpdateSequence: -1,
      contract,
      queue: [],
      queuedBytes: 0,
      closed: false,
    };
    this.outgoing.set(streamId, state);
    this.send(envelope);
    return {
      write: (data) => this.#queueOutgoing(state, data),
      end: () => this.#endOutgoing(state),
      cancel: () => this.#cancelOutgoing(state),
    };
  }

  async #queueOutgoing(state, data) {
    if (state.closed) throw new Error(`Plugin stream is closed: ${state.streamId}`);
    const contract = await loadContractRuntime();
    let chunk;
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      const buffer = copy.buffer;
      chunk = { encoding: "transfer", byteLength: buffer.byteLength, transfer: buffer };
    } else {
      chunk = { ...contract.createJsonStreamChunk(data), transfer: undefined };
    }
    if (state.queuedBytes + chunk.byteLength > state.maxCreditBytes) {
      throw new Error(`Plugin stream pending queue exceeds its negotiated window: ${state.streamId}`);
    }
    return new Promise((resolve, reject) => {
      state.queue.push({ chunk, resolve, reject });
      state.queuedBytes += chunk.byteLength;
      this.#flushOutgoing(state);
    });
  }

  #flushOutgoing(state) {
    while (!state.closed && state.queue.length > 0) {
      const pending = state.queue[0];
      if (pending.chunk.byteLength > state.availableBytes) break;
      state.queue.shift();
      state.queuedBytes -= pending.chunk.byteLength;
      state.availableBytes -= pending.chunk.byteLength;
      const frame = {
        streamId: state.streamId,
        sequence: state.nextSequence,
        kind: "chunk",
        data: pending.chunk.encoding === "transfer"
          ? { encoding: "transfer", byteLength: pending.chunk.byteLength }
          : pending.chunk,
      };
      state.nextSequence += 1;
      const envelope = state.contract.createMessagePortStreamEnvelope(frame, pending.chunk.transfer);
      this.send(envelope, pending.chunk.transfer ? [pending.chunk.transfer] : []);
      pending.resolve();
    }
  }

  #finishOutgoing(state, kind) {
    if (state.closed) return;
    state.closed = true;
    this.outgoing.delete(state.streamId);
    this.send(state.contract.createMessagePortStreamEnvelope({
      streamId: state.streamId,
      sequence: state.nextSequence,
      kind,
    }));
    for (const pending of state.queue) pending.reject(new Error(`Plugin stream ${kind}`));
    state.queue.length = 0;
  }

  #endOutgoing(state) {
    if (state.queue.length > 0) throw new Error("Cannot end a plugin stream with pending backpressure");
    this.#finishOutgoing(state, "end");
  }

  #cancelOutgoing(state) {
    this.#finishOutgoing(state, "cancel");
  }

  async #cancelIncoming(state) {
    if (state.closed) return;
    state.closed = true;
    this.incoming.delete(state.streamId);
    state.updateSequence = Math.max(1, state.updateSequence + 1);
    this.send({ frame: { streamId: state.streamId, sequence: state.updateSequence, kind: "cancel" } });
  }

  close(error = new Error("Plugin runtime closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.outgoing.values()) {
      state.closed = true;
      for (const pending of state.queue) pending.reject(error);
    }
    this.outgoing.clear();
    this.incoming.clear();
  }
}

module.exports = { PluginStreamRouter, assertStreamEnvelopeShape };
