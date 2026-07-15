const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadOpenConnectionWithSftpClient(SftpClient) {
  const openConnectionPath = require.resolve("./sftpBridge/openConnection.cjs");
  delete require.cache[openConnectionPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2-sftp-client") {
      return SftpClient;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[openConnectionPath];
    return require("./sftpBridge/openConnection.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function createReuseOnlyApi({ findReusableSession, createSessionBackedSftpClient, SftpClient }) {
  const { createOpenConnectionApi } = loadOpenConnectionWithSftpClient(SftpClient);
  return createOpenConnectionApi({
    sessions: new Map(),
    findReusableSession,
    acquireConnectionRef: () => {},
    createSessionBackedSftpClient,
    requireSftpChannel: async () => {},
    sendSftpProgress: () => {},
    sftpClients: new Map(),
    randomUUID: () => "conn-1",
    findAllDefaultPrivateKeysFromHelper: async () => [],
    getAvailableAgentSocket: async () => null,
    hasUsableProxy: () => false,
  });
}

test("openSftp with reuseOnly throws instead of dialing fresh when source is missing", async () => {
  let dialedFresh = false;
  class TrackingSftpClient {
    constructor() {
      dialedFresh = true;
    }
  }

  const api = createReuseOnlyApi({
    findReusableSession: () => null,
    createSessionBackedSftpClient: () => {
      throw new Error("should not create reused client");
    },
    SftpClient: TrackingSftpClient,
  });

  await assert.rejects(
    () => api.openSftp(
      { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
      {
        sessionId: "sftp-1",
        hostname: "example.test",
        username: "alice",
        port: 22,
        sourceSessionId: "missing",
        reuseOnly: true,
      },
    ),
    /not reusable/,
  );
  assert.equal(dialedFresh, false);
});

test("openSftp with reuseOnly does not require renderer endpoint to match", async () => {
  let requestedTarget;
  const source = {
    conn: { _sock: { destroyed: false } },
    connRef: { id: "ref-1" },
  };
  const reusedClient = {
    end: async () => {},
  };

  const api = createReuseOnlyApi({
    findReusableSession: (_sessions, sourceSessionId, target) => {
      assert.equal(sourceSessionId, "live-session");
      requestedTarget = target;
      return source;
    },
    createSessionBackedSftpClient: () => reusedClient,
    SftpClient: class {
      constructor() {
        throw new Error("should not dial fresh");
      }
    },
  });

  const result = await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-1",
      hostname: "stale.example.test",
      username: "stale-user",
      port: 2222,
      sourceSessionId: "live-session",
      reuseOnly: true,
    },
  );

  assert.equal(requestedTarget, undefined);
  assert.deepEqual(result, { sftpId: "sftp-1", fileProtocol: "sftp" });
});
