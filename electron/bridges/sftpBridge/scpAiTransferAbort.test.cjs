/**
 * Drive the shipped downloadSftpToLocal / uploadLocalToSftp SCP branches with
 * AbortSignal — the AI/MCP transfer path must cancel mid-flight, not only
 * throwIfAborted before/after.
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const sftpBridge = require("../sftpBridge.cjs");
const { createScpBackend } = require("./scpBackend.cjs");

function createMockStream() {
  const ee = new EventEmitter();
  ee.writable = true;
  ee.readable = true;
  ee.stderr = new EventEmitter();
  ee.write = (buf, cb) => {
    if (typeof cb === "function") cb();
    return true;
  };
  ee.end = (cb) => { if (typeof cb === "function") cb(); };
  ee.close = () => ee.emit("close");
  ee.destroy = () => ee.emit("close");
  return ee;
}

describe("AI/MCP SCP transfer abort on shipped download/upload entry points", () => {
  let tmpDir;
  let sftpClients;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-ai-abort-"));
    sftpClients = new Map();
    sftpBridge.init({
      electronModule: {},
      sessions: new Map(),
      sftpClients,
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function registerScpClient(id, { hangOnStream = true } = {}) {
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        if (!hangOnStream) {
          // ready ACK immediately for success paths (not used in abort tests)
          setImmediate(() => stream.emit("data", Buffer.from([0])));
        }
        // hang: never ACK so waitForAck blocks until cancel
        return stream;
      },
    });
    const client = {
      client: { exec: () => {} },
      sftp: null,
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
      async end() {},
    };
    sftpClients.set(id, client);
    return client;
  }

  it("downloadSftpToLocal rejects when AbortSignal fires mid-SCP download", async () => {
    registerScpClient("scp-dl");
    const controller = new AbortController();
    const localPath = path.join(tmpDir, "out.bin");
    const promise = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-dl",
      remotePath: "/remote/file.bin",
      localPath,
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await assert.rejects(() => promise, /cancel|abort/i);
  });

  it("uploadLocalToSftp rejects when AbortSignal fires mid-SCP upload", async () => {
    registerScpClient("scp-up");
    const localPath = path.join(tmpDir, "in.bin");
    fs.writeFileSync(localPath, Buffer.alloc(256, 9));
    const controller = new AbortController();
    const promise = sftpBridge.uploadLocalToSftp(null, {
      sftpId: "scp-up",
      localPath,
      remotePath: "/remote/in.bin",
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await assert.rejects(() => promise, /cancel|abort/i);
  });

  it("source wires createTransferFromAbortSignal (not a dead cancelledFlag getter)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../sftpBridge.cjs"), "utf8");
    assert.match(src, /createTransferFromAbortSignal/);
    assert.doesNotMatch(src, /cancelledFlag/);
    // Both AI transfer entry points must pass transfer into the backend
    const dlIdx = src.indexOf("async function downloadSftpToLocal");
    const upIdx = src.indexOf("async function uploadLocalToSftp");
    const dlBlock = src.slice(dlIdx, upIdx);
    const upBlock = src.slice(upIdx, src.indexOf("function sendSftpProgress", upIdx));
    assert.match(dlBlock, /createTransferFromAbortSignal\(payload\.abortSignal\)/);
    assert.match(upBlock, /createTransferFromAbortSignal\(payload\.abortSignal\)/);
    assert.match(dlBlock, /transfer,/);
    assert.match(upBlock, /transfer,/);
    assert.doesNotMatch(upBlock, /transfer:\s*null/);
  });
});
