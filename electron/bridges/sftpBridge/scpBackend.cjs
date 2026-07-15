/**
 * SCP-mode remote filesystem backend.
 * Browse/manage via carefully quoted shell; transfers via OpenSSH scp -t/-f protocol.
 *
 * The exec layer is injectible for unit tests:
 *   exec(command) -> Promise<{ stdout, stderr, code }>
 *   execStream(command) -> Promise<Duplex-like stream with write/on/close/end>
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildFileControlLine,
  buildAck,
  consumeAck,
  createSourceStreamParser,
  ScpProtocolError,
} = require("./scpProtocol.cjs");
const {
  shellQuote,
  assertSafeRemotePath,
  buildScpSinkCommand,
  buildScpSourceCommand,
  buildListCommand,
  buildListCommandLs,
  buildStatCommand,
  buildMkdirCommand,
  buildDeleteCommand,
  buildRenameCommand,
  buildChmodCommand,
  buildHomeCommand,
  buildRealpathCommand,
  parseListRecords,
  parseLsLaOutput,
  parseStatRecord,
  modeToPermissionsString,
  isScpModeClient,
  ScpShellError,
} = require("./scpShell.cjs");

/**
 * Bridge an AbortSignal to the transfer object used by SCP upload/download.
 * scpBackend only observes transfer.cancelled + transfer.abort(); signal.aborted
 * alone is never read mid-transfer.
 */
function createTransferFromAbortSignal(signal) {
  if (!signal) return null;
  const transfer = {
    cancelled: !!signal.aborted,
    abort: null,
  };
  const onAbort = () => {
    transfer.cancelled = true;
    try {
      if (typeof transfer.abort === "function") transfer.abort();
    } catch {
      // ignore abort hook failures
    }
  };
  if (signal.aborted) {
    transfer.cancelled = true;
  } else if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
    transfer.detachAbortSignal = () => {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    };
  }
  return transfer;
}

function createScpBackend(deps = {}) {
  const {
    exec,
    execStream,
    fsModule = fs,
    pathModule = path,
  } = deps;

  if (typeof exec !== "function") {
    throw new Error("scpBackend requires deps.exec(command)");
  }
  if (typeof execStream !== "function") {
    throw new Error("scpBackend requires deps.execStream(command)");
  }

  async function runOrThrow(command, { allowNonZero = false } = {}) {
    const result = await exec(command);
    if (!allowNonZero && result.code !== 0 && result.code != null) {
      const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.code}`;
      throw new ScpShellError(detail);
    }
    return result;
  }

  async function list(remotePath) {
    const dir = remotePath || ".";
    assertSafeRemotePath(dir === "." ? "." : dir);
    let records;
    try {
      const result = await runOrThrow(buildListCommand(dir), { allowNonZero: true });
      if (result.code === 0) {
        records = parseListRecords(result.stdout);
        if (records.length === 0 && (result.stdout || "").trim()) {
          records = null;
        }
      }
    } catch {
      records = null;
    }
    if (!records) {
      const ls = await runOrThrow(buildListCommandLs(dir));
      records = parseLsLaOutput(ls.stdout, { basePath: dir });
    }
    // Resolve symlink targets so UI can navigate directory links
    // (isNavigableDirectory requires linkTarget === "directory").
    const base = dir === "." ? "." : dir.replace(/\/+$/, "") || "/";
    const entries = [];
    for (const rec of records) {
      const entry = toListEntry(rec);
      if (rec.type === "symlink") {
        const fullPath = base === "/"
          ? `/${rec.name}`
          : base === "."
            ? rec.name
            : `${base}/${rec.name}`;
        entry.linkTarget = await resolveSymlinkTargetType(fullPath);
      }
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Follow a symlink with shell tests (same idea as SFTP client.stat following links).
   * `[ -d path ]` follows symlinks; combined with known-symlink listing.
   */
  async function resolveSymlinkTargetType(remotePath) {
    try {
      assertSafeRemotePath(remotePath);
      // -e fails for broken links; -d follows to the target.
      const cmd = [
        `p=${shellQuote(remotePath)}`,
        'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo broken; exit 0; fi',
        'if [ -d "$p" ]; then echo directory; else echo file; fi',
      ].join("; ");
      const result = await runOrThrow(cmd, { allowNonZero: true });
      const kind = (result.stdout || "").trim().split(/\r?\n/).pop();
      if (kind === "directory") return "directory";
      if (kind === "file") return "file";
      return null;
    } catch {
      return null;
    }
  }

  function toListEntry(rec) {
    const sizeNum = Number(rec.size) || 0;
    return {
      name: rec.name,
      type: rec.type,
      linkTarget: rec.type === "symlink" ? "file" : null,
      size: `${sizeNum} bytes`,
      lastModified: new Date(rec.modifyTime || Date.now()).toISOString(),
      permissions: rec.permissions,
      // raw fields for internal use
      _size: sizeNum,
      _modifyTime: rec.modifyTime,
    };
  }

  async function stat(remotePath) {
    const result = await runOrThrow(buildStatCommand(remotePath));
    return parseStatRecord(result.stdout);
  }

  async function mkdir(remotePath, options = {}) {
    await runOrThrow(buildMkdirCommand(remotePath, { recursive: options.recursive !== false }));
    return true;
  }

  async function remove(remotePath, options = {}) {
    let recursive = !!options.recursive;
    if (!recursive) {
      try {
        const st = await stat(remotePath);
        recursive = st.isDirectory;
      } catch {
        // best-effort delete
      }
    }
    await runOrThrow(buildDeleteCommand(remotePath, { recursive }));
    return true;
  }

  async function rename(oldPath, newPath) {
    await runOrThrow(buildRenameCommand(oldPath, newPath));
    return true;
  }

  async function chmod(remotePath, mode) {
    let modeStr;
    if (typeof mode === "number") {
      modeStr = (mode & 0o7777).toString(8);
    } else {
      modeStr = String(mode);
    }
    await runOrThrow(buildChmodCommand(remotePath, modeStr));
    return true;
  }

  async function homeDir() {
    const result = await runOrThrow(buildHomeCommand());
    const home = (result.stdout || "").trim();
    if (home) return home;
    throw new ScpShellError("Could not determine home directory");
  }

  async function realpath(remotePath) {
    const result = await runOrThrow(buildRealpathCommand(remotePath || "."));
    const abs = (result.stdout || "").trim().split(/\r?\n/)[0];
    if (!abs) throw new ScpShellError("Could not resolve remote path");
    return abs;
  }

  async function readFile(remotePath) {
    // Prefer scp -f for binary fidelity; also works when cat is restricted.
    const chunks = [];
    await downloadToWritable(remotePath, {
      write: (buf) => {
        chunks.push(Buffer.from(buf));
      },
      end: () => {},
    }, { fileSize: null, transfer: null, onProgress: null });
    return Buffer.concat(chunks);
  }

  async function writeFile(remotePath, content, options = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const tmpLocal = options.tempLocalPath;
    if (tmpLocal) {
      await fsModule.promises.writeFile(tmpLocal, buffer);
      try {
        await uploadFile(tmpLocal, remotePath, {
          fileSize: buffer.length,
          transfer: options.transfer || null,
          onProgress: options.onProgress || null,
          mode: options.mode,
        });
      } finally {
        try { await fsModule.promises.unlink(tmpLocal); } catch { /* ignore */ }
      }
      return true;
    }
    // Stream from memory via a temp-less path: write through scp sink using buffer
    await uploadBuffer(buffer, remotePath, {
      transfer: options.transfer || null,
      onProgress: options.onProgress || null,
      mode: options.mode || 0o0644,
    });
    return true;
  }

  async function uploadFile(localPath, remotePath, options = {}) {
    const st = await fsModule.promises.stat(localPath);
    const fileSize = Number.isFinite(options.fileSize) ? options.fileSize : st.size;
    const mode = options.mode != null ? options.mode : (st.mode & 0o777);
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;

    const remoteParent = pathModule.posix.dirname(remotePath) || ".";
    const baseName = pathModule.posix.basename(remotePath);
    assertSafeRemotePath(remoteParent === "." ? "." : remoteParent);
    assertSafeRemotePath(remotePath);

    // Ensure parent exists
    if (remoteParent && remoteParent !== ".") {
      await mkdir(remoteParent, { recursive: true });
    }

    const command = buildScpSinkCommand(remoteParent);
    const stream = await execStream(command);
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        abort();
        if (typeof prev === "function") prev();
      };
    }

    try {
      // Register for ACK before the remote can reply (and before we write).
      const readyAck = waitForAck(stream, transfer);
      await readyAck;

      const control = buildFileControlLine({ mode, size: fileSize, name: baseName });
      const afterControlAck = waitForAck(stream, transfer);
      await writeAll(stream, control);
      await afterControlAck;

      let transferred = 0;
      await new Promise((resolve, reject) => {
        const readStream = fsModule.createReadStream(localPath, { highWaterMark: 256 * 1024 });
        if (transfer) transfer.readStream = readStream;

        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          readStream.removeAllListeners();
          if (err) {
            try { readStream.destroy(); } catch { /* ignore */ }
            reject(err);
          } else {
            resolve();
          }
        };

        readStream.on("data", (chunk) => {
          if (transfer?.cancelled) {
            finish(new Error("Transfer cancelled"));
            return;
          }
          const ok = stream.write(chunk);
          transferred += chunk.length;
          if (typeof onProgress === "function") {
            onProgress(transferred, fileSize);
          }
          if (!ok) {
            readStream.pause();
            stream.once("drain", () => readStream.resume());
          }
        });
        readStream.on("error", finish);
        readStream.on("end", () => {
          // trailing NUL after file data
          stream.write(Buffer.from([0x00]));
          finish(null);
        });
        stream.on("error", finish);
      });

      await waitForAck(stream, transfer);
      await closeStream(stream);
      if (transfer?.cancelled) throw new Error("Transfer cancelled");
      if (typeof onProgress === "function") onProgress(fileSize, fileSize);
      return true;
    } catch (err) {
      abort();
      throw err;
    }
  }

  async function uploadBuffer(buffer, remotePath, options = {}) {
    const fileSize = buffer.length;
    const mode = options.mode != null ? options.mode : 0o0644;
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;
    const remoteParent = pathModule.posix.dirname(remotePath) || ".";
    const baseName = pathModule.posix.basename(remotePath);

    if (remoteParent && remoteParent !== ".") {
      await mkdir(remoteParent, { recursive: true });
    }

    const command = buildScpSinkCommand(remoteParent);
    const stream = await execStream(command);
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        abort();
        if (typeof prev === "function") prev();
      };
    }

    try {
      await waitForAck(stream, transfer);
      const afterControl = waitForAck(stream, transfer);
      await writeAll(stream, buildFileControlLine({ mode, size: fileSize, name: baseName }));
      await afterControl;

      const chunkSize = 256 * 1024;
      let offset = 0;
      while (offset < buffer.length) {
        if (transfer?.cancelled) throw new Error("Transfer cancelled");
        const end = Math.min(offset + chunkSize, buffer.length);
        await writeAll(stream, buffer.subarray(offset, end));
        offset = end;
        if (typeof onProgress === "function") onProgress(offset, fileSize);
      }
      const afterNul = waitForAck(stream, transfer);
      await writeAll(stream, Buffer.from([0x00]));
      await afterNul;
      await closeStream(stream);
      return true;
    } catch (err) {
      abort();
      throw err;
    }
  }

  async function downloadFile(remotePath, localPath, options = {}) {
    const transfer = options.transfer || null;
    const onProgress = options.onProgress || null;
    let fileSize = Number.isFinite(options.fileSize) ? options.fileSize : null;
    if (fileSize == null) {
      try {
        const st = await stat(remotePath);
        fileSize = st.size;
      } catch {
        fileSize = 0;
      }
    }

    await fsModule.promises.mkdir(pathModule.dirname(localPath), { recursive: true });
    const writeStream = fsModule.createWriteStream(localPath);
    if (transfer) transfer.writeStream = writeStream;

    try {
      await downloadToWritable(remotePath, writeStream, {
        fileSize,
        transfer,
        onProgress,
      });
      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });
      return true;
    } catch (err) {
      try { writeStream.destroy(); } catch { /* ignore */ }
      try { await fsModule.promises.unlink(localPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async function downloadToWritable(remotePath, writable, { fileSize, transfer, onProgress }) {
    assertSafeRemotePath(remotePath);
    const command = buildScpSourceCommand(remotePath);
    const stream = await execStream(command);
    const abort = () => {
      try { stream.close?.(); } catch { /* ignore */ }
      try { stream.destroy?.(); } catch { /* ignore */ }
    };
    if (transfer) {
      const prev = transfer.abort;
      transfer.abort = () => {
        abort();
        if (typeof prev === "function") prev();
      };
    }

    const parser = createSourceStreamParser();
    let transferred = 0;
    let expectedSize = fileSize;
    let gotFile = false;

    await writeAll(stream, buildAck());

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        stream.removeAllListeners();
        if (err) reject(err);
        else resolve();
      };

      stream.on("data", (chunk) => {
        if (transfer?.cancelled) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        try {
          const events = parser.feed(chunk);
          for (const ev of events) {
            if (ev.type === "file-start") {
              gotFile = true;
              expectedSize = ev.size;
              // ACK ready for data
              stream.write(buildAck());
            } else if (ev.type === "file-data") {
              writable.write(ev.data);
              transferred += ev.data.length;
              if (typeof onProgress === "function") {
                onProgress(transferred, expectedSize || transferred);
              }
            } else if (ev.type === "file-end") {
              stream.write(buildAck());
              if (typeof onProgress === "function") {
                onProgress(transferred, expectedSize || transferred);
              }
              // For single-file download we're done after first file
              finish(null);
              try { stream.close?.(); } catch { /* ignore */ }
              return;
            } else if (ev.type === "directory") {
              stream.write(buildAck());
            } else if (ev.type === "end-directory") {
              stream.write(buildAck());
            } else if (ev.type === "time") {
              stream.write(buildAck());
            }
          }
        } catch (err) {
          finish(err);
        }
      });
      stream.on("error", (err) => {
        if (transfer?.cancelled) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        finish(err);
      });
      stream.on("close", () => {
        if (settled) return;
        // Abort closes the stream; surface cancel rather than protocol incompleteness.
        if (transfer?.cancelled) {
          finish(new Error("Transfer cancelled"));
          return;
        }
        try {
          parser.finish();
        } catch (err) {
          finish(err);
          return;
        }
        if (!gotFile) {
          finish(new ScpProtocolError("SCP source closed without a file"));
          return;
        }
        finish(null);
      });
      stream.stderr?.on?.("data", () => {
        // ignore stderr chatter unless we fail
      });
    });

    if (transfer?.cancelled) throw new Error("Transfer cancelled");
  }

  function waitForAck(stream, transfer) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let settled = false;
      let poll = null;
      const onData = (chunk) => {
        if (settled) return;
        if (transfer?.cancelled) {
          cleanup();
          reject(new Error("Transfer cancelled"));
          return;
        }
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        const result = consumeAck(buf);
        if (result.status === "incomplete") return;
        cleanup();
        if (result.status === "ok") resolve();
        else reject(new ScpProtocolError(result.message || "SCP remote error", result.status));
      };
      const onError = (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      const onClose = () => {
        if (settled) return;
        cleanup();
        if (transfer?.cancelled) {
          reject(new Error("Transfer cancelled"));
          return;
        }
        reject(new ScpProtocolError("SCP stream closed while waiting for ACK"));
      };
      const cleanup = () => {
        settled = true;
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        stream.removeListener("data", onData);
        stream.removeListener("error", onError);
        stream.removeListener("close", onClose);
      };
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("close", onClose);
      // Poll cancel flag so aborts work even when the remote sends no bytes.
      if (transfer) {
        poll = setInterval(() => {
          if (transfer.cancelled) {
            cleanup();
            reject(new Error("Transfer cancelled"));
          }
        }, 25);
        if (typeof poll.unref === "function") poll.unref();
      }
    });
  }

  function writeAll(stream, buffer) {
    return new Promise((resolve, reject) => {
      if (!stream || typeof stream.write !== "function") {
        reject(new Error("Invalid SCP stream"));
        return;
      }
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      try {
        let invokedCallback = false;
        const ok = stream.write(buffer, (err) => {
          invokedCallback = true;
          done(err);
        });
        if (ok === false) {
          stream.once("drain", () => done());
          return;
        }
        // Some mocks ignore the write callback; resolve on next tick if still pending.
        queueMicrotask(() => {
          if (!settled && !invokedCallback) done();
        });
      } catch (err) {
        done(err);
      }
    });
  }

  function closeStream(stream) {
    return new Promise((resolve) => {
      try {
        if (typeof stream.end === "function") {
          stream.end(() => resolve());
          return;
        }
      } catch { /* ignore */ }
      try { stream.close?.(); } catch { /* ignore */ }
      resolve();
    });
  }

  return {
    list,
    stat,
    mkdir,
    remove,
    rename,
    chmod,
    homeDir,
    realpath,
    readFile,
    writeFile,
    uploadFile,
    uploadBuffer,
    downloadFile,
    downloadToWritable,
  };
}

/**
 * Build exec/execStream adapters from an ssh2 Client.
 */
function createSshExecAdapters(sshClient) {
  function exec(command) {
    return new Promise((resolve, reject) => {
      sshClient.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (d) => { stdout += d.toString(); });
        stream.stderr?.on("data", (d) => { stderr += d.toString(); });
        stream.on("close", (code) => resolve({ stdout, stderr, code }));
        stream.on("error", reject);
      });
    });
  }

  function execStream(command) {
    return new Promise((resolve, reject) => {
      sshClient.exec(command, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  return { exec, execStream };
}

/**
 * Get or create a cached SCP backend for a client object.
 */
function getScpBackendForClient(client) {
  if (!client) throw new Error("SFTP session not found");
  if (client.__netcattyScpBackend) return client.__netcattyScpBackend;
  const sshClient = client.client;
  if (!sshClient || typeof sshClient.exec !== "function") {
    throw new Error("SCP mode requires an SSH session with exec support");
  }
  const adapters = createSshExecAdapters(sshClient);
  const backend = createScpBackend(adapters);
  client.__netcattyScpBackend = backend;
  return backend;
}

module.exports = {
  createScpBackend,
  createSshExecAdapters,
  createTransferFromAbortSignal,
  getScpBackendForClient,
  isScpModeClient,
  shellQuote,
  modeToPermissionsString,
};
