"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getExternalMcpDiscoveryFilePath,
  getExternalMcpLauncherPath,
  resolveExistingExternalMcpDiscoveryFilePath,
  EXTERNAL_MCP_CHAT_SESSION_ID,
  EXTERNAL_MCP_DISCOVERY_ENV_VAR,
  buildDiscoveryEnv,
  formatDiscoveryEnvCliFlags,
} = require("./externalMcpDiscoveryPath.cjs");
const {
  buildExternalDiscoveryPayload,
  writeExternalDiscovery,
  removeExternalDiscovery,
  readExternalDiscovery,
} = require("./externalMcpDiscovery.cjs");

describe("externalMcpDiscoveryPath", () => {
  it("returns a discovery path under the external-mcp state dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ext-mcp-"));
    const discoveryPath = getExternalMcpDiscoveryFilePath({ userDataDir: tmp });
    assert.equal(discoveryPath, path.join(tmp, "external-mcp", "discovery.json"));
    assert.equal(EXTERNAL_MCP_CHAT_SESSION_ID, "__external_mcp__");
    assert.ok(getExternalMcpLauncherPath().includes("netcatty-external-mcp"));
  });

  it("honors NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE", () => {
    const previous = process.env[EXTERNAL_MCP_DISCOVERY_ENV_VAR];
    const custom = path.join(os.tmpdir(), "custom-external-discovery.json");
    process.env[EXTERNAL_MCP_DISCOVERY_ENV_VAR] = custom;
    try {
      assert.equal(getExternalMcpDiscoveryFilePath(), custom);
    } finally {
      if (previous == null) delete process.env[EXTERNAL_MCP_DISCOVERY_ENV_VAR];
      else process.env[EXTERNAL_MCP_DISCOVERY_ENV_VAR] = previous;
    }
  });

  it("resolves an existing discovery under candidate userData dirs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ext-mcp-"));
    const discoveryPath = path.join(tmp, "external-mcp", "discovery.json");
    writeExternalDiscovery(discoveryPath, {
      port: 1,
      token: "t",
      pid: 1,
    });
    const resolved = resolveExistingExternalMcpDiscoveryFilePath({ userDataDir: tmp });
    assert.equal(resolved, discoveryPath);
  });

  it("builds discovery env CLI flags for clients", () => {
    const env = buildDiscoveryEnv("/tmp/discovery.json");
    assert.deepEqual(
      formatDiscoveryEnvCliFlags(env, "codex"),
      ["--env", `${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=/tmp/discovery.json`],
    );
    assert.deepEqual(
      formatDiscoveryEnvCliFlags(env, "claude"),
      ["-e", `${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=/tmp/discovery.json`],
    );
  });
});

describe("externalMcpDiscovery", () => {
  it("writes and reads discovery with chatSessionId", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ext-mcp-"));
    const filePath = path.join(tmp, "discovery.json");
    const payload = writeExternalDiscovery(filePath, {
      port: 41234,
      token: "abc123",
      pid: 99,
      permissionMode: "confirm",
      chatSessionId: EXTERNAL_MCP_CHAT_SESSION_ID,
    });
    assert.equal(payload.port, 41234);
    assert.equal(payload.chatSessionId, EXTERNAL_MCP_CHAT_SESSION_ID);
    const read = readExternalDiscovery(filePath);
    assert.equal(read.port, 41234);
    assert.equal(read.token, "abc123");
    assert.equal(read.chatSessionId, EXTERNAL_MCP_CHAT_SESSION_ID);
    removeExternalDiscovery(filePath);
    assert.equal(fs.existsSync(filePath), false);
  });

  it("buildExternalDiscoveryPayload defaults chatSessionId", () => {
    const payload = buildExternalDiscoveryPayload({
      port: 1,
      token: "t",
      pid: 1,
    });
    assert.equal(payload.chatSessionId, "__external_mcp__");
    assert.equal(payload.host, "127.0.0.1");
  });
});
