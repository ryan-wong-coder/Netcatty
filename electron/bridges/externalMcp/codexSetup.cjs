"use strict";

const EXTERNAL_MCP_CODEX_NAME = "netcatty-external";
const {
  formatDiscoveryEnvCliFlags,
} = require("../../cli/externalMcpDiscoveryPath.cjs");

function loadShellUtils() {
  return require("../ai/shellUtils.cjs");
}

function loadDesktopCliResolver() {
  return require("./desktopCliResolver.cjs");
}

function parseCodexMcpList(rawOutput) {
  const parsed = JSON.parse(String(rawOutput || "[]"));
  if (!Array.isArray(parsed)) {
    throw new Error("Codex MCP list returned an unexpected payload.");
  }
  return parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      enabled: entry.enabled !== false,
      transport: entry.transport && typeof entry.transport === "object"
        ? { ...entry.transport }
        : null,
      env: entry.env && typeof entry.env === "object" ? entry.env : null,
    }));
}

function formatCodexCommandText(args, cliPath = "codex") {
  const executable = typeof cliPath === "string" && cliPath.trim()
    ? cliPath.trim()
    : "codex";
  return [quoteCommandArg(executable), ...args.map(quoteCommandArg)].join(" ");
}

function quoteCommandArg(value) {
  if (typeof value !== "string" || value.length === 0) return '""';
  // Match ExternalMcpCard quoteShellArg so copyable commands stay shell-safe
  // for paths with spaces, quotes, apostrophes, or backslashes.
  if (!/[\s"'\\]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function formatExistingCommand(transport) {
  if (!transport || typeof transport !== "object") return null;
  if (transport.type === "stdio") {
    const command = typeof transport.command === "string" ? transport.command.trim() : "";
    const args = Array.isArray(transport.args)
      ? transport.args.filter((arg) => typeof arg === "string" && arg.trim())
      : [];
    return [command, ...args].filter(Boolean).join(" ").trim() || null;
  }
  if (typeof transport.url === "string" && transport.url.trim()) {
    return transport.url.trim();
  }
  return null;
}

function normalizePathForCompare(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/^["']|["']$/gu, "");
  if (process.platform === "win32") {
    normalized = normalized.replace(/\.cmd$/iu, "");
  }
  return normalized;
}

function pathsMatch(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function buildCodexAddArgs(launcherPath, discoveryEnv) {
  return [
    "mcp",
    "add",
    EXTERNAL_MCP_CODEX_NAME,
    ...formatDiscoveryEnvCliFlags(discoveryEnv, "codex"),
    "--",
    launcherPath,
  ];
}

function getCodexEntryEnv(entry) {
  const transportEnv = entry?.transport?.env;
  if (transportEnv && typeof transportEnv === "object") return transportEnv;
  if (entry?.env && typeof entry.env === "object") return entry.env;
  return null;
}

function hasRequiredDiscoveryEnv(entryEnv, discoveryEnv) {
  const required = discoveryEnv && typeof discoveryEnv === "object" ? discoveryEnv : {};
  const keys = Object.keys(required).filter((key) => typeof required[key] === "string" && required[key]);
  if (keys.length === 0) return true;
  if (!entryEnv || typeof entryEnv !== "object") return false;
  return keys.every((key) => String(entryEnv[key] || "") === String(required[key]));
}

function classifyCodexExternalMcpStatus({
  entries,
  launcherPath,
  codexPath,
  discoveryEnv,
  commandExecutable,
}) {
  const commandArgs = buildCodexAddArgs(launcherPath, discoveryEnv || {});
  const base = {
    ok: true,
    codexPath: codexPath || null,
    launcherPath: launcherPath || null,
    command: formatCodexCommandText(commandArgs, commandExecutable || codexPath),
    existingCommand: null,
    error: null,
  };

  const entry = Array.isArray(entries)
    ? entries.find((item) => item?.name === EXTERNAL_MCP_CODEX_NAME)
    : null;

  if (!entry) {
    return {
      ...base,
      state: codexPath ? "not_configured" : "codex_not_found",
    };
  }

  const transport = entry.transport || null;
  const existingCommand = formatExistingCommand(transport) || launcherPath || EXTERNAL_MCP_CODEX_NAME;
  if (entry.enabled === false) {
    return {
      ...base,
      state: "not_configured",
      existingCommand,
    };
  }

  if (
    transport?.type === "stdio"
    && pathsMatch(transport.command, launcherPath)
    && (!Array.isArray(transport.args) || transport.args.length === 0)
  ) {
    if (!hasRequiredDiscoveryEnv(getCodexEntryEnv(entry), discoveryEnv)) {
      return {
        ...base,
        state: "not_configured",
        existingCommand,
      };
    }
    return {
      ...base,
      state: "configured",
      existingCommand,
    };
  }

  return {
    ...base,
    state: "conflict",
    existingCommand,
  };
}

function createExternalMcpCodexSetup(options = {}) {
  const deps = {
    launcherPath: options.launcherPath || null,
    discoveryEnv: options.discoveryEnv && typeof options.discoveryEnv === "object"
      ? options.discoveryEnv
      : {},
    getShellEnv: options.getShellEnv || loadShellUtils().getShellEnv,
    resolveCliFromPath: options.resolveCliFromPath || loadShellUtils().resolveCliFromPath,
    resolveDesktopManagedCli: options.resolveDesktopManagedCli
      || loadDesktopCliResolver().resolveDesktopManagedCli,
    prepareCommandForSpawn: options.prepareCommandForSpawn || loadShellUtils().prepareCommandForSpawn,
    spawn: options.spawn || require("node:child_process").spawn,
    stripAnsi: options.stripAnsi || loadShellUtils().stripAnsi,
  };

  function getManualCommand(cliPath) {
    return formatCodexCommandText(
      buildCodexAddArgs(deps.launcherPath, deps.discoveryEnv),
      cliPath,
    );
  }

  async function resolveCodex() {
    const shellEnv = await deps.getShellEnv();
    // PATH installs keep the bare `codex` copyable command (portable across
    // shells). Desktop-managed absolute paths only appear when PATH misses.
    const pathResolved = deps.resolveCliFromPath("codex", shellEnv) || null;
    const desktopResolved = pathResolved
      ? null
      : (deps.resolveDesktopManagedCli("codex") || null);
    const codexPath = pathResolved || desktopResolved;
    return {
      shellEnv,
      codexPath,
      commandExecutable: pathResolved ? "codex" : (desktopResolved || "codex"),
    };
  }

  async function runCodex(codexPath, shellEnv, args) {
    return await new Promise((resolve, reject) => {
      const spawnSpec = deps.prepareCommandForSpawn(codexPath, args);
      const child = deps.spawn(spawnSpec.command, spawnSpec.args || [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: shellEnv,
        shell: spawnSpec.shell,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({
          exitCode,
          stdout: deps.stripAnsi(stdout),
          stderr: deps.stripAnsi(stderr),
        });
      });
    });
  }

  function summarizeFailure(result, fallback) {
    return String(result?.stderr || result?.stdout || fallback || "Codex command failed").trim();
  }

  async function getStatus() {
    const { shellEnv, codexPath, commandExecutable } = await resolveCodex();
    if (!codexPath) {
      return {
        ok: true,
        state: "codex_not_found",
        codexPath: null,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: null,
      };
    }

    try {
      const result = await runCodex(codexPath, shellEnv, ["mcp", "list", "--json"]);
      if (result.exitCode !== 0) {
        return {
          ok: true,
          state: "error",
          codexPath,
          launcherPath: deps.launcherPath,
          command: getManualCommand(commandExecutable),
          existingCommand: null,
          error: summarizeFailure(result, `Codex exited with code ${result.exitCode ?? "unknown"}`),
        };
      }
      const status = classifyCodexExternalMcpStatus({
        entries: parseCodexMcpList(result.stdout),
        launcherPath: deps.launcherPath,
        codexPath,
        discoveryEnv: deps.discoveryEnv,
        commandExecutable,
      });
      return {
        ...status,
        command: getManualCommand(commandExecutable),
      };
    } catch (error) {
      return {
        ok: true,
        state: "error",
        codexPath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(commandExecutable),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  async function addToCodex() {
    const status = await getStatus();
    if (status.state === "codex_not_found" || status.state === "conflict" || status.state === "configured") {
      return status;
    }
    if (status.state === "error") {
      return status;
    }

    const { shellEnv, codexPath, commandExecutable } = await resolveCodex();
    if (!codexPath) {
      return {
        ...status,
        state: "codex_not_found",
        codexPath: null,
      };
    }

    try {
      if (status.existingCommand) {
        await runCodex(codexPath, shellEnv, ["mcp", "remove", EXTERNAL_MCP_CODEX_NAME]);
      }
      const addResult = await runCodex(
        codexPath,
        shellEnv,
        buildCodexAddArgs(deps.launcherPath, deps.discoveryEnv),
      );
      if (addResult.exitCode !== 0) {
        return {
          ok: true,
          state: "error",
          codexPath,
          launcherPath: deps.launcherPath,
          command: getManualCommand(commandExecutable),
          existingCommand: null,
          error: summarizeFailure(addResult, `Codex exited with code ${addResult.exitCode ?? "unknown"}`),
        };
      }
      return await getStatus();
    } catch (error) {
      return {
        ok: true,
        state: "error",
        codexPath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(commandExecutable),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  return {
    getStatus,
    addToCodex,
  };
}

module.exports = {
  EXTERNAL_MCP_CODEX_NAME,
  createExternalMcpCodexSetup,
  parseCodexMcpList,
  classifyCodexExternalMcpStatus,
};
