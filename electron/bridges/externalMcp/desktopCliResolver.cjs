"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isExecutableFile(filePath, deps) {
  try {
    if (!deps.existsSync(filePath)) return false;
    const stat = deps.statSync(filePath);
    if (!stat.isFile()) return false;
    // Prefer runtime access check so we skip candidates the process cannot
    // execute (mode bits alone miss ACL/ownership cases). Fall back to mode
    // bits when accessSync is not provided (tests can inject either).
    if (typeof deps.accessSync === "function") {
      deps.accessSync(filePath, deps.X_OK);
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findFirstExecutable(candidates, deps) {
  for (const candidate of candidates) {
    if (isExecutableFile(candidate, deps)) return candidate;
  }
  return null;
}

function compareVersionDirectoryNames(left, right) {
  return String(right).localeCompare(String(left), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function resolveCodexDesktopCli(homeDir, deps) {
  const appRoots = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(homeDir, "Applications", "ChatGPT.app"),
    path.join(homeDir, "Applications", "Codex.app"),
  ];
  return findFirstExecutable(
    appRoots.map((appRoot) => path.join(appRoot, "Contents", "Resources", "codex")),
    deps,
  );
}

function resolveClaudeDesktopCli(homeDir, deps) {
  const versionsRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );

  let versionDirectories;
  try {
    versionDirectories = deps.readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDirectoryNames);
  } catch {
    return null;
  }

  // Only the native macOS app-bundle CLI. A sibling `<version>/claude` binary
  // may exist but is a Linux VM helper on current Claude Desktop installs, so
  // accepting it would break spawn and block falling back to an older good version.
  return findFirstExecutable(
    versionDirectories.map((version) => path.join(
      versionsRoot,
      version,
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    )),
    deps,
  );
}

function resolveDesktopManagedCli(name, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return null;

  const deps = {
    existsSync: options.existsSync || fs.existsSync,
    statSync: options.statSync || fs.statSync,
    readdirSync: options.readdirSync || fs.readdirSync,
    accessSync: options.accessSync || fs.accessSync,
    X_OK: options.X_OK != null ? options.X_OK : fs.constants.X_OK,
  };
  const homeDir = options.homeDir || os.homedir();

  if (name === "codex") return resolveCodexDesktopCli(homeDir, deps);
  if (name === "claude") return resolveClaudeDesktopCli(homeDir, deps);
  return null;
}

module.exports = {
  compareVersionDirectoryNames,
  resolveDesktopManagedCli,
};
