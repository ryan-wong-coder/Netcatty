"use strict";

const EXTERNAL_MCP_CLAUDE_NAME = "netcatty-external";
const {
  formatDiscoveryEnvCliFlags,
} = require("../../cli/externalMcpDiscoveryPath.cjs");

function loadShellUtils() {
  return require("../ai/shellUtils.cjs");
}

function formatClaudeCommandText(args) {
  return ["claude", ...args.map(quoteCommandArg)].join(" ");
}

function quoteCommandArg(value) {
  if (typeof value !== "string" || value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function getCombinedOutput(result) {
  return String(`${result?.stdout || ""}\n${result?.stderr || ""}`).trim();
}

function isMissingClaudeServer(result) {
  return /No MCP server found with name:\s*["']?netcatty-external["']?/i.test(getCombinedOutput(result));
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

function extractExistingCommand(result) {
  const output = getCombinedOutput(result);
  if (!output) return null;

  const commandLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^Command:\s*/iu.test(line));
  if (commandLine) {
    return commandLine.replace(/^Command:\s*/iu, "").trim() || null;
  }

  const matchingLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.includes(EXTERNAL_MCP_CLAUDE_NAME));
  if (!matchingLine) return output;

  const colonIndex = matchingLine.indexOf(":");
  const afterName = colonIndex >= 0 ? matchingLine.slice(colonIndex + 1).trim() : matchingLine;
  const statusSeparatorIndex = afterName.lastIndexOf(" - ");
  if (statusSeparatorIndex >= 0 && /connected/i.test(afterName.slice(statusSeparatorIndex + 3))) {
    return afterName.slice(0, statusSeparatorIndex).trim() || output;
  }
  return afterName || output;
}

function buildClaudeAddArgs(launcherPath, discoveryEnv) {
  return [
    "mcp",
    "add",
    EXTERNAL_MCP_CLAUDE_NAME,
    ...formatDiscoveryEnvCliFlags(discoveryEnv, "claude"),
    "--",
    launcherPath,
  ];
}

function classifyClaudeExternalMcpStatus({ getResult, launcherPath, claudePath }) {
  const commandArgs = buildClaudeAddArgs(launcherPath, {});
  const base = {
    ok: true,
    claudePath: claudePath || null,
    launcherPath: launcherPath || null,
    command: formatClaudeCommandText(commandArgs),
    existingCommand: null,
    error: null,
  };

  if (getResult?.exitCode !== 0) {
    if (isMissingClaudeServer(getResult)) {
      return {
        ...base,
        state: claudePath ? "not_configured" : "claude_not_found",
      };
    }
    return {
      ...base,
      state: "error",
      error: summarizeFailure(getResult, `Claude exited with code ${getResult?.exitCode ?? "unknown"}`),
    };
  }

  const existingCommand = extractExistingCommand(getResult);
  if (pathsMatch(existingCommand, launcherPath)) {
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

function summarizeFailure(result, fallback) {
  return String(result?.stderr || result?.stdout || fallback || "Claude command failed").trim();
}

function createExternalMcpClaudeSetup(options = {}) {
  const deps = {
    launcherPath: options.launcherPath || null,
    discoveryEnv: options.discoveryEnv && typeof options.discoveryEnv === "object"
      ? options.discoveryEnv
      : {},
    getShellEnv: options.getShellEnv || loadShellUtils().getShellEnv,
    resolveCliFromPath: options.resolveCliFromPath || loadShellUtils().resolveCliFromPath,
    prepareCommandForSpawn: options.prepareCommandForSpawn || loadShellUtils().prepareCommandForSpawn,
    spawn: options.spawn || require("node:child_process").spawn,
    stripAnsi: options.stripAnsi || loadShellUtils().stripAnsi,
  };

  function getManualCommand() {
    return formatClaudeCommandText(buildClaudeAddArgs(deps.launcherPath, deps.discoveryEnv));
  }

  async function resolveClaude() {
    const shellEnv = await deps.getShellEnv();
    const claudePath = deps.resolveCliFromPath("claude", shellEnv);
    return {
      shellEnv,
      claudePath: claudePath || null,
    };
  }

  async function runClaude(claudePath, shellEnv, args) {
    return await new Promise((resolve, reject) => {
      const spawnSpec = deps.prepareCommandForSpawn(claudePath, args);
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

  async function getStatus() {
    const { shellEnv, claudePath } = await resolveClaude();
    if (!claudePath) {
      return {
        ok: true,
        state: "claude_not_found",
        claudePath: null,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: null,
      };
    }

    try {
      const result = await runClaude(claudePath, shellEnv, ["mcp", "get", EXTERNAL_MCP_CLAUDE_NAME]);
      const status = classifyClaudeExternalMcpStatus({
        getResult: result,
        launcherPath: deps.launcherPath,
        claudePath,
      });
      return {
        ...status,
        command: getManualCommand(),
      };
    } catch (error) {
      return {
        ok: true,
        state: "error",
        claudePath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  async function addToClaude() {
    const status = await getStatus();
    if (status.state === "claude_not_found" || status.state === "conflict" || status.state === "configured") {
      return status;
    }
    if (status.state === "error") {
      return status;
    }

    const { shellEnv, claudePath } = await resolveClaude();
    if (!claudePath) {
      return {
        ...status,
        state: "claude_not_found",
        claudePath: null,
      };
    }

    try {
      const addResult = await runClaude(
        claudePath,
        shellEnv,
        buildClaudeAddArgs(deps.launcherPath, deps.discoveryEnv),
      );
      if (addResult.exitCode !== 0) {
        return {
          ok: true,
          state: "error",
          claudePath,
          launcherPath: deps.launcherPath,
          command: getManualCommand(),
          existingCommand: null,
          error: summarizeFailure(addResult, `Claude exited with code ${addResult.exitCode ?? "unknown"}`),
        };
      }
      return await getStatus();
    } catch (error) {
      return {
        ok: true,
        state: "error",
        claudePath,
        launcherPath: deps.launcherPath,
        command: getManualCommand(),
        existingCommand: null,
        error: error?.message || String(error),
      };
    }
  }

  return {
    getStatus,
    addToClaude,
  };
}

module.exports = {
  EXTERNAL_MCP_CLAUDE_NAME,
  createExternalMcpClaudeSetup,
  classifyClaudeExternalMcpStatus,
};
