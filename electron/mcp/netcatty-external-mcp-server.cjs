"use strict";

/**
 * Bootstrap for external MCP clients.
 * Reads the external discovery file written by Netcatty, sets env, then
 * loads the existing catalog-backed stdio MCP server.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  resolveExistingExternalMcpDiscoveryFilePath,
  EXTERNAL_MCP_CHAT_SESSION_ID,
} = require("../cli/externalMcpDiscoveryPath.cjs");
const { readExternalDiscovery } = require("../cli/externalMcpDiscovery.cjs");

function resolveDiscoveryPath() {
  return resolveExistingExternalMcpDiscoveryFilePath();
}

function main() {
  const discoveryPath = resolveDiscoveryPath();
  if (!fs.existsSync(discoveryPath)) {
    process.stderr.write(
      `[netcatty-external-mcp] Discovery file not found at ${discoveryPath}. ` +
      "Enable External MCP in Netcatty Settings → AI and keep the app running.\n",
    );
    process.exit(1);
  }

  let discovery;
  try {
    discovery = readExternalDiscovery(discoveryPath);
  } catch (error) {
    process.stderr.write(
      `[netcatty-external-mcp] Failed to read discovery: ${error?.message || error}\n`,
    );
    process.exit(1);
  }

  process.env.NETCATTY_MCP_PORT = String(discovery.port);
  process.env.NETCATTY_MCP_TOKEN = discovery.token;
  process.env.NETCATTY_MCP_CHAT_SESSION_ID = discovery.chatSessionId || EXTERNAL_MCP_CHAT_SESSION_ID;
  process.env.NETCATTY_MCP_PERMISSION_MODE = discovery.permissionMode || "confirm";

  // Load after env is set — netcatty-mcp-server reads env at module load.
  require(path.join(__dirname, "netcatty-mcp-server.cjs"));
}

main();
