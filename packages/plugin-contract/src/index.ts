export const PLUGIN_API_VERSION = "0.1.0-internal" as const;
export const PLUGIN_MANIFEST_FILE = "netcatty.plugin.json" as const;
export const PLUGIN_PACKAGE_EXTENSION = ".ncpkg" as const;

export type * from "./generated/plugin-contract.js";
export {
  PLUGIN_JSON_MAX_DEPTH,
  PLUGIN_JSON_MAX_NODES,
  assertJsonValue,
  serializeJsonValue,
} from "./jsonValue.js";
export {
  PLUGIN_RPC_ERROR_CODES,
  PLUGIN_RPC_MAX_JSON_BYTES,
  PLUGIN_WIRE_MAX_SAFE_INTEGER,
} from "./generated/plugin-contract-limits.js";
export {
  COMPANION_STDIO_MAX_CONTENT_BYTES,
  COMPANION_STDIO_MAX_HEADER_BYTES,
  ContentLengthFrameDecoder,
  encodeContentLengthFrame,
  type ContentLengthFrameDecoderOptions,
} from "./stdioFraming.js";
export {
  PLUGIN_STREAM_MAX_CHUNK_BYTES,
  PLUGIN_STREAM_MAX_CREDIT_BYTES,
  PLUGIN_STREAM_MAX_FRAME_JSON_BYTES,
  PLUGIN_STREAM_MAX_ID_LENGTH,
  PLUGIN_STREAM_MAX_WINDOW_BYTES,
  PLUGIN_STREAM_MIN_WINDOW_BYTES,
  assertStreamChunkData,
  assertStreamFrame,
  createBase64StreamChunk,
  createJsonStreamChunk,
  createMessagePortStreamEnvelope,
  materializeStreamChunk,
  type MaterializedStreamChunk,
  type MessagePortStreamEnvelope,
} from "./streamTransport.js";
