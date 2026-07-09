import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import {
  normalizeExternalMcpIdleTimeoutMinutes,
  normalizeExternalMcpMode,
  readExternalMcpIdleTimeoutMinutes,
  readExternalMcpMode,
  type ExternalMcpMode,
  useExternalMcpToggleState,
} from "../../../../application/state/useExternalMcpToggleState";
import {
  STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES,
  STORAGE_KEY_AI_EXTERNAL_MCP_MODE,
} from "../../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../../infrastructure/persistence/localStorageAdapter";
import { emitAIStateChanged } from "../../../../application/state/aiStateEvents";
import { cn } from "../../../../lib/utils";
import { Button } from "../../../ui/button";
import { Select, Toggle } from "../../../settings/settings-ui";
import { getBridge } from "./types";

type ExternalMcpClient = "codex" | "claude" | "grok";

type ExternalMcpStatus = {
  ok: boolean;
  enabled?: boolean;
  state?: string;
  host?: string;
  port?: number | null;
  discoveryPath?: string | null;
  launcherPath?: string | null;
  exposedSessionCount?: number;
  mode?: ExternalMcpMode;
  idleTimeoutMinutes?: number;
  permissionMode?: string;
  error?: string | null;
};

type ClientSetupStatus = {
  ok: boolean;
  state?: string;
  launcherPath?: string | null;
  command?: string;
  existingCommand?: string | null;
  error?: string | null;
};

type StatusView = {
  labelKey: string;
  className: string;
};

function getBridgeStatusView(status: ExternalMcpStatus | null, enabled: boolean): StatusView {
  if (!enabled) {
    return { labelKey: "ai.externalMcp.status.disabled", className: "text-muted-foreground" };
  }
  if (!status || !status.ok) {
    return { labelKey: "ai.externalMcp.status.unavailable", className: "text-amber-500" };
  }
  if (status.state === "running") {
    return { labelKey: "ai.externalMcp.status.running", className: "text-emerald-500" };
  }
  if (status.state === "starting") {
    return { labelKey: "ai.externalMcp.status.starting", className: "text-amber-500" };
  }
  if (status.state === "error") {
    return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
  }
  return { labelKey: "ai.externalMcp.status.disabled", className: "text-muted-foreground" };
}

function getCodexStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "codex_not_found":
      return { labelKey: "ai.externalMcp.status.codexNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function getClaudeStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "claude_not_found":
      return { labelKey: "ai.externalMcp.status.claudeNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function getGrokStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "grok_not_found":
      return { labelKey: "ai.externalMcp.status.grokNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function escapeTomlBasicString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function quoteShellArg(value: string) {
  if (!value) return '""';
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

const EXTERNAL_MCP_DISCOVERY_ENV_VAR = "NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE";

export function formatCodexAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` --env ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `codex mcp add netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

export function formatClaudeAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` -e ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `claude mcp add netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

export function formatGrokAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` -e ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `grok mcp add netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

function buildTomlEnvBlock(discoveryPath?: string | null) {
  if (!discoveryPath) return "";
  return `\nenv = { ${EXTERNAL_MCP_DISCOVERY_ENV_VAR} = "${escapeTomlBasicString(discoveryPath)}" }`;
}

export function buildCodexTomlSnippet(launcherPath: string, discoveryPath?: string | null) {
  return `[mcp_servers.netcatty-external]
command = "${escapeTomlBasicString(launcherPath)}"
args = []${buildTomlEnvBlock(discoveryPath)}`;
}

export function buildGrokTomlSnippet(launcherPath: string, discoveryPath?: string | null) {
  return `[mcp_servers.netcatty-external]
command = "${escapeTomlBasicString(launcherPath)}"
args = []${buildTomlEnvBlock(discoveryPath)}`;
}

function buildJsonServerEntry(launcherPath: string, discoveryPath?: string | null) {
  const entry: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  } = {
    command: launcherPath,
    args: [],
  };
  if (discoveryPath) {
    entry.env = { [EXTERNAL_MCP_DISCOVERY_ENV_VAR]: discoveryPath };
  }
  return entry;
}

export function buildClaudeSnippet(launcherPath: string, discoveryPath?: string | null) {
  return JSON.stringify({
    mcpServers: {
      "netcatty-external": buildJsonServerEntry(launcherPath, discoveryPath),
    },
  }, null, 2);
}

export function buildCursorSnippet(launcherPath: string, discoveryPath?: string | null) {
  return JSON.stringify({
    mcpServers: {
      "netcatty-external": buildJsonServerEntry(launcherPath, discoveryPath),
    },
  }, null, 2);
}

export const ExternalMcpCard: React.FC = () => {
  const { t } = useI18n();
  const { enabled, setEnabled } = useExternalMcpToggleState();
  const [mode, setModeRaw] = useState<ExternalMcpMode>(() => readExternalMcpMode());
  const [idleTimeoutMinutes, setIdleTimeoutRaw] = useState<number>(() => readExternalMcpIdleTimeoutMinutes());
  const [status, setStatus] = useState<ExternalMcpStatus | null>(null);
  const [selectedClient, setSelectedClient] = useState<ExternalMcpClient>("codex");
  const [codexStatus, setCodexStatus] = useState<ClientSetupStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClientSetupStatus | null>(null);
  const [grokStatus, setGrokStatus] = useState<ClientSetupStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAddingCodex, setIsAddingCodex] = useState(false);
  const [isAddingClaude, setIsAddingClaude] = useState(false);
  const [isAddingGrok, setIsAddingGrok] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "error" | "warning" | "success"; text: string } | null>(null);
  const bridgeUnavailableMessage = t("ai.externalMcp.bridgeUnavailable");

  const pushConfig = useCallback((nextMode: ExternalMcpMode, nextIdle: number) => {
    void getBridge()?.externalMcpSetConfig?.({
      mode: nextMode,
      idleTimeoutMinutes: nextIdle,
    });
  }, []);

  const setMode = useCallback((nextMode: ExternalMcpMode) => {
    const normalized = normalizeExternalMcpMode(nextMode);
    setModeRaw(normalized);
    localStorageAdapter.writeString(STORAGE_KEY_AI_EXTERNAL_MCP_MODE, normalized);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_MODE);
    pushConfig(normalized, idleTimeoutMinutes);
  }, [idleTimeoutMinutes, pushConfig]);

  const setIdleTimeoutMinutes = useCallback((minutes: number) => {
    const normalized = normalizeExternalMcpIdleTimeoutMinutes(minutes);
    setIdleTimeoutRaw(normalized);
    localStorageAdapter.writeNumber(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES, normalized);
    emitAIStateChanged(STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES);
    pushConfig(mode, normalized);
  }, [mode, pushConfig]);

  const refreshStatus = useCallback(async (options?: { quiet?: boolean }) => {
    const bridge = getBridge();
    if (
      !bridge?.externalMcpGetStatus
      || !bridge?.externalMcpCodexGetStatus
      || !bridge?.externalMcpClaudeGetStatus
      || !bridge?.externalMcpGrokGetStatus
    ) {
      setStatus({
        ok: false,
        enabled,
        state: "unavailable",
        discoveryPath: null,
        launcherPath: null,
        exposedSessionCount: 0,
        error: bridgeUnavailableMessage,
      });
      const unavailableClientStatus: ClientSetupStatus = {
        ok: true,
        state: "error",
        launcherPath: null,
        command: "",
        existingCommand: null,
        error: bridgeUnavailableMessage,
      };
      setCodexStatus(unavailableClientStatus);
      setClaudeStatus(unavailableClientStatus);
      setGrokStatus(unavailableClientStatus);
      return;
    }

    if (!options?.quiet) setIsRefreshing(true);
    try {
      const [nextStatus, nextCodexStatus, nextClaudeStatus, nextGrokStatus] = await Promise.all([
        bridge.externalMcpGetStatus(),
        bridge.externalMcpCodexGetStatus(),
        bridge.externalMcpClaudeGetStatus(),
        bridge.externalMcpGrokGetStatus(),
      ]);
      setStatus(nextStatus as ExternalMcpStatus);
      if (enabled && nextStatus?.ok && !nextStatus.enabled) {
        setEnabled(false);
      }
      setCodexStatus(nextCodexStatus as ClientSetupStatus);
      setClaudeStatus(nextClaudeStatus as ClientSetupStatus);
      setGrokStatus(nextGrokStatus as ClientSetupStatus);
    } finally {
      if (!options?.quiet) setIsRefreshing(false);
    }
  }, [bridgeUnavailableMessage, enabled, setEnabled]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    const intervalId = window.setInterval(() => {
      void refreshStatus({ quiet: true });
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [enabled, refreshStatus]);

  useEffect(() => {
    pushConfig(mode, idleTimeoutMinutes);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- sync stored config once on mount

  const bridgeStatusView = useMemo(() => getBridgeStatusView(status, enabled), [enabled, status]);
  const exposedSessionCount = enabled ? status?.exposedSessionCount ?? 0 : 0;
  const codexStatusView = useMemo(() => getCodexStatusView(codexStatus), [codexStatus]);
  const claudeStatusView = useMemo(() => getClaudeStatusView(claudeStatus), [claudeStatus]);
  const grokStatusView = useMemo(() => getGrokStatusView(grokStatus), [grokStatus]);

  const launcherPath = status?.launcherPath
    || codexStatus?.launcherPath
    || claudeStatus?.launcherPath
    || grokStatus?.launcherPath
    || null;
  const discoveryPath = status?.discoveryPath || null;
  const codexCommand = launcherPath
    ? formatCodexAddCommand(launcherPath, discoveryPath)
    : (codexStatus?.command || "");
  const claudeCommand = launcherPath
    ? formatClaudeAddCommand(launcherPath, discoveryPath)
    : (claudeStatus?.command || "");
  const grokCommand = launcherPath
    ? formatGrokAddCommand(launcherPath, discoveryPath)
    : (grokStatus?.command || "");
  const codexTomlSnippet = launcherPath ? buildCodexTomlSnippet(launcherPath, discoveryPath) : "";
  const grokTomlSnippet = launcherPath ? buildGrokTomlSnippet(launcherPath, discoveryPath) : "";
  const claudeSnippet = launcherPath ? buildClaudeSnippet(launcherPath, discoveryPath) : "";
  const cursorSnippet = launcherPath ? buildCursorSnippet(launcherPath, discoveryPath) : "";
  const canAddToCodex = codexStatus?.state === "not_configured";
  const canAddToClaude = claudeStatus?.state === "not_configured";
  const canAddToGrok = grokStatus?.state === "not_configured";
  const selectedClientStatusView = selectedClient === "codex"
    ? codexStatusView
    : selectedClient === "claude"
      ? claudeStatusView
      : grokStatusView;
  const selectedClientCommand = selectedClient === "codex"
    ? codexCommand
    : selectedClient === "claude"
      ? claudeCommand
      : grokCommand;

  const copyText = useCallback(async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => {
        setCopied((current) => (current === key ? null : current));
      }, 1200);
    } catch {
      setActionMessage({ tone: "error", text: t("ai.externalMcp.copyFailed") });
    }
  }, [t]);

  const handleAddToCodex = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpCodexAdd) return;
    setActionMessage(null);
    setIsAddingCodex(true);
    try {
      const result = await bridge.externalMcpCodexAdd() as ClientSetupStatus;
      setCodexStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.codexAdded") });
      } else if (result.state === "codex_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installCodex") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingCodex(false);
    }
  }, [refreshStatus, t]);

  const handleAddToClaude = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpClaudeAdd) return;
    setActionMessage(null);
    setIsAddingClaude(true);
    try {
      const result = await bridge.externalMcpClaudeAdd() as ClientSetupStatus;
      setClaudeStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.claudeAdded") });
      } else if (result.state === "claude_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installClaude") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingClaude(false);
    }
  }, [refreshStatus, t]);

  const handleAddToGrok = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpGrokAdd) return;
    setActionMessage(null);
    setIsAddingGrok(true);
    try {
      const result = await bridge.externalMcpGrokAdd() as ClientSetupStatus;
      setGrokStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.grokAdded") });
      } else if (result.state === "grok_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installGrok") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingGrok(false);
    }
  }, [refreshStatus, t]);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground leading-5">
          {t("ai.externalMcp.description")}
        </p>
        <div className={cn("text-xs font-medium shrink-0", bridgeStatusView.className)}>
          {t(bridgeStatusView.labelKey)}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-background/70 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.externalMcp.title")}</div>
          <div className="text-xs text-muted-foreground">
            {t("ai.externalMcp.sessionsExposed", { count: String(exposedSessionCount) })}
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(nextEnabled) => {
            setActionMessage(null);
            setEnabled(nextEnabled);
            window.setTimeout(() => { void refreshStatus(); }, 0);
          }}
        />
      </div>

      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("ai.externalMcp.mode")}</div>
            <div className="text-xs text-muted-foreground">{t("ai.externalMcp.mode.description")}</div>
          </div>
          <Select
            value={mode}
            options={[
              { value: "temporary", label: t("ai.externalMcp.mode.temporary") },
              { value: "persistent", label: t("ai.externalMcp.mode.persistent") },
            ]}
            onChange={(value) => setMode(value === "persistent" ? "persistent" : "temporary")}
            className="w-36"
          />
        </div>
        {mode === "temporary" ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("ai.externalMcp.idleTimeout")}</div>
              <div className="text-xs text-muted-foreground">{t("ai.externalMcp.idleTimeout.description")}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={1}
                max={24 * 60}
                value={idleTimeoutMinutes}
                onChange={(event) => {
                  const minutes = Number.parseInt(event.currentTarget.value, 10);
                  if (!Number.isFinite(minutes)) return;
                  setIdleTimeoutMinutes(minutes);
                }}
                className="w-20 rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
              />
              <span className="text-xs text-muted-foreground">{t("ai.externalMcp.idleTimeout.minutes")}</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-1.5 text-xs text-muted-foreground leading-5">
        <div className="text-sm font-medium text-foreground">{t("ai.externalMcp.usage.title")}</div>
        <p>{t("ai.externalMcp.usage.keepRunning")}</p>
        <p>{t("ai.externalMcp.usage.localhost")}</p>
        <p>{t("ai.externalMcp.usage.permissions")}</p>
        <p>{t("ai.externalMcp.usage.capabilities")}</p>
      </div>

      <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-1.5 text-xs text-muted-foreground leading-5">
        <div className="text-sm font-medium text-foreground">{t("ai.externalMcp.security")}</div>
        <p>{t("ai.externalMcp.security.description")}</p>
        {status?.permissionMode ? (
          <p>{t("ai.externalMcp.permissionMode", { mode: status.permissionMode })}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">{t("ai.externalMcp.discovery")}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshStatus()}
            disabled={isRefreshing}
          >
            <RefreshCw size={14} className={cn("mr-2", isRefreshing && "animate-spin")} />
            {t("ai.externalMcp.refresh")}
          </Button>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{t("ai.externalMcp.launcher")}</div>
              <div className="font-mono text-xs break-all">
                {launcherPath || t("ai.externalMcp.unavailable")}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!launcherPath}
              onClick={() => void copyText("launcher", launcherPath || "")}
            >
              <Copy size={14} className="mr-1" />
              {copied === "launcher" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{t("ai.externalMcp.discovery")}</div>
              <div className="font-mono text-xs break-all">
                {status?.discoveryPath || t("ai.externalMcp.unavailable")}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!status?.discoveryPath}
              onClick={() => void copyText("discovery", status?.discoveryPath || "")}
            >
              <Copy size={14} className="mr-1" />
              {copied === "discovery" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
            </Button>
          </div>
          {!enabled ? (
            <p className="text-xs text-amber-500">{t("ai.externalMcp.enableForLauncher")}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">{t("ai.externalMcp.clientConfiguration")}</div>
        <p className="text-xs text-muted-foreground">{t("ai.externalMcp.clientConfiguration.description")}</p>
        <Select
          value={selectedClient}
          options={[
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
            { value: "grok", label: "Grok" },
          ]}
          onChange={(value) => {
            if (value === "claude") setSelectedClient("claude");
            else if (value === "grok") setSelectedClient("grok");
            else setSelectedClient("codex");
          }}
          className="w-48"
        />
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className={cn("text-xs font-medium", selectedClientStatusView.className)}>
              {t(selectedClientStatusView.labelKey)}
            </div>
            {selectedClient === "codex" ? (
              <Button
                size="sm"
                disabled={!canAddToCodex || isAddingCodex || !enabled || !launcherPath}
                onClick={() => void handleAddToCodex()}
              >
                {t("ai.externalMcp.addToCodex")}
              </Button>
            ) : selectedClient === "claude" ? (
              <Button
                size="sm"
                disabled={!canAddToClaude || isAddingClaude || !enabled || !launcherPath}
                onClick={() => void handleAddToClaude()}
              >
                {t("ai.externalMcp.addToClaude")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canAddToGrok || isAddingGrok || !enabled || !launcherPath}
                onClick={() => void handleAddToGrok()}
              >
                {t("ai.externalMcp.addToGrok")}
              </Button>
            )}
          </div>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 font-mono text-xs break-all">
              {selectedClientCommand}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selectedClientCommand}
              onClick={() => void copyText("command", selectedClientCommand)}
            >
              <Copy size={14} className="mr-1" />
              {copied === "command" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
            </Button>
          </div>
          {selectedClient === "codex" && codexTomlSnippet ? (
            <div className="flex items-start justify-between gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {codexTomlSnippet}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyText("toml", codexTomlSnippet)}
              >
                <Copy size={14} className="mr-1" />
                {copied === "toml" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
              </Button>
            </div>
          ) : null}
          {selectedClient === "grok" && grokTomlSnippet ? (
            <div className="flex items-start justify-between gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {grokTomlSnippet}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyText("grok-toml", grokTomlSnippet)}
              >
                <Copy size={14} className="mr-1" />
                {copied === "grok-toml" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
              </Button>
            </div>
          ) : null}
          {selectedClient === "claude" && claudeSnippet ? (
            <div className="flex items-start justify-between gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {claudeSnippet}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyText("json", claudeSnippet)}
              >
                <Copy size={14} className="mr-1" />
                {copied === "json" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
              </Button>
            </div>
          ) : null}
        </div>
        {cursorSnippet ? (
          <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-2">
            <div className="text-xs font-medium">{t("ai.externalMcp.cursor.title")}</div>
            <p className="text-xs text-muted-foreground">{t("ai.externalMcp.cursor.description")}</p>
            <div className="flex items-start justify-between gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {cursorSnippet}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyText("cursor", cursorSnippet)}
              >
                <Copy size={14} className="mr-1" />
                {copied === "cursor" ? t("ai.externalMcp.copied") : t("ai.externalMcp.copy")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {actionMessage ? (
        <div
          className={cn(
            "text-xs",
            actionMessage.tone === "success" && "text-emerald-500",
            actionMessage.tone === "warning" && "text-amber-500",
            actionMessage.tone === "error" && "text-destructive",
          )}
        >
          {actionMessage.text}
        </div>
      ) : null}
      {status?.error ? (
        <div className="text-xs text-destructive">{status.error}</div>
      ) : null}
    </div>
  );
};
