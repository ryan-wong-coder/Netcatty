/**
 * MCP Server Bridge — TCP host in Electron main process
 *
 * Starts a local TCP server that the netcatty-mcp-server.cjs child process
 * connects to. Handles JSON-RPC calls by dispatching to real terminal sessions.
 */
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { existsSync } = require("node:fs");

const { toUnpackedAsarPath, getFreshIdlePrompt, formatSyntheticEcho } = require("./ai/shellUtils.cjs");
const { appendVaultAgentGuidance } = require("../shared/vaultAgentGuidance.cjs");
const { execViaPty, startPtyJob, execViaChannel, execViaRawPty } = require("./ai/ptyExec.cjs");
const { safeSend } = require("./ipcUtils.cjs");
const { getCliDiscoveryFilePath } = require("../cli/discoveryPath.cjs");
const { EXTERNAL_MCP_CHAT_SESSION_ID } = require("../cli/externalMcpDiscoveryPath.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const portForwardingBridge = require("./portForwardingBridge.cjs");

const DEBUG_MCP = process.env.NETCATTY_MCP_DEBUG === "1";

/** Optional external-MCP activity / host-ready hooks (set by externalMcpController). */
let externalMcpActivityHook = null;
let externalMcpHostReadyHook = null;

function debugLog(...args) {
  if (!DEBUG_MCP) return;
  console.error("[MCP Bridge:debug]", ...args);
}

let sessions = null;   // Map<sessionId, { sshClient, stream, pty, proc, conn, ... }>
let terminalWorkerManager = null;
let fileTransferBridge = null;
let tcpServer = null;
let tcpPort = null;
let authToken = null;  // Random token generated when TCP server starts
// Dedicated token for External MCP discovery. Rotated on enable/disable so a
// stale discovery file cannot keep writing after External MCP is turned off.
let externalAuthToken = null;
let pendingHostStart = null; // { promise, server, cancel }
let electronModule = null;
let cliDiscoveryFilePath = getCliDiscoveryFilePath();

// Track which sockets have completed authentication
const authenticatedSockets = new WeakSet();
// Sockets authenticated with the External MCP token (or that used the reserved scope).
const externalMcpSockets = new Set();

function markExternalMcpSocket(socket) {
  if (!socket || socket.destroyed) return;
  externalMcpSockets.add(socket);
  if (!socket.__netcattyExternalMcpCleanupBound) {
    socket.__netcattyExternalMcpCleanupBound = true;
    const cleanup = () => {
      externalMcpSockets.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("end", cleanup);
    socket.once("error", cleanup);
  }
}

function issueExternalMcpAuthToken() {
  externalAuthToken = crypto.randomBytes(32).toString("hex");
  return externalAuthToken;
}

function revokeExternalMcpAuthToken() {
  externalAuthToken = null;
}

function getExternalMcpAuthToken() {
  return externalAuthToken;
}

function disconnectExternalMcpClients() {
  // Prefer soft revoke: keep long-lived stdio MCP TCP sockets alive so
  // re-enable can resume without restarting Codex/Claude/Grok. Hard destroy
  // is reserved for process shutdown paths that call this intentionally.
  for (const socket of Array.from(externalMcpSockets)) {
    externalMcpSockets.delete(socket);
    try {
      if (!socket.destroyed) socket.destroy();
    } catch {
      // Ignore destroy failures while revoking external clients.
    }
  }
}

// Per-scope metadata: chatSessionId → { sessionIds: string[], metadata: Map<sessionId, meta> }
// Each chat session only sees the hosts registered for its scope.
const scopedMetadata = new Map();
const scopedAttachments = new Map(); // chatSessionId -> Map<filePath, attachment>
const { createSessionOwnershipRegistry } = require("./mcpServerBridge/sessionOwnership.cjs");
const {
  createSessionIdleManager,
  normalizeSessionIdleTimeoutMinutes,
} = require("./mcpServerBridge/sessionIdleManager.cjs");
const openedSessionOwnership = createSessionOwnershipRegistry();

// Command safety checking (reuse from aiBridge)
let commandBlocklist = [];
// Cached compiled RegExp objects for commandBlocklist (rebuilt when blocklist changes)
let compiledBlocklist = [];

// Command timeout in milliseconds (default 60s, synced from user settings)
const MAX_COMMAND_TIMEOUT_SECONDS = 24 * 60 * 60;
let commandTimeoutMs = 60000;

// Max iterations for AI agent loops (default 20, synced from user settings)
let maxIterations = 20;

// Permission mode: 'observer' | 'confirm' | 'auto' (synced from user settings)
let permissionMode = "confirm";

// Cached permission grants synced from renderer (confirm-mode memory table)
let permissionGrantsSnapshot = [];

// Track active PTY executions for cancellation
const activePtyExecs = new Map(); // marker → { ptyStream, cleanup }
const cancelledChatSessions = new Set();
const activeExecChatSessions = new Map(); // chatSessionId -> { sessionId, command, startedAt }
const backgroundJobs = new Map(); // jobId -> job metadata
const workerBackgroundJobs = new Map(); // jobId -> { chatSessionId, sessionId }
const pendingWorkerJobStarts = new Map(); // sessionId -> Set<{ chatSessionId, cancelled }>
const activeSessionExecutions = new Map(); // sessionId -> { kind, startedAt, token }
const activeSessionSftpOps = new Map(); // opId -> { chatSessionId, sessionId, cancel }
const closingTerminalSessions = new Map(); // sessionId -> overlapping close request count
const pendingSessionWriteApprovals = new Map(); // sessionId -> method
const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 256 * 1024;
const SESSION_CLOSE_CLEANUP_TIMEOUT_MS = 5000;
let activeSftpOpSeq = 0;

// ── Approval gate (for confirm mode with SDK/MCP agents) ──
let getMainWindowFn = null; // () => BrowserWindow | null
const pendingApprovals = new Map(); // approvalId → { resolve, chatSessionId }
let approvalIdCounter = 0;

function setMainWindowGetter(fn) {
  getMainWindowFn = fn;
  debugLog("setMainWindowGetter", { hasGetter: typeof fn === "function" });
}

/**
 * Request approval from the renderer process.
 * Sends an IPC event and returns a Promise<boolean> that resolves
 * when the user approves/rejects in the UI, or auto-denies after timeout.
 */
// External SDK agents (for example Codex) may give up on MCP tool calls after
// about 120 seconds; see openai/codex#6127 ("timed out awaiting tools/call
// after 120s"). Keep the Netcatty-side approval window below that with a small
// buffer so a stale approval cannot still be accepted after the agent has
// already timed out and abandoned the call.
const { MCP_APPROVAL_TIMEOUT_MS } = require("../shared/approvalConstants.cjs");
const APPROVAL_TIMEOUT_MS = MCP_APPROVAL_TIMEOUT_MS;

function listApprovalTargetWindows() {
  const windows = [];
  const seen = new Set();
  const push = (win) => {
    if (!win || win.isDestroyed?.()) return;
    const id = win.webContents?.id;
    if (id != null && seen.has(id)) return;
    if (id != null) seen.add(id);
    windows.push(win);
  };
  try {
    if (typeof getMainWindowFn === "function") push(getMainWindowFn());
  } catch { /* ignore */ }
  try {
    const windowManager = require("./windowManager.cjs");
    push(windowManager.getSettingsWindow?.());
  } catch { /* ignore */ }
  return windows;
}

function broadcastApprovalEvent(channel, payload) {
  for (const win of listApprovalTargetWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch { /* ignore */ }
  }
}

function requestApprovalFromRenderer(toolName, args, chatSessionId) {
  return new Promise((resolve) => {
    debugLog("requestApprovalFromRenderer", { toolName, args, chatSessionId });
    const targets = listApprovalTargetWindows();
    if (targets.length === 0) {
      // No renderer available — deny to preserve confirm mode safety guarantee
      resolve(false);
      return;
    }
    const approvalId = `mcp_approval_${++approvalIdCounter}_${Date.now()}`;

    // Auto-deny after timeout so SDK/MCP tool calls don't hang indefinitely
    const timerId = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve(false);
        // Notify renderer(s) to remove the stale approval card
        broadcastApprovalEvent('netcatty:ai:mcp:approval-cleared', { approvalIds: [approvalId] });
      }
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(approvalId, {
      resolve: (approved) => {
        clearTimeout(timerId);
        resolve(approved);
      },
      chatSessionId: chatSessionId || null,
    });
    broadcastApprovalEvent('netcatty:ai:mcp:approval-request', {
      approvalId,
      toolName,
      args,
      chatSessionId: chatSessionId || undefined,
    });
  });
}

function resolveApprovalFromRenderer(approvalId, approved) {
  debugLog("resolveApprovalFromRenderer", { approvalId, approved });
  const entry = pendingApprovals.get(approvalId);
  if (entry) {
    pendingApprovals.delete(approvalId);
    entry.resolve(approved);
    // Main + settings both receive approval requests; clear the sibling card.
    notifyRendererApprovalCleared([approvalId]);
  }
}

function notifyRendererApprovalCleared(approvalIds) {
  if (!Array.isArray(approvalIds) || approvalIds.length === 0) return;
  broadcastApprovalEvent("netcatty:ai:mcp:approval-cleared", { approvalIds });
}

/**
 * Clear pending MCP approvals, optionally scoped to a specific chatSessionId.
 * Resolves matched entries with false (denied) to unblock hanging promises.
 */
function clearPendingApprovals(chatSessionId) {
  const clearedIds = [];
  if (!chatSessionId) {
    for (const [id, entry] of pendingApprovals) {
      entry.resolve(false);
      clearedIds.push(id);
    }
    pendingApprovals.clear();
    notifyRendererApprovalCleared(clearedIds);
    return;
  }
  for (const [id, entry] of pendingApprovals) {
    if (entry.chatSessionId === chatSessionId) {
      pendingApprovals.delete(id);
      entry.resolve(false);
      clearedIds.push(id);
    }
  }
  notifyRendererApprovalCleared(clearedIds);
}

function cancelAllPtyExecs() {
  for (const [marker, entry] of activePtyExecs) {
    try {
      if (typeof entry.cancel === "function") entry.cancel();
      else entry.cleanup();
    } catch { /* ignore */ }
    activePtyExecs.delete(marker);
  }
  activePtyExecs.clear();
}

/**
 * Cancel PTY executions scoped to a specific chat session.
 * Only affects entries whose chatSessionId matches.
 */
function cancelPtyExecsForSession(chatSessionId) {
  if (!chatSessionId) return;
  for (const [marker, entry] of activePtyExecs) {
    if (entry.chatSessionId !== chatSessionId) continue;
    try {
      if (typeof entry.cancel === "function") entry.cancel();
      else entry.cleanup();
    } catch { /* ignore */ }
    activePtyExecs.delete(marker);
  }
}

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const backgroundJobApi = createBackgroundJobApi({
  get activeSftpOpSeq() { return activeSftpOpSeq; },
  set activeSftpOpSeq(value) { activeSftpOpSeq = value; },
  backgroundJobs, activeSessionSftpOps, activeSessionExecutions, closingTerminalSessions, crypto,
  BACKGROUND_JOB_RETENTION_MS, DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS, MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  SESSION_CLOSE_CLEANUP_TIMEOUT_MS,
  debugLog, sftpBridge,
});
const {
  createBackgroundJobId,
  cancelBackgroundJobsForSession,
  cancelBackgroundJobsForTerminalSession,
  settleBackgroundJobsForTerminalSession,
  registerSftpOp,
  cancelSftpOpsForSession,
  cancelSftpOpsForTerminalSession,
  beginTerminalSessionClose,
  endTerminalSessionClose,
  cancelAllSftpOps,
  readBackgroundJobSnapshot,
  createOutputWindow,
  refreshRunningJobSnapshot,
  storeCompletedJobOutput,
  pruneCompletedBackgroundJobs,
  collapseCarriageReturns,
  serializeBackgroundJob,
  describeActiveSessionExecution,
  getSessionBusyError,
  reserveSessionExecution,
  releaseSessionExecution,
} = backgroundJobApi;

function init(deps) {
  sessions = deps.sessions;
  terminalWorkerManager = deps.terminalWorkerManager || null;
  fileTransferBridge = deps.transferBridge || null;
  electronModule = deps.electronModule || null;
  cliDiscoveryFilePath = deps.cliDiscoveryFilePath || getCliDiscoveryFilePath();
  debugLog("init", { hasSessions: Boolean(sessions), hasElectron: Boolean(electronModule) });
  if (deps.commandBlocklist) {
    commandBlocklist = deps.commandBlocklist;
  }
}

function writeCliDiscoveryFile() {
  if (!tcpPort || !authToken || !cliDiscoveryFilePath) return;
  const payload = {
    port: tcpPort,
    token: authToken,
    pid: process.pid,
    permissionMode,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(cliDiscoveryFilePath), { recursive: true });
    fs.writeFileSync(cliDiscoveryFilePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("[MCP Bridge] Failed to write AI CLI discovery file:", err?.message || err);
  }
}

function removeCliDiscoveryFile() {
  if (!cliDiscoveryFilePath) return;
  try {
    fs.rmSync(cliDiscoveryFilePath, { force: true });
  } catch (err) {
    console.error("[MCP Bridge] Failed to remove AI CLI discovery file:", err?.message || err);
  }
}

function shutdownHost({ preserveScopedMetadata = false } = {}) {
  removeCliDiscoveryFile();
  authToken = null;
  if (pendingHostStart?.server && pendingHostStart.server !== tcpServer) {
    const inFlightStart = pendingHostStart;
    pendingHostStart = null;
    inFlightStart.cancel?.();
  }
  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
    tcpPort = null;
  }
  clearPendingApprovals();
  cancelAllPtyExecs();
  void cancelAllSftpOps();
  cancelledChatSessions.clear();
  activeExecChatSessions.clear();
  pendingSessionWriteApprovals.clear();
  if (!preserveScopedMetadata) {
    scopedMetadata.clear();
    scopedAttachments.clear();
  }
  for (const [, job] of backgroundJobs) {
    try {
      job.handle?.cancel?.();
    } catch {
      // Ignore cancellation failures during cleanup
    }
  }
  backgroundJobs.clear();
  pendingWorkerJobStarts.clear();
  activeSessionExecutions.clear();
  sessionIdleManager.clearAll();
}

function echoCommandToSession(session, sessionId, command) {
  if (!electronModule || !session?.webContentsId || !command) return;
  const contents = electronModule.webContents?.fromId?.(session.webContentsId);
  safeSend(contents, "netcatty:data", {
    sessionId,
    data: formatSyntheticEcho(command),
    syntheticEcho: true,
  });
}

function setCommandBlocklist(list) {
  commandBlocklist = list || [];
  // Recompile cached regexes when blocklist changes
  compiledBlocklist = [];
  for (const pattern of commandBlocklist) {
    try {
      compiledBlocklist.push(new RegExp(pattern, "i"));
    } catch {
      compiledBlocklist.push(null); // placeholder for invalid patterns
    }
  }
}

function setCommandTimeout(seconds) {
  commandTimeoutMs = Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_SECONDS, seconds || 60)) * 1000;
}

function getCommandTimeoutMs() {
  return commandTimeoutMs;
}

function setSessionIdleTimeoutMinutes(minutes) {
  return sessionIdleManager.setTimeoutMinutes(
    normalizeSessionIdleTimeoutMinutes(minutes),
  );
}

function getSessionIdleTimeoutMinutes() {
  return sessionIdleManager.getTimeoutMinutes();
}

function setMaxIterations(value) {
  maxIterations = Math.max(1, Math.min(100, value || 20));
}

function getMaxIterations() {
  return maxIterations;
}

function setPermissionMode(mode) {
  if (mode === "observer" || mode === "confirm" || mode === "auto") {
    permissionMode = mode;
    writeCliDiscoveryFile();
    try {
      if (typeof externalMcpActivityHook?.onPermissionModeChanged === "function") {
        externalMcpActivityHook.onPermissionModeChanged();
      }
    } catch {
      // External MCP permission sync is best-effort.
    }
  }
}

function setExternalMcpHooks(hooks = null) {
  externalMcpActivityHook = hooks && typeof hooks === "object" ? hooks : null;
  externalMcpHostReadyHook = typeof hooks?.onBridgeHostReady === "function"
    ? hooks.onBridgeHostReady.bind(hooks)
    : null;
}

function notifyExternalMcpActivity(method, params) {
  try {
    const chatSessionId = params?.chatSessionId || null;
    if (chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID) {
      externalMcpActivityHook?.recordActivity?.({ method, chatSessionId });
    }
  } catch {
    // Ignore activity hook failures.
  }
}

/**
 * Build MCP session metadata from the live main-process session map and
 * register it under the reserved external MCP chat scope.
 */
function syncLiveSessionsToExternalScope(chatSessionId = EXTERNAL_MCP_CHAT_SESSION_ID) {
  const existingScoped = scopedMetadata.get(chatSessionId);
  const existingMeta = existingScoped?.metadata || new Map();
  const sessionList = [];
  if (sessions && typeof sessions.entries === "function") {
    for (const [sessionId, session] of sessions.entries()) {
      if (!session || typeof session !== "object") continue;
      const previous = existingMeta.get(sessionId) || findSessionMetaAcrossScopes(sessionId) || {};
      sessionList.push({
        sessionId,
        hostId: session.hostId || previous.hostId || "",
        hostname: session.hostname || session.host || previous.hostname || "",
        label: session.label || session.hostname || previous.label || sessionId,
        os: session.os || previous.os || "",
        username: session.username || previous.username || "",
        protocol: session.protocol || session.type || previous.protocol || "",
        shellType: session.shellKind || session.shellType || previous.shellType || "",
        deviceType: session.deviceType || previous.deviceType || "",
        connected: session.connected !== false,
        hostChain: Array.isArray(session.hostChain)
          ? session.hostChain
          : (Array.isArray(previous.hostChain) ? previous.hostChain : []),
        activePortForwards: Array.isArray(session.activePortForwards)
          ? session.activePortForwards
          : (Array.isArray(previous.activePortForwards) ? previous.activePortForwards : []),
      });
    }
  }
  // Terminal-worker mode keeps live sessions off the main-process map. Do not
  // wipe renderer-pushed external scope metadata with an empty live snapshot.
  if (sessionList.length === 0) {
    if (existingScoped?.sessionIds?.length) {
      return {
        ok: true,
        count: existingScoped.sessionIds.length,
        chatSessionId,
        preserved: true,
      };
    }
    // Only seed when the external scope key has never been written. An explicit
    // empty updateSessionMetadata([]) must stay empty (authoritative clear).
    if (!scopedMetadata.has(chatSessionId)) {
      const seeded = seedExternalScopeFromOtherScopes(chatSessionId);
      if (seeded) {
        return {
          ok: true,
          count: seeded,
          chatSessionId,
          seeded: true,
        };
      }
    }
    return { ok: true, count: 0, chatSessionId };
  }
  updateSessionMetadata(sessionList, chatSessionId);
  return { ok: true, count: sessionList.length, chatSessionId };
}

function findSessionMetaAcrossScopes(sessionId) {
  for (const scoped of scopedMetadata.values()) {
    const meta = scoped?.metadata?.get?.(sessionId);
    if (meta) return meta;
  }
  return null;
}

function seedExternalScopeFromOtherScopes(chatSessionId) {
  const byId = new Map();
  for (const [scopeId, scoped] of scopedMetadata.entries()) {
    if (scopeId === chatSessionId || !scoped?.metadata) continue;
    for (const [sessionId, meta] of scoped.metadata.entries()) {
      if (!sessionId || !meta) continue;
      if (!byId.has(sessionId)) {
        byId.set(sessionId, { sessionId, ...meta });
      }
    }
  }
  if (byId.size === 0) return 0;
  updateSessionMetadata(Array.from(byId.values()), chatSessionId);
  return byId.size;
}

function getPermissionMode() {
  return permissionMode;
}

function setChatSessionCancelled(chatSessionId, cancelled) {
  if (!chatSessionId) return;
  if (cancelled) {
    cancelledChatSessions.add(chatSessionId);
  } else {
    cancelledChatSessions.delete(chatSessionId);
  }
}

function isChatSessionCancelled(chatSessionId) {
  return Boolean(chatSessionId && cancelledChatSessions.has(chatSessionId));
}

function getActiveChatExecution(chatSessionId) {
  if (!chatSessionId) return null;
  return activeExecChatSessions.get(chatSessionId) || null;
}

function beginChatExecution(chatSessionId, sessionId, command) {
  if (!chatSessionId) return { ok: true, release: () => {} };
  const active = getActiveChatExecution(chatSessionId);
  if (active) {
    return {
      ok: false,
      active,
    };
  }
  activeExecChatSessions.set(chatSessionId, {
    sessionId,
    command,
    startedAt: Date.now(),
  });
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const current = activeExecChatSessions.get(chatSessionId);
      if (current && current.sessionId === sessionId && current.command === command) {
        activeExecChatSessions.delete(chatSessionId);
      }
    },
  };
}

/**
 * Register metadata for terminal sessions (called from renderer via IPC).
 * Metadata is stored per-scope (chatSessionId) so different AI chat sessions
 * only see their own hosts.
 * @param {Array<{sessionId, hostname, label, os, username, connected, protocol?, shellType?}>} sessionList
 * @param {string} [chatSessionId] - AI chat session ID for per-scope isolation
 */
function updateSessionMetadata(sessionList, chatSessionId) {
  debugLog("updateSessionMetadata", {
    chatSessionId,
    count: Array.isArray(sessionList) ? sessionList.length : 0,
    sessionIds: Array.isArray(sessionList) ? sessionList.map(s => s.sessionId) : [],
  });
  const ids = sessionList.map(s => s.sessionId);
  const metaMap = new Map();
  for (const s of sessionList) {
    metaMap.set(s.sessionId, {
      hostname: s.hostname || "",
      label: s.label || "",
      os: s.os || "",
      username: s.username || "",
      protocol: s.protocol || "",
      shellType: s.shellType || "",
      deviceType: s.deviceType || "",
      connected: s.connected !== false,
      hostId: s.hostId || "",
      hostChain: Array.isArray(s.hostChain) ? s.hostChain : [],
      activePortForwards: Array.isArray(s.activePortForwards) ? s.activePortForwards : [],
    });
  }

  // Store per-scope metadata when chatSessionId is provided
  if (chatSessionId) {
    scopedMetadata.set(chatSessionId, { sessionIds: ids, metadata: metaMap });
  }
}

/**
 * Merge session metadata into an existing chat scope without dropping
 * previously known sessions. Used for the app-wide External MCP scope so a
 * single Catty sidebar push cannot shrink the exposed host set.
 */
function mergeSessionMetadata(sessionList, chatSessionId) {
  if (!chatSessionId || !Array.isArray(sessionList)) return { ok: false, count: 0 };
  const existing = scopedMetadata.get(chatSessionId);
  const byId = new Map();
  if (existing?.metadata) {
    for (const [sessionId, meta] of existing.metadata.entries()) {
      byId.set(sessionId, { sessionId, ...meta });
    }
  }
  for (const entry of sessionList) {
    if (!entry || typeof entry !== "object" || !entry.sessionId) continue;
    const previous = byId.get(entry.sessionId) || {};
    byId.set(entry.sessionId, {
      sessionId: entry.sessionId,
      hostname: entry.hostname || previous.hostname || "",
      label: entry.label || previous.label || "",
      os: entry.os || previous.os || "",
      username: entry.username || previous.username || "",
      protocol: entry.protocol || previous.protocol || "",
      shellType: entry.shellType || previous.shellType || "",
      deviceType: entry.deviceType || previous.deviceType || "",
      connected: entry.connected !== undefined ? entry.connected !== false : previous.connected !== false,
      hostId: entry.hostId || previous.hostId || "",
      hostChain: Array.isArray(entry.hostChain)
        ? entry.hostChain
        : (Array.isArray(previous.hostChain) ? previous.hostChain : []),
      activePortForwards: Array.isArray(entry.activePortForwards)
        ? entry.activePortForwards
        : (Array.isArray(previous.activePortForwards) ? previous.activePortForwards : []),
    });
  }
  updateSessionMetadata(Array.from(byId.values()), chatSessionId);
  return { ok: true, count: byId.size };
}

function normalizeAttachmentEntry(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  const filename = String(attachment.filename || "attachment").trim() || "attachment";
  const mediaType = String(attachment.mediaType || "application/octet-stream").trim() || "application/octet-stream";
  const base64Data = typeof attachment.base64Data === "string" ? attachment.base64Data : "";
  const filePathValue = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";
  if (!base64Data && !filePathValue) return null;
  let resolvedPath = filePathValue;
  if (filePathValue) {
    try {
      resolvedPath = path.resolve(filePathValue);
    } catch {
      resolvedPath = filePathValue;
    }
  }
  const sizeBytes = base64Data ? Buffer.byteLength(base64Data, "base64") : undefined;
  return {
    filename,
    mediaType,
    filePath: resolvedPath,
    base64Data,
    sizeBytes,
  };
}

function updateAttachmentMetadata(attachments, chatSessionId) {
  if (!chatSessionId || !Array.isArray(attachments)) return;
  const existing = scopedAttachments.get(chatSessionId) || new Map();
  for (const attachment of attachments) {
    const normalized = normalizeAttachmentEntry(attachment);
    if (!normalized) continue;
    const key = normalized.filePath || normalized.filename;
    existing.set(key, normalized);
  }
  scopedAttachments.set(chatSessionId, existing);
}

function getScopedAttachments(chatSessionId) {
  if (!chatSessionId) return [];
  return Array.from(scopedAttachments.get(chatSessionId)?.values() || []);
}

function attachmentSummary(attachment) {
  return {
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    filePath: attachment.filePath || undefined,
    sizeBytes: attachment.sizeBytes,
  };
}

function handleListAttachments(params) {
  const chatSessionId = params?.chatSessionId;
  if (!chatSessionId || typeof chatSessionId !== "string") {
    return { ok: false, error: "chatSessionId is required." };
  }
  return {
    ok: true,
    attachments: getScopedAttachments(chatSessionId).map(attachmentSummary),
  };
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".jsonl", ".yaml", ".yml",
  ".toml", ".ini", ".csv", ".tsv", ".xml", ".html", ".css", ".js", ".jsx",
  ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".zsh", ".fish",
  ".rs", ".go", ".java", ".kt", ".rb", ".php", ".sql", ".log", ".conf",
  ".cfg", ".env", ".gitignore",
]);

function isLikelyTextAttachment(mediaType, filename) {
  return /^text\//i.test(mediaType)
    || /^(application\/(json|xml|javascript|x-javascript|typescript|yaml|x-yaml|toml|csv|x-ndjson|ndjson))$/i.test(mediaType)
    || /\+(json|xml)$/i.test(mediaType)
    || TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(filename || "").toLowerCase());
}

function findRegisteredAttachment(params) {
  const chatSessionId = params?.chatSessionId;
  if (!chatSessionId || typeof chatSessionId !== "string") {
    return { error: "chatSessionId is required." };
  }
  const attachments = getScopedAttachments(chatSessionId);
  const requestedPath = typeof params.filePath === "string" && params.filePath.trim()
    ? path.resolve(params.filePath.trim())
    : "";
  const requestedName = typeof params.filename === "string" ? params.filename.trim() : "";
  if (!requestedPath && !requestedName) {
    return { error: "filePath or filename is required." };
  }
  const attachment = attachments.find((entry) => (
    (requestedPath && entry.filePath === requestedPath)
    || (requestedName && entry.filename === requestedName)
  ));
  if (!attachment) {
    return { error: "Attachment is not registered for this chat session." };
  }
  return { attachment };
}

function handleReadAttachment(params) {
  const found = findRegisteredAttachment(params);
  if (found.error) return { ok: false, error: found.error };
  const attachment = found.attachment;
  let base64Data = attachment.base64Data;
  if (!base64Data && attachment.filePath) {
    try {
      base64Data = fs.readFileSync(attachment.filePath).toString("base64");
    } catch (err) {
      return { ok: false, error: err?.message || "Failed to read attachment." };
    }
  }
  if (!base64Data) return { ok: false, error: "Attachment content is unavailable." };
  const buffer = Buffer.from(base64Data, "base64");
  const result = {
    ok: true,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    filePath: attachment.filePath || undefined,
    sizeBytes: buffer.length,
    base64Data,
  };
  if (isLikelyTextAttachment(attachment.mediaType, attachment.filename)) {
    result.text = buffer.toString("utf8");
  }
  return result;
}

/**
 * Get scoped session IDs for a specific chat session.
 */
function getScopedSessionIds(chatSessionId) {
  if (!chatSessionId) return [];
  const scoped = scopedMetadata.get(chatSessionId);
  return scoped?.sessionIds || [];
}

/**
 * Resolve the effective session scope for a request.
 * Explicit per-call scopedSessionIds may only narrow the chat scope, never widen it.
 *
 * Returns:
 * - `null` when no scope context was provided at all
 * - `[]` when the effective scope is intentionally empty
 * - a concrete array of allowed session IDs otherwise
 */
function resolveScopedSessionIds(chatSessionId, explicitScopedIds = null) {
  const hasExplicitScope = Array.isArray(explicitScopedIds);
  const hasChatScope = typeof chatSessionId === "string" && chatSessionId.length > 0;

  if (!hasExplicitScope && !hasChatScope) {
    return null;
  }

  if (!hasChatScope) {
    return explicitScopedIds;
  }

  const chatScopedIds = getScopedSessionIds(chatSessionId);
  if (!hasExplicitScope) {
    return chatScopedIds;
  }

  const chatScopedSet = new Set(chatScopedIds);
  return explicitScopedIds.filter((sessionId) => chatScopedSet.has(sessionId));
}

/**
 * Look up metadata for a sessionId, scoped to a specific chat session.
 * Falls back to session object properties if no scoped metadata is found.
 */
function getSessionMeta(sessionId, chatSessionId) {
  if (!chatSessionId) return null;
  const scoped = scopedMetadata.get(chatSessionId);
  return scoped?.metadata?.get(sessionId) || null;
}

/**
 * Run an array of async task factories with a concurrency limit.
 */
function checkCommandSafety(command) {
  for (let i = 0; i < compiledBlocklist.length; i++) {
    const re = compiledBlocklist[i];
    if (re && re.test(command)) {
      return { blocked: true, matchedPattern: commandBlocklist[i] };
    }
  }
  return { blocked: false };
}

// ── TCP Server ──

function getOrCreateHost() {
  if (tcpServer && tcpPort) return Promise.resolve(tcpPort);
  if (pendingHostStart?.promise) return pendingHostStart.promise;

  // Generate a random auth token for this server instance
  authToken = crypto.randomBytes(32).toString("hex");

  const server = net.createServer((socket) => {
    debugLog("TCP client connected");
    handleConnection(socket);
  });
  const startState = {
    promise: null,
    server,
    cancel: null,
  };

  const startPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (pendingHostStart === startState) {
        pendingHostStart = null;
      }
      if (tcpServer !== server) {
        authToken = null;
      }
      reject(err);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (pendingHostStart === startState) {
        pendingHostStart = null;
      }
      resolve(value);
    };
    startState.cancel = () => {
      try {
        server.close();
      } catch {
        // Ignore close failures while aborting a host startup.
      }
      finishReject(new Error("TCP bridge startup cancelled"));
    };

    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        try {
          server.close();
        } catch {
          // Ignore close failures for a host that was already cancelled.
        }
        return;
      }
      tcpPort = server.address().port;
      tcpServer = server;
      debugLog("TCP server listening", { port: tcpPort });
      writeCliDiscoveryFile();
      try {
        externalMcpHostReadyHook?.({ port: tcpPort, token: authToken });
      } catch {
        // External MCP host-ready sync is best-effort.
      }
      finishResolve(tcpPort);
    });

    server.on("error", (err) => {
      console.error("[MCP Bridge] TCP server error:", err.message);
      finishReject(err);
    });
  });

  startState.promise = startPromise;
  pendingHostStart = startState;
  return startPromise;
}

const MAX_TCP_BUFFER = 10 * 1024 * 1024; // 10MB

function handleConnection(socket) {
  let buffer = "";
  socket.setEncoding("utf-8");

  socket.on("data", (chunk) => {
    if (buffer.length + chunk.length > MAX_TCP_BUFFER) {
      console.error("[MCP Bridge] TCP buffer exceeded max size, dropping connection");
      socket.destroy();
      return;
    }
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      debugLog("Incoming line", line);
      handleMessage(socket, line);
    }
  });

  socket.on("error", () => {
    // Client disconnected — nothing to do
  });
}

async function handleMessage(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  debugLog("handleMessage", { id, method, params });
  if (id == null || !method) return;

  // ── Authentication gate ──
  // The first message from any connection MUST be auth/verify with the correct token.
  // All other methods are rejected until the socket is authenticated.
  if (!authenticatedSockets.has(socket)) {
    const presentedToken = typeof params?.token === "string" ? params.token : "";
    const isCattyToken = Boolean(presentedToken && authToken && presentedToken === authToken);
    const isExternalToken = Boolean(
      presentedToken && externalAuthToken && presentedToken === externalAuthToken,
    );
    if (method === "auth/verify" && (isCattyToken || isExternalToken)) {
      if (isExternalToken && !externalMcpActivityHook?.isEnabled?.()) {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "External MCP is disabled. Re-enable it in Netcatty Settings → AI.",
          },
        }) + "\n";
        if (!socket.destroyed) {
          socket.write(response);
          socket.destroy();
        }
        return;
      }
      debugLog("auth/verify success", { external: isExternalToken });
      authenticatedSockets.add(socket);
      if (isExternalToken) {
        markExternalMcpSocket(socket);
      }
      const response = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) + "\n";
      if (!socket.destroyed) socket.write(response);
      return;
    }
    console.warn("[MCP Bridge] auth/verify failed or unexpected first method", method);
    // Wrong token or wrong method — reject and close
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message: "Authentication required. Send auth/verify with valid token first." },
    }) + "\n";
    if (!socket.destroyed) {
      socket.write(response);
      socket.destroy();
    }
    return;
  }

  try {
    const callParams = { ...(params || {}) };
    // External-token sockets always operate under the reserved app-wide scope so
    // callers cannot omit chatSessionId and widen access via scopedSessionIds.
    if (externalMcpSockets.has(socket)) {
      callParams.chatSessionId = EXTERNAL_MCP_CHAT_SESSION_ID;
    }
    const isExternalScope = callParams.chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID;
    if (isExternalScope) {
      markExternalMcpSocket(socket);
    }
    // External MCP clients keep an authenticated TCP socket after disable unless
    // we reject reserved-scope RPCs (and previously marked external sockets).
    if (
      (isExternalScope || externalMcpSockets.has(socket))
      && !externalMcpActivityHook?.isEnabled?.()
    ) {
      throw new Error(
        "External MCP is disabled. Re-enable it in Netcatty Settings → AI.",
      );
    }
    notifyExternalMcpActivity(method, callParams);
    const result = await dispatch(method, callParams);
    const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    if (!socket.destroyed) socket.write(response);
  } catch (err) {
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err?.message || String(err) },
    }) + "\n";
    if (!socket.destroyed) socket.write(response);
  }
}

// ── RPC Dispatch ──

const {
  evaluateRpcPermission,
  evaluatePermissionWithGrants,
  USER_DENIED_MESSAGE,
} = require("../capabilities/policy.cjs");
const { CAPABILITY_SURFACES } = require("../capabilities/constants.cjs");
const { getCapabilityByRpcMethod } = require("../capabilities/registry.cjs");
const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
const {
  createCapabilityRpcDispatcher,
  UNROUTED,
} = require("./mcpServerBridge/capabilityRpcDispatch.cjs");
const { buildBuiltinRpcHandlerRegistry } = require("./mcpServerBridge/builtinRpcHandlers.cjs");
const { createSessionService } = require("../capabilities/services/sessionService.cjs");

let invokeVaultAgentFn = null;

function setVaultAgentInvoker(fn) {
  invokeVaultAgentFn = typeof fn === "function" ? fn : null;
}

let sessionService = null;
const sessionIdleManager = createSessionIdleManager({
  onIdle: async ({ chatSessionId, sessionId }, activityVersion) => {
    const hasWorkerJob = await hasActiveWorkerJobForTerminalSession(sessionId);
    if (!sessionIdleManager.isIdleCheckCurrent(sessionId, activityVersion)) {
      return;
    }
    if (activeSessionExecutions.has(sessionId) || hasWorkerJob) {
      sessionIdleManager.resume(sessionId);
      return;
    }
    if (!sessionIdleManager.beginIdleClose(sessionId, activityVersion)) {
      return;
    }
    await sessionService?.closeTracked({ chatSessionId, sessionId });
  },
});

function reportOpenedSessionActivity(event = {}) {
  const sessionId = event?.sessionId;
  if (!sessionId) return false;
  if (event.phase === "begin") {
    return sessionIdleManager.beginActivity(null, sessionId);
  }
  if (event.phase === "end") {
    return sessionIdleManager.endActivity(null, sessionId);
  }
  return sessionIdleManager.touch(null, sessionId);
}

sessionService = createSessionService({
  invokeSessionAgent: (...args) => {
    if (typeof invokeVaultAgentFn !== "function") {
      return Promise.resolve({ ok: false, error: "Vault agent bridge is unavailable." });
    }
    return invokeVaultAgentFn(...args);
  },
  validateClose: (params = {}) => {
    const scopeErr = validateSessionScope(
      params.sessionId,
      params.chatSessionId,
      params.scopedSessionIds,
    );
    if (scopeErr) return { ok: false, error: scopeErr };
    if (sessionIdleManager.isClosing(params.sessionId)) {
      return { ok: false, error: `Session "${params.sessionId}" is closing.` };
    }
    return openedSessionOwnership.validate(params.chatSessionId, params.sessionId);
  },
  beforeClose: async (params = {}) => {
    sessionIdleManager.beginClose(params.sessionId);
    beginTerminalSessionClose(params.sessionId);
    cancelBackgroundJobsForTerminalSession(params.sessionId);
    await cancelWorkerBackgroundJobsForTerminalSession(params.sessionId);
    await cancelSftpOpsForTerminalSession(params.sessionId);
  },
  afterClose: (params = {}, outcome = {}) => {
    endTerminalSessionClose(params.sessionId);
    if (outcome.closed) return;
    if (outcome.notFound) {
      sessionIdleManager.forgetSession(params.sessionId);
      openedSessionOwnership.forgetSession(params.sessionId);
      return;
    }
    sessionIdleManager.resume(params.sessionId);
  },
  onClosed: async (sessionId) => {
    await settleBackgroundJobsForTerminalSession(sessionId);
    sessionIdleManager.forgetSession(sessionId);
    openedSessionOwnership.forgetSession(sessionId);
    for (const scoped of scopedMetadata.values()) {
      scoped.sessionIds = scoped.sessionIds.filter((id) => id !== sessionId);
      scoped.metadata.delete(sessionId);
    }
  },
});

const dispatchCapabilityRpc = createCapabilityRpcDispatcher({
  invokeVaultAgent: (...args) => {
    if (typeof invokeVaultAgentFn !== "function") {
      return Promise.resolve({ ok: false, error: "Vault agent bridge is unavailable." });
    }
    return invokeVaultAgentFn(...args);
  },
  evaluatePermissionWithGrants,
  get permissionMode() {
    return permissionMode;
  },
  get permissionGrantsSnapshot() {
    return permissionGrantsSnapshot;
  },
  isChatSessionCancelled,
  requestApprovalFromRenderer,
  USER_DENIED_MESSAGE,
  sessionService,
  captureHostOpenScope: (chatSessionId) => openedSessionOwnership.captureGeneration(chatSessionId),
  onHostOpened: (chatSessionId, sessionId, generation) => {
    openedSessionOwnership.register(chatSessionId, sessionId, generation);
    sessionIdleManager.track(chatSessionId, sessionId);
  },
});

/**
 * Validate that a sessionId is allowed in the current scope.
 * Explicit per-call scopedSessionIds can only narrow the effective scope;
 * they are intersected with per-chatSession scoped metadata when both exist.
 *
 * An explicit empty array (`[]`) means "no access" — not "fall through to
 * global scope" — matching the documented behavior in handleGetContext.
 */
function validateSessionScope(sessionId, chatSessionId, explicitScopedIds = null) {
  if (!sessionId) return null; // will fail at handler level
  const resolvedScopedIds = resolveScopedSessionIds(chatSessionId, explicitScopedIds);
  if (resolvedScopedIds === null) {
    return "chatSessionId or scopedSessionIds is required.";
  }
  debugLog("validateSessionScope", {
    sessionId,
    chatSessionId,
    explicitScopedIds,
    resolvedScopedIds,
  });
  if (!resolvedScopedIds.includes(sessionId)) {
    return `Session "${sessionId}" is not in the current scope.`;
  }
  return null;
}

function isNetworkDeviceLikeMeta(meta) {
  const protocol = meta?.protocol || "";
  const isSshOrSerial = protocol === "ssh" || protocol === "serial";
  return (meta?.deviceType === "network" && isSshOrSerial) || protocol === "serial";
}

function buildHostFromMetadata(sessionId, meta) {
  return {
    sessionId,
    hostname: meta.hostname || "",
    label: meta.label || "",
    os: meta.os || "",
    username: meta.username || "",
    protocol: meta.protocol || "",
    shellType: meta.shellType || "",
    deviceType: meta.deviceType || "",
    connected: meta.connected !== false,
    hostId: meta.hostId || "",
    hostChain: Array.isArray(meta.hostChain) ? meta.hostChain : [],
    activePortForwards: Array.isArray(meta.activePortForwards) ? meta.activePortForwards : [],
  };
}

function pickToolHints(toolMap, hints) {
  return Object.fromEntries(
    Object.entries(hints)
      .map(([key, capabilityId]) => [key, toolMap.get(capabilityId)])
      .filter(([, toolName]) => Boolean(toolName)),
  );
}

function buildMcpToolHints() {
  const toolMap = new Map(listMcpTools().map((tool) => [tool.capabilityId, tool.mcpTool]));

  return {
    environment: toolMap.get("session.environment"),
    terminal: pickToolHints(toolMap, {
      execute: "terminal.execute",
      start: "terminal.start",
      poll: "terminal.poll",
      stop: "terminal.stop",
    }),
    attachments: pickToolHints(toolMap, {
      list: "attachment.list",
      read: "attachment.read",
    }),
    sftp: pickToolHints(toolMap, {
      list: "sftp.list",
      read: "sftp.read",
      write: "sftp.write",
      download: "sftp.download",
      upload: "sftp.upload",
    }),
  };
}

function buildTerminalToolGuidance(toolHints) {
  const terminal = toolHints?.terminal || {};
  if (terminal.execute && terminal.start && terminal.poll && terminal.stop) {
    return `For terminal commands, use \`${terminal.execute}\` for short commands and \`${terminal.start}\`, \`${terminal.poll}\`, and \`${terminal.stop}\` for long-running commands. `;
  }
  if (Object.keys(terminal).length > 0) {
    return "For terminal commands, use the terminal tools listed in tools.terminal. ";
  }
  return "";
}

async function handleWorkerTerminalExec(params = {}) {
  const { sessionId, command } = params;
  if (!sessionId || !command) throw new Error("sessionId and command are required");
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, error: "Invalid command", exitCode: 1 };
  }
  if (!terminalWorkerManager?.request) {
    return { ok: false, error: "Session not found" };
  }

  const chatSessionId = params?.chatSessionId || null;
  const meta = getSessionMeta(sessionId, chatSessionId) || {};
  if (!isNetworkDeviceLikeMeta(meta)) {
    const safety = checkCommandSafety(command);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
    }
  }

  const reservation = reserveSessionExecution(sessionId, "exec");
  if (!reservation.ok) return reservation;
  const sessionToken = reservation.token;
  const executionLock = beginChatExecution(chatSessionId, sessionId, command);
  if (!executionLock.ok) {
    releaseSessionExecution(sessionId, sessionToken);
    return {
      ok: false,
      code: "COMMAND_ALREADY_RUNNING",
      error: `Another Netcatty command is already running for chat session "${chatSessionId}". Wait for it to finish before starting a new exec.`,
      activeCommand: executionLock.active.command,
      activeSessionId: executionLock.active.sessionId,
    };
  }

  try {
    return await terminalWorkerManager.request("netcatty:ai:exec", {
      sessionId,
      command,
      chatSessionId,
      commandTimeoutMs,
      sessionMeta: meta,
      enforceWallTimeout: true,
    }, {});
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    releaseSessionExecution(sessionId, sessionToken);
    executionLock.release();
  }
}

async function handleWorkerJobStart(params = {}) {
  const { sessionId, command } = params;
  if (!sessionId || !command) throw new Error("sessionId and command are required");
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, error: "Invalid command", exitCode: 1 };
  }
  if (!terminalWorkerManager?.request) {
    return { ok: false, error: "Session not found" };
  }
  if (closingTerminalSessions.has(sessionId)) {
    return { ok: false, error: `Session "${sessionId}" is closing.` };
  }

  const chatSessionId = params?.chatSessionId || null;
  const meta = getSessionMeta(sessionId, chatSessionId) || {};
  if (!isNetworkDeviceLikeMeta(meta)) {
    const safety = checkCommandSafety(command);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
    }
  }

  const pendingStart = { chatSessionId, cancelled: false };
  let pendingForSession = pendingWorkerJobStarts.get(sessionId);
  if (!pendingForSession) {
    pendingForSession = new Set();
    pendingWorkerJobStarts.set(sessionId, pendingForSession);
  }
  pendingForSession.add(pendingStart);

  try {
    const result = await terminalWorkerManager.request("netcatty:ai:jobStart", {
      sessionId,
      command,
      chatSessionId,
      commandTimeoutMs,
      sessionMeta: meta,
    }, {});
    if (result?.ok && result.jobId) {
      if (pendingStart.cancelled || closingTerminalSessions.has(sessionId)) {
        await waitForWorkerCleanup(terminalWorkerManager.request("netcatty:ai:jobStop", {
          jobId: result.jobId,
          sessionId,
          chatSessionId,
        }, {}));
        return { ok: false, error: "Session is closing.", jobId: result.jobId, status: "cancelled" };
      }
      workerBackgroundJobs.set(result.jobId, {
        chatSessionId: chatSessionId || null,
        sessionId,
      });
    }
    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    pendingForSession.delete(pendingStart);
    if (pendingForSession.size === 0) pendingWorkerJobStarts.delete(sessionId);
  }
}

function getWorkerJob(jobId, chatSessionId) {
  const job = workerBackgroundJobs.get(jobId);
  if (!job) return null;
  if (job.chatSessionId && (!chatSessionId || chatSessionId !== job.chatSessionId)) {
    return null;
  }
  return job;
}

async function handleWorkerJobPoll(params = {}) {
  const { jobId, chatSessionId, scopedSessionIds } = params || {};
  if (!jobId) throw new Error("jobId is required");
  const job = getWorkerJob(jobId, chatSessionId || null);
  if (!job || !terminalWorkerManager?.request) {
    return { ok: false, error: "Background job not found" };
  }
  if (job.sessionId) {
    const scopeErr = validateSessionScope(job.sessionId, chatSessionId || null, scopedSessionIds);
    if (scopeErr) return { ok: false, error: scopeErr };
  }
  const result = await terminalWorkerManager.request("netcatty:ai:jobPoll", params, {});
  if (result?.completed) {
    workerBackgroundJobs.delete(jobId);
  }
  return result;
}

async function handleWorkerJobStop(params = {}) {
  const { jobId, chatSessionId, scopedSessionIds } = params || {};
  if (!jobId) throw new Error("jobId is required");
  const job = getWorkerJob(jobId, chatSessionId || null);
  if (!job || !terminalWorkerManager?.request) {
    return { ok: false, error: "Background job not found" };
  }
  if (Array.isArray(scopedSessionIds) && job.sessionId && !scopedSessionIds.includes(job.sessionId)) {
    return { ok: false, error: `Session "${job.sessionId}" is not in the current scope.` };
  }
  const result = await terminalWorkerManager.request("netcatty:ai:jobStop", params, {});
  if (result?.completed) {
    workerBackgroundJobs.delete(jobId);
  }
  return result;
}

async function hasActiveWorkerJobForTerminalSession(sessionId) {
  const matchingJobs = Array.from(workerBackgroundJobs.entries())
    .filter(([, job]) => job?.sessionId === sessionId);
  for (const [jobId, job] of matchingJobs) {
    if (!terminalWorkerManager?.request) return true;
    try {
      const result = await terminalWorkerManager.request("netcatty:ai:jobPoll", {
        jobId,
        sessionId,
        chatSessionId: job.chatSessionId || null,
        offset: 0,
      }, {});
      if (result?.completed || (result?.ok === false && /not found/i.test(result?.error || ""))) {
        workerBackgroundJobs.delete(jobId);
        continue;
      }
      return true;
    } catch {
      // A transient worker failure should not close a possibly active session.
      return true;
    }
  }
  return false;
}

function cancelWorkerBackgroundJobsForSession(chatSessionId) {
  if (!chatSessionId) return;
  for (const pendingStarts of pendingWorkerJobStarts.values()) {
    for (const pendingStart of pendingStarts) {
      if (pendingStart.chatSessionId === chatSessionId) pendingStart.cancelled = true;
    }
  }
  for (const [jobId, job] of workerBackgroundJobs) {
    if (job.chatSessionId === chatSessionId) {
      workerBackgroundJobs.delete(jobId);
    }
  }
  try {
    terminalWorkerManager?.send?.("netcatty:ai:catty:cancel", { chatSessionId }, {});
  } catch {
    // Worker may already be gone while cancelling a torn-down chat/session.
  }
}

function waitForWorkerCleanup(requestPromise) {
  const timeoutMs = Math.max(1, Math.min(commandTimeoutMs, 5000));
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([requestPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function cancelWorkerBackgroundJobsForTerminalSession(sessionId) {
  if (!sessionId) return;
  for (const pendingStart of pendingWorkerJobStarts.get(sessionId) || []) {
    pendingStart.cancelled = true;
  }
  const matchingJobs = [];
  const pending = [];
  for (const [jobId, job] of workerBackgroundJobs) {
    if (job.sessionId !== sessionId) continue;
    matchingJobs.push(jobId);
    if (terminalWorkerManager?.request) {
      pending.push(waitForWorkerCleanup(terminalWorkerManager.request("netcatty:ai:jobStop", {
        jobId,
        sessionId,
        chatSessionId: job.chatSessionId || null,
      }, {})));
    }
  }
  if (pending.length) await Promise.allSettled(pending);
  for (const jobId of matchingJobs) workerBackgroundJobs.delete(jobId);
}

let builtinRpcHandlerRegistry = null;

function getBuiltinRpcHandlerRegistry() {
  if (!builtinRpcHandlerRegistry) {
    builtinRpcHandlerRegistry = buildBuiltinRpcHandlerRegistry({
      "session.environment": handleGetContext,
      "meta.status": handleGetStatus,
      "attachment.list": handleListAttachments,
      "attachment.read": handleReadAttachment,
      "terminal.execute": handleExec,
      "sftp.list": handleSftpList,
      "sftp.read": handleSftpRead,
      "sftp.write": handleSftpWrite,
      "sftp.download": handleSftpDownload,
      "sftp.upload": handleSftpUpload,
      "sftp.mkdir": handleSftpMkdir,
      "sftp.delete": handleSftpDelete,
      "sftp.rename": handleSftpRename,
      "sftp.stat": handleSftpStat,
      "sftp.chmod": handleSftpChmod,
      "sftp.home": handleSftpHome,
      "session.cancel": handleSetCancelled,
      "terminal.start": handleJobStart,
      "terminal.poll": handleJobPoll,
      "terminal.stop": handleJobStop,
    });
  }
  return builtinRpcHandlerRegistry;
}

async function dispatch(method, params) {
  debugLog("dispatch", { method, params, permissionMode });

  if (!method.startsWith("netcatty/")) {
    const capabilityResult = await dispatchCapabilityRpc(method, params || {});
    if (capabilityResult !== UNROUTED) {
      return capabilityResult;
    }
  }

  const capability = getCapabilityByRpcMethod(method, CAPABILITY_SURFACES.BUILTIN);
  const sessionWriteLockId = (capability?.id === "terminal.execute" || capability?.id === "terminal.start")
    ? params?.sessionId
    : null;
  pruneCompletedBackgroundJobs();

  const permission = evaluatePermissionWithGrants({
    rpcMethod: method,
    surface: CAPABILITY_SURFACES.BUILTIN,
    permissionMode,
    params,
    context: {
      chatSessionCancelled: isChatSessionCancelled(params?.chatSessionId),
    },
  }, permissionGrantsSnapshot);
  if (!permission.allowed) {
    return { ok: false, error: permission.error };
  }

  // Validate session scope *first* so out-of-scope callers cannot infer the
  // existence or activity of foreign sessions through busy-state error
  // messages, and so requests fail fast without blocking the write lock.
  if (method !== "netcatty/getContext" && params?.sessionId) {
    const scopeErr = validateSessionScope(params.sessionId, params?.chatSessionId, params?.scopedSessionIds);
    if (scopeErr) return { ok: false, error: scopeErr };
  }

  if (
    (capability?.id === "terminal.execute" || capability?.id === "terminal.start")
    && params?.sessionId
    && closingTerminalSessions.has(params.sessionId)
  ) {
    return { ok: false, error: `Session "${params.sessionId}" is closing.` };
  }

  if ((capability?.id === "terminal.execute" || capability?.id === "terminal.start") && params?.sessionId) {
    const busy = getSessionBusyError(params.sessionId);
    if (busy) return busy;
  }

  if (sessionWriteLockId) {
    const pendingMethod = pendingSessionWriteApprovals.get(sessionWriteLockId);
    if (pendingMethod) {
      return {
        ok: false,
        error: "Session already has another command request awaiting approval or startup. Wait for it to finish before starting a new command.",
      };
    }
    pendingSessionWriteApprovals.set(sessionWriteLockId, method);
  }

  const tracksSessionActivity = Boolean(
    params?.sessionId
    && (
      capability?.id === "terminal.execute"
      || capability?.id === "terminal.start"
      || capability?.id?.startsWith("sftp.")
    )
  );
  const activityStarted = tracksSessionActivity
    ? sessionIdleManager.beginActivity(params?.chatSessionId, params.sessionId)
    : false;

  try {
    // Confirm mode: request user approval for write operations.
    // netcatty/jobStop bypasses approval — it's a stop/cancel action that
    // must remain available even if the renderer is unavailable; otherwise
    // a runaway terminal_start job could not be interrupted at all.
    if (permission.requiresApproval) {
      const { chatSessionId, ...toolArgs } = params || {};
      const approved = await requestApprovalFromRenderer(method, toolArgs, chatSessionId);
      if (!approved) {
        return { ok: false, error: USER_DENIED_MESSAGE };
      }
    }
    if (
      (capability?.id === "terminal.execute" || capability?.id === "terminal.start")
      && params?.sessionId
    ) {
      const scopeErr = validateSessionScope(
        params.sessionId,
        params?.chatSessionId,
        params?.scopedSessionIds,
      );
      if (scopeErr) return { ok: false, error: scopeErr };
      if (closingTerminalSessions.has(params.sessionId)) {
        return { ok: false, error: `Session "${params.sessionId}" is closing.` };
      }
    }
    const handler = getBuiltinRpcHandlerRegistry().get(method);
    if (!handler) {
      throw new Error(`Unknown method: ${method}`);
    }
    if (capability?.id === "terminal.execute" && params?.sessionId && !sessions?.get?.(params.sessionId)) {
      return await handleWorkerTerminalExec(params);
    }
    if (capability?.id === "terminal.start" && params?.sessionId && !sessions?.get?.(params.sessionId)) {
      return await handleWorkerJobStart(params);
    }
    if (capability?.id === "terminal.poll" && workerBackgroundJobs.has(params?.jobId)) {
      return await handleWorkerJobPoll(params);
    }
    if (capability?.id === "terminal.stop" && workerBackgroundJobs.has(params?.jobId)) {
      return await handleWorkerJobStop(params);
    }
    return await handler(params);
  } finally {
    if (activityStarted) {
      sessionIdleManager.endActivity(params?.chatSessionId, params.sessionId);
    }
    if (sessionWriteLockId) {
      pendingSessionWriteApprovals.delete(sessionWriteLockId);
    }
  }
}

// ── Handler: getContext ──

async function handleGetContext(params) {
  debugLog("handleGetContext:start", { params, sessionCount: sessions?.size || 0 });
  const toolHints = buildMcpToolHints();
  if (!sessions) {
    return {
      hosts: [],
      instructions: "No sessions available.",
      tools: toolHints,
    };
  }

  // chatSessionId may be passed via env for per-scope metadata lookup
  const chatSessionId = params?.chatSessionId || null;
  // External MCP clients use the reserved app-wide scope; refresh from the live
  // session map so newly opened terminals appear without waiting for a renderer push.
  // Only sync while External MCP is enabled — otherwise a stale client could
  // rebuild the cleared scope after disable/idle timeout.
  if (chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID) {
    if (!externalMcpActivityHook?.isEnabled?.()) {
      return {
        environment: "netcatty-terminal",
        description: "External MCP is disabled.",
        hosts: [],
        hostCount: 0,
        tools: toolHints,
      };
    }
    syncLiveSessionsToExternalScope(chatSessionId);
  }
  const explicitScopedIds = Array.isArray(params?.scopedSessionIds)
    ? params.scopedSessionIds
    : null;
  const resolvedScopedIds = resolveScopedSessionIds(chatSessionId, explicitScopedIds);
  if (resolvedScopedIds === null) {
    throw new Error("chatSessionId or scopedSessionIds is required.");
  }
  const hasScopedContext = true;
  const scopedIds = resolvedScopedIds ? new Set(resolvedScopedIds) : null;

  const hosts = [];
  const addedHostIds = new Set();
  // When a scoped context exists but currently resolves to zero sessions, treat
  // it as "no access" rather than falling back to all sessions.
  if (hasScopedContext && (!resolvedScopedIds || resolvedScopedIds.length === 0)) {
    return {
      environment: "netcatty-terminal",
      description: "No hosts are available in the current scope.",
      hosts: [],
      hostCount: 0,
      tools: toolHints,
    };
  }
  for (const [sessionId, session] of sessions.entries()) {
    if (scopedIds && !scopedIds.has(sessionId)) continue;
    const ptyStream = session.stream || session.pty || session.proc;
    const sshClient = session.conn || session.sshClient;
    const hasCommandablePty = ptyStream && typeof ptyStream.write === "function";
    const hasSshExec = sshClient && typeof sshClient.exec === "function";
    const hasSerialPort = session.serialPort && typeof session.serialPort.write === "function";
    if (!hasCommandablePty && !hasSshExec && !hasSerialPort) continue;

    // Look up metadata scoped to this chat session
    const meta = getSessionMeta(sessionId, chatSessionId) || {};
    hosts.push({
      sessionId,
      hostname: meta.hostname || session.hostname || "",
      label: meta.label || session.label || "",
      os: meta.os || "",
      username: meta.username || session.username || "",
      protocol: meta.protocol || session.protocol || session.type || "",
      shellType: meta.shellType || session.shellKind || "",
      deviceType: meta.deviceType || "",
      connected: meta.connected !== undefined ? meta.connected : !!(session.sshClient || session.conn || ptyStream || session.serialPort),
      hostId: meta.hostId || "",
      hostChain: meta.hostChain || [],
      activePortForwards: meta.activePortForwards || [],
    });
    addedHostIds.add(sessionId);
  }

  if (resolvedScopedIds?.length) {
    for (const sessionId of resolvedScopedIds) {
      if (addedHostIds.has(sessionId)) continue;
      const meta = getSessionMeta(sessionId, chatSessionId);
      if (!meta || meta.connected === false) continue;
      hosts.push(buildHostFromMetadata(sessionId, meta));
      addedHostIds.add(sessionId);
    }
  }

  let activePortForwardTunnels = [];
  try {
    activePortForwardTunnels = await portForwardingBridge.listPortForwards() || [];
  } catch {
    activePortForwardTunnels = [];
  }

  return {
    environment: "netcatty-terminal",
    description: appendVaultAgentGuidance(
      "You are operating inside Netcatty, a multi-session terminal manager. " +
      "The available sessions may be remote hosts, local terminals, Mosh-backed shells, or serial port connections (network devices, embedded systems). " +
      "Use the provided tools to execute commands through the sessions exposed by Netcatty. " +
      buildTerminalToolGuidance(toolHints) +
      "Serial sessions (protocol: serial, shellType: raw) do not run a standard shell — commands are sent as-is. " +
      "Network device sessions (deviceType: network) use vendor CLIs (Huawei VRP, Cisco IOS, etc.) — commands are sent as-is without shell wrapping, and exit codes are unavailable. " +
      "Vault snippets, port forwarding rules/tunnels, and SFTP read/write tools are available when exposed in the tool list. " +
      "Always prefer these tools over suggesting the user to do things manually.",
    ),
    hosts,
    hostCount: hosts.length,
    activePortForwardTunnels,
    tools: toolHints,
  };
}

function handleGetStatus() {
  return {
    ok: true,
    environment: "netcatty-terminal",
    permissionMode,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    commandTimeoutMs,
    maxIterations,
    tcpPort,
    sessionCount: sessions?.size || 0,
    scopedContextCount: scopedMetadata.size,
    activeExecutionCount: activePtyExecs.size,
    activeSftpOperationCount: activeSessionSftpOps.size,
    activeChatExecutionCount: activeExecChatSessions.size,
    pendingApprovalCount: pendingApprovals.size,
    discoveryFilePath: cliDiscoveryFilePath || null,
    discoveryFilePresent: Boolean(cliDiscoveryFilePath && existsSync(cliDiscoveryFilePath)),
  };
}

function setPermissionGrants(grants) {
  const { sanitizePermissionGrants } = require("../shared/permissionGrants.cjs");
  permissionGrantsSnapshot = sanitizePermissionGrants(grants);
}

function getPermissionGrants() {
  return permissionGrantsSnapshot;
}

function applyChatSessionCancelled(chatSessionId, cancelled) {
  if (!chatSessionId || typeof chatSessionId !== "string") {
    throw new Error("chatSessionId is required");
  }
  if (cancelled) {
    setChatSessionCancelled(chatSessionId, true);
    cancelPtyExecsForSession(chatSessionId);
    cancelBackgroundJobsForSession(chatSessionId);
    cancelWorkerBackgroundJobsForSession(chatSessionId);
    clearPendingApprovals(chatSessionId);
    void cancelSftpOpsForSession(chatSessionId);
  } else {
    setChatSessionCancelled(chatSessionId, false);
  }
  return {
    ok: true,
    chatSessionId,
    cancelled: !!cancelled,
  };
}

async function handleSetCancelled(params) {
  const chatSessionId = params?.chatSessionId;
  const cancelled = params?.cancelled !== false;
  return applyChatSessionCancelled(chatSessionId, cancelled);
}

const { createSftpHandlerApi } = require("./mcpServerBridge/sftpHandlers.cjs");
const sftpHandlerApi = createSftpHandlerApi({
  get commandTimeoutMs() { return commandTimeoutMs; },
  get sessions() { return sessions; },
  get terminalWorkerManager() { return terminalWorkerManager; },
  sftpBridge, registerSftpOp, setTimeout, clearTimeout, AbortController, Promise, Error,
  createTransferId: () => require("node:crypto").randomUUID(),
  reportTransferEvent: (payload) => broadcastApprovalEvent("netcatty:sftp:global-transfer", payload),
  get transferBridge() { return fileTransferBridge; },
});
const {
  getSessionSftpEncodingStateKey,
  withSessionBackedSftp,
  handleSftpList,
  handleSftpRead,
  handleSftpWrite,
  handleSftpDownload,
  handleSftpUpload,
  handleSftpMkdir,
  handleSftpDelete,
  handleSftpRename,
  handleSftpStat,
  handleSftpChmod,
  handleSftpHome,
} = sftpHandlerApi;

// ── Handler: exec ──

const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const execHandlerApi = createExecHandlerApi({
  get sessions() { return sessions; },
  get commandTimeoutMs() { return commandTimeoutMs; },
  DEFAULT_BACKGROUND_JOB_TIMEOUT_MS, DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS, MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  backgroundJobs, activePtyExecs,
  debugLog, getSessionMeta, checkCommandSafety, reserveSessionExecution, releaseSessionExecution,
  beginChatExecution, execViaRawPty, execViaPty, execViaChannel, startPtyJob,
  getFreshIdlePrompt, echoCommandToSession, createBackgroundJobId, storeCompletedJobOutput,
  serializeBackgroundJob, validateSessionScope, Date, Error,
});
const {
  resolveExecContext,
  handleExec,
  handleJobStart,
  getScopedJob,
  handleJobPoll,
  handleJobStop,
} = execHandlerApi;
const { createConfigAndCleanupApi } = require("./mcpServerBridge/configAndCleanup.cjs");
const configAndCleanupApi = createConfigAndCleanupApi({
  get authToken() { return authToken; },
  get permissionMode() { return permissionMode; },
  process, existsSync, path, __dirname, toUnpackedAsarPath, DEBUG_MCP,
  getScopedSessionIds, scopedMetadata, scopedAttachments, cancelledChatSessions, cancelBackgroundJobsForSession,
  cancelWorkerBackgroundJobsForSession,
  cancelWorkerBackgroundJobsForTerminalSession,
  clearPendingApprovals, cancelSftpOpsForSession, sftpBridge,
  preserveIdleSessionCleanup: sessionIdleManager.scopeCleared,
  clearOpenedSessionScope: openedSessionOwnership.clearScope,
});
const { resolveMcpServerRuntimeCommand, buildMcpServerConfig, cleanupScopedMetadata } = configAndCleanupApi;

function cleanup() {
  shutdownHost();
}

module.exports = {
  init,
  setCommandBlocklist,
  setCommandTimeout,
  getCommandTimeoutMs,
  setSessionIdleTimeoutMinutes,
  getSessionIdleTimeoutMinutes,
  reportOpenedSessionActivity,
  setMaxIterations,
  getMaxIterations,
  setPermissionMode,
  getPermissionMode,
  setPermissionGrants,
  getPermissionGrants,
  setChatSessionCancelled,
  applyChatSessionCancelled,
  checkCommandSafety,
  updateSessionMetadata,
  mergeSessionMetadata,
  updateAttachmentMetadata,
  handleListAttachments,
  handleReadAttachment,
  getScopedSessionIds,
  getOrCreateHost,
  buildMcpServerConfig,
  activePtyExecs,
  cancelBackgroundJobsForSession,
  cancelAllPtyExecs,
  cancelPtyExecsForSession,
  cancelWorkerBackgroundJobsForSession,
  cancelWorkerBackgroundJobsForTerminalSession,
  hasActiveWorkerJobForTerminalSession,
  cancelSftpOpsForSession,
  getSessionMeta,
  cleanupScopedMetadata,
  cleanup,
  shutdownHost,
  setMainWindowGetter,
  setVaultAgentInvoker,
  setExternalMcpHooks,
  disconnectExternalMcpClients,
  issueExternalMcpAuthToken,
  revokeExternalMcpAuthToken,
  getExternalMcpAuthToken,
  syncLiveSessionsToExternalScope,
  resolveApprovalFromRenderer,
  clearPendingApprovals,
  reserveSessionExecution,
  releaseSessionExecution,
  getSessionBusyError,
  dispatchBuiltinRpc: dispatch,
  EXTERNAL_MCP_CHAT_SESSION_ID,
};
