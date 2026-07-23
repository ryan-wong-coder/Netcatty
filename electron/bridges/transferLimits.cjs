"use strict";

// Keep ssh2's default 32KB request size. Some SFTP servers mishandle larger
// requests and can silently produce truncated/corrupt files (GitHub #2022).
const TRANSFER_CHUNK_SIZE = 32 * 1024;

// Upload fanout: 8 parallel 32KB requests (~256KB in flight). Higher than the
// previous 4 to help high-latency paths, still far below download fanout so
// interactive terminal traffic is not starved (GitHub #1507).
const UPLOAD_TRANSFER_CONCURRENCY = 8;

// Downloads need a larger request window on high-latency proxy paths. 64 is
// ssh2's fastGet default and, with the safe 32KB request size, restores the 2MB
// in-flight window Netcatty used before the shared chunk-size fix in #2030.
const DOWNLOAD_TRANSFER_CONCURRENCY = 64;
// Only one file per SFTP session gets the 64-request fast path. Concurrent
// files keep moving through the compatible stream path instead of multiplying
// fastGet pressure or overriding the user's file-transfer concurrency.
// (FileZilla/WinSCP-style multi-file parallelism is handled by the per-host
// file admission queue above this layer.)
const FAST_DOWNLOAD_CHANNELS_PER_SESSION = 1;

module.exports = {
  DOWNLOAD_TRANSFER_CONCURRENCY,
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
};
