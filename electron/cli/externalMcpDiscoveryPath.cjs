"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const EXTERNAL_MCP_STATE_DIR_NAME = "external-mcp";
const EXTERNAL_MCP_DISCOVERY_ENV_VAR = "NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE";
const EXTERNAL_MCP_CHAT_SESSION_ID = "__external_mcp__";
const FALLBACK_APP_DATA_DIR_NAME = "Netcatty";

function toUnpackedAsarPath(filePath) {
  return filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function getDefaultAppDataDirName(options = {}) {
  const packageJsonPaths = Array.isArray(options.packageJsonPaths) && options.packageJsonPaths.length > 0
    ? options.packageJsonPaths
    : [
      process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "package.json") : null,
      path.resolve(__dirname, "../../package.json"),
      path.join(process.cwd(), "package.json"),
    ].filter(Boolean);

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const packageJson = require(packageJsonPath);
      if (typeof packageJson?.productName === "string" && packageJson.productName) {
        return packageJson.productName;
      }
    } catch {
      // Try next candidate.
    }
  }

  // Prefer Electron productName casing over package.json "name" (netcatty).
  return FALLBACK_APP_DATA_DIR_NAME;
}

function getPlatformUserDataRoot(appDataDirName) {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appDataDirName);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appDataDirName);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, appDataDirName);
}

function getDefaultUserDataDir() {
  return getPlatformUserDataRoot(getDefaultAppDataDirName());
}

/**
 * Candidate userData roots the launcher may need when env is missing.
 * Includes packaged (Netcatty), lowercase package name, and Electron Dev (/dev).
 */
function listCandidateUserDataDirs(options = {}) {
  const names = Array.from(new Set([
    getDefaultAppDataDirName(options),
    "Netcatty",
    "netcatty",
    "Netcatty Dev",
  ].filter(Boolean)));
  const roots = [];
  for (const name of names) {
    const root = getPlatformUserDataRoot(name);
    roots.push(root);
    roots.push(path.join(root, "dev"));
  }
  return Array.from(new Set(roots));
}

function getConfiguredDiscoveryFilePath() {
  return process.env[EXTERNAL_MCP_DISCOVERY_ENV_VAR] || null;
}

function getExternalMcpStateDir(options = {}) {
  const discoveryFilePath = getConfiguredDiscoveryFilePath();
  if (discoveryFilePath) {
    return path.dirname(discoveryFilePath);
  }
  const userDataDir = typeof options.userDataDir === "string" && options.userDataDir
    ? options.userDataDir
    : getDefaultUserDataDir();
  return path.join(userDataDir, EXTERNAL_MCP_STATE_DIR_NAME);
}

function getExternalMcpDiscoveryFilePath(options = {}) {
  const discoveryFilePath = getConfiguredDiscoveryFilePath();
  if (discoveryFilePath) {
    return discoveryFilePath;
  }
  return path.join(getExternalMcpStateDir(options), "discovery.json");
}

/**
 * Resolve an existing discovery file for launcher/bootstrap use.
 * Prefers the env override, then the default path, then common Electron userData variants.
 */
function resolveExistingExternalMcpDiscoveryFilePath(options = {}) {
  const configured = getConfiguredDiscoveryFilePath();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  const primary = getExternalMcpDiscoveryFilePath(
    options.userDataDir ? { userDataDir: options.userDataDir } : {},
  );
  if (fs.existsSync(primary)) {
    return primary;
  }

  for (const userDataDir of listCandidateUserDataDirs(options)) {
    const candidate = path.join(userDataDir, EXTERNAL_MCP_STATE_DIR_NAME, "discovery.json");
    if (candidate !== primary && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return configured || primary;
}

function getExternalMcpLauncherPath() {
  const fileName = process.platform === "win32"
    ? "netcatty-external-mcp.cmd"
    : "netcatty-external-mcp";
  return toUnpackedAsarPath(path.join(__dirname, fileName));
}

function buildDiscoveryEnv(discoveryFilePath) {
  if (!discoveryFilePath) return {};
  return { [EXTERNAL_MCP_DISCOVERY_ENV_VAR]: discoveryFilePath };
}

function formatDiscoveryEnvCliFlags(discoveryEnv, style = "codex") {
  const entries = Object.entries(discoveryEnv || {}).filter(([, value]) => typeof value === "string" && value);
  if (entries.length === 0) return [];
  if (style === "claude" || style === "grok") {
    return entries.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  }
  // Codex: --env KEY=VALUE
  return entries.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

module.exports = {
  getDefaultAppDataDirName,
  getExternalMcpStateDir,
  getExternalMcpDiscoveryFilePath,
  resolveExistingExternalMcpDiscoveryFilePath,
  getExternalMcpLauncherPath,
  listCandidateUserDataDirs,
  buildDiscoveryEnv,
  formatDiscoveryEnvCliFlags,
  EXTERNAL_MCP_DISCOVERY_ENV_VAR,
  EXTERNAL_MCP_CHAT_SESSION_ID,
  EXTERNAL_MCP_STATE_DIR_NAME,
};
