"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createScpBackend, createTransferFromAbortSignal } = require("./scpBackend.cjs");
const {
  buildFileControlLine,
  buildAck,
  SCP_OK,
} = require("./scpProtocol.cjs");

function createMockStream() {
  const ee = new EventEmitter();
  ee.writable = true;
  ee.readable = true;
  ee.stderr = new EventEmitter();
  ee._chunks = [];
  ee.write = (buf, cb) => {
    ee._chunks.push(Buffer.from(buf));
    ee.emit("_write", Buffer.from(buf));
    if (typeof cb === "function") cb();
    return true;
  };
  ee.end = (cb) => {
    ee.emit("end");
    if (typeof cb === "function") cb();
  };
  ee.close = () => {
    ee.emit("close");
  };
  ee.destroy = () => {
    ee.emit("close");
  };
  ee.pushFromRemote = (buf) => {
    ee.emit("data", Buffer.from(buf));
  };
  return ee;
}

describe("scpBackend browse/manage with fake exec", () => {
  let commands;
  let backend;

  beforeEach(() => {
    commands = [];
    backend = createScpBackend({
      exec: async (command) => {
        commands.push({ type: "exec", command });
        if (command.includes("mkdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("rm ") || command.includes("rmdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("mv ")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("chmod ")) return { stdout: "", stderr: "", code: 0 };
        if (command.startsWith("printf") || command.includes("$HOME")) {
          return { stdout: "/home/test\n", stderr: "", code: 0 };
        }
        if (command.includes("for f in")) {
          const name = Buffer.from("readme.txt").toString("base64");
          const dir = Buffer.from("docs").toString("base64");
          return {
            stdout: `f|-rw-r--r--|5|1700000000|${name}\nd|drwxr-xr-x|0|1700000001|${dir}\n`,
            stderr: "",
            code: 0,
          };
        }
        if (command.includes("wc -c") || command.includes("if [ ! -e")) {
          // stat command
          return {
            stdout: "f|-rw-r--r--|5|1700000000|/home/test/readme.txt\n",
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        commands.push({ type: "execStream", command });
        const stream = createMockStream();
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          const text = buf.toString("utf8");
          if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          }
        });
        return stream;
      },
    });
  });

  it("lists directory entries via shell", async () => {
    const entries = await backend.list("/home/test");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "readme.txt");
    assert.equal(entries[0].type, "file");
    assert.equal(entries[1].name, "docs");
    assert.equal(entries[1].type, "directory");
    assert.ok(commands.some((c) => c.command.includes("cd '/home/test'")));
  });

  it("resolves symlink linkTarget so directory links are navigable", async () => {
    backend = createScpBackend({
      exec: async (command) => {
        commands.push({ type: "exec", command });
        if (command.includes("for f in") || command.includes("cd ")) {
          const link = Buffer.from("shared").toString("base64");
          const fileLink = Buffer.from("alias.txt").toString("base64");
          return {
            stdout:
              `l|lrwxrwxrwx|0|1700000000|${link}\n` +
              `l|lrwxrwxrwx|0|1700000000|${fileLink}\n`,
            stderr: "",
            code: 0,
          };
        }
        // resolveSymlinkTargetType probes
        if (command.includes("/home/test/shared") || command.includes("shared")) {
          if (command.includes('echo directory') || command.includes("[ -d")) {
            return { stdout: "directory\n", stderr: "", code: 0 };
          }
        }
        if (command.includes("alias.txt")) {
          return { stdout: "file\n", stderr: "", code: 0 };
        }
        return { stdout: "file\n", stderr: "", code: 0 };
      },
      execStream: async () => createMockStream(),
    });
    const entries = await backend.list("/home/test");
    assert.equal(entries.length, 2);
    const shared = entries.find((e) => e.name === "shared");
    const alias = entries.find((e) => e.name === "alias.txt");
    assert.equal(shared?.type, "symlink");
    assert.equal(shared?.linkTarget, "directory");
    assert.equal(alias?.type, "symlink");
    assert.equal(alias?.linkTarget, "file");
  });

  it("mkdir rename delete and chmod issue quoted shell commands", async () => {
    await backend.mkdir("/tmp/a b/c");
    await backend.rename("/tmp/a b/c", "/tmp/a b/d");
    await backend.remove("/tmp/a b/d", { recursive: true });
    await backend.chmod("/tmp/file", "644");
    assert.ok(commands.some((c) => c.command.includes("mkdir -p -- '/tmp/a b/c'")));
    assert.ok(commands.some((c) => c.command.includes("mv -- '/tmp/a b/c' '/tmp/a b/d'")));
    assert.ok(commands.some((c) => c.command.includes("rm -rf -- '/tmp/a b/d'")));
    assert.ok(commands.some((c) => c.command.includes("chmod 644 -- '/tmp/file'")));
  });

  it("stats a remote path", async () => {
    const st = await backend.stat("/home/test/readme.txt");
    assert.equal(st.size, 5);
    assert.equal(st.isDirectory, false);
  });

  it("resolves home directory", async () => {
    const home = await backend.homeDir();
    assert.equal(home, "/home/test");
  });
});

describe("scpBackend upload/download with fake scp streams", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("uploads a local file through scp -t handshake and reports progress", async () => {
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "hello-scp");
    const written = [];
    let progressCalls = [];

    const backend = createScpBackend({
      exec: async (command) => {
        if (command.includes("mkdir")) return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        assert.match(command, /scp -t -- /);
        const stream = createMockStream();
        // Delay ready ACK until after waitForAck attaches (setImmediate > microtask).
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          written.push(Buffer.from(buf));
          const text = buf.toString("utf8");
          // ACK after control line and after trailing NUL
          if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          }
        });
        return stream;
      },
    });

    const transfer = { cancelled: false, abort: null };
    await backend.uploadFile(localFile, "/remote/dir/local.txt", {
      transfer,
      onProgress: (t, total) => progressCalls.push([t, total]),
    });

    const joined = Buffer.concat(written).toString("utf8");
    assert.match(joined, /C0[0-7]{3} 9 local\.txt\n/);
    assert.ok(joined.includes("hello-scp"));
    assert.ok(progressCalls.length > 0);
    assert.equal(progressCalls[progressCalls.length - 1][0], 9);
  });

  it("downloads via scp -f parser into a local file", async () => {
    const localOut = path.join(tmpDir, "out.bin");
    const payload = Buffer.from("ABCD");
    const backend = createScpBackend({
      exec: async (command) => {
        if (command.includes("if [ ! -e")) {
          return { stdout: "f|-rw-r--r--|4|1700000000|/remote/x.bin\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        assert.match(command, /scp -f -- /);
        const stream = createMockStream();
        let ackCount = 0;
        stream.on("_write", (buf) => {
          if (!(buf[0] === SCP_OK && buf.length === 1)) return;
          ackCount += 1;
          if (ackCount === 1) {
            // Client ready → send control
            setImmediate(() => {
              stream.pushFromRemote(buildFileControlLine({ mode: 0o644, size: 4, name: "x.bin" }));
            });
          } else if (ackCount === 2) {
            // Client accepted control → send data + trailing NUL
            setImmediate(() => {
              stream.pushFromRemote(Buffer.concat([payload, Buffer.from([0x00])]));
            });
          }
        });
        return stream;
      },
    });

    const progress = [];
    await backend.downloadFile("/remote/x.bin", localOut, {
      fileSize: 4,
      onProgress: (t, total) => progress.push([t, total]),
    });
    assert.equal(fs.readFileSync(localOut).toString(), "ABCD");
    assert.ok(progress.length > 0);
  });

  it("cancel aborts an in-flight upload", async () => {
    const localFile = path.join(tmpDir, "big.bin");
    fs.writeFileSync(localFile, Buffer.alloc(1024, 7));

    const transfer = { cancelled: false, abort: null };
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        // Never send ACK — upload blocks in waitForAck until cancelled.
        return stream;
      },
    });

    const uploadPromise = backend.uploadFile(localFile, "/remote/big.bin", { transfer });
    await new Promise((r) => setTimeout(r, 30));
    transfer.cancelled = true;
    if (typeof transfer.abort === "function") transfer.abort();
    await assert.rejects(() => uploadPromise, /cancel/i);
  });

  it("AbortSignal via createTransferFromAbortSignal cancels in-flight upload (AI path)", async () => {
    const localFile = path.join(tmpDir, "sig.bin");
    fs.writeFileSync(localFile, Buffer.alloc(512, 1));
    const controller = new AbortController();
    const transfer = createTransferFromAbortSignal(controller.signal);
    assert.equal(transfer.cancelled, false);

    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => createMockStream(), // no ACK
    });

    const uploadPromise = backend.uploadFile(localFile, "/remote/sig.bin", { transfer });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    assert.equal(transfer.cancelled, true);
    await assert.rejects(() => uploadPromise, /cancel/i);
    transfer.detachAbortSignal?.();
  });

  it("createTransferFromAbortSignal marks already-aborted signals", () => {
    const controller = new AbortController();
    controller.abort();
    const transfer = createTransferFromAbortSignal(controller.signal);
    assert.equal(transfer.cancelled, true);
    assert.equal(createTransferFromAbortSignal(null), null);
  });
});
