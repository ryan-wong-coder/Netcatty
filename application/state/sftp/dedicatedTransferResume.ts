import type { Host, Identity, KnownHost, SSHKey, TerminalSettings, TransferTask } from "../../../domain/models";
import { validateTransferResumeSource } from "../../../domain/sftpTransferCenter";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { buildSftpHostCredentials } from "./useSftpHostCredentials";
import { getSftpTransferResourceKeys, globalSftpTransferScheduler } from "./globalTransferScheduler";
import { runWithTransferRetry } from "./transferRetry";
import { runSftpTransferWorkers } from "./transferConcurrency";
import { getParentPath, joinPath } from "./utils";

export interface DedicatedResumeDeps {
  hosts: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  terminalSettings?: Pick<TerminalSettings, "verifyHostKeys" | "keepaliveInterval" | "keepaliveCountMax">;
}

export interface DedicatedResumeProgress {
  transferred: number;
  total: number;
  speed: number;
  checkpointBytes?: number;
  resumeStage?: TransferTask["resumeStage"];
  downloadCheckpointBytes?: number;
  uploadCheckpointBytes?: number;
  sourceFingerprint?: string;
}

export type DedicatedResumeResult = {
  success: boolean;
  error?: string;
  /** Leave the task in attention (e.g. source changed) instead of plain failed. */
  needsAttention?: boolean;
  /** Clear checkpoint so the next resume starts this file from zero. */
  resetCheckpoint?: boolean;
};

export type DedicatedResumeOptions = {
  children?: readonly TransferTask[];
  onChildUpdate?: (child: TransferTask) => void;
  shouldAbort?: () => boolean;
};

/** Cap concurrent vault SSH opens across Resume All stampede. */
export const MAX_CONCURRENT_DEDICATED_SESSION_OPENS = 2;

let dedicatedOpenSlots = 0;
const dedicatedOpenWaiters: Array<() => void> = [];

export async function withDedicatedSessionOpenSlot<T>(work: () => Promise<T>): Promise<T> {
  while (dedicatedOpenSlots >= MAX_CONCURRENT_DEDICATED_SESSION_OPENS) {
    await new Promise<void>((resolve) => {
      dedicatedOpenWaiters.push(resolve);
    });
  }
  dedicatedOpenSlots += 1;
  try {
    return await work();
  } finally {
    dedicatedOpenSlots -= 1;
    const next = dedicatedOpenWaiters.shift();
    next?.();
  }
}

/** Test helper — reset open-slot state between unit tests. */
export function resetDedicatedSessionOpenGateForTests(): void {
  dedicatedOpenSlots = 0;
  dedicatedOpenWaiters.length = 0;
}

/**
 * Resolve a vault host for a transfer endpoint. Prefer stable id; fall back to
 * label/hostname when the id is stale after vault edits or older task records.
 */
export function resolveHostForTransferEndpoint(
  hosts: readonly Host[],
  hostId?: string,
  hostLabel?: string,
): Host | null {
  if (hostId) {
    const byId = hosts.find((host) => host.id === hostId);
    if (byId) return byId;
  }
  const needle = (hostLabel || "").trim().toLowerCase();
  if (!needle) return null;
  return hosts.find((host) => {
    const label = (host.label || "").trim().toLowerCase();
    const hostname = (host.hostname || "").trim().toLowerCase();
    return label === needle || hostname === needle;
  }) ?? null;
}

function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("authentication")
    || msg.includes("auth")
    || msg.includes("password")
    || msg.includes("permission denied")
  );
}

/**
 * Open a transfer-owned SFTP session from vault credentials.
 * Shared entry for dedicated resume / bulk transfer (not browse-panel sessions).
 */
export async function openTransferSftpSession(
  host: Host,
  deps: DedicatedResumeDeps,
): Promise<string> {
  return withDedicatedSessionOpenSlot(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openSftp) throw new Error("SFTP bridge unavailable");

    const credentials = buildSftpHostCredentials({
      host,
      hosts: [...deps.hosts],
      keys: [...deps.keys],
      identities: [...deps.identities],
      knownHosts: deps.knownHosts ? [...deps.knownHosts] : undefined,
      terminalSettings: deps.terminalSettings,
    });

    const hasKey = !!credentials.privateKey || !!credentials.identityFilePaths?.length;
    const hasPassword = !!credentials.password;

    if (hasKey) {
      try {
        const keyFirst = { ...credentials };
        if (!credentials.sudo) keyFirst.password = undefined;
        return await bridge.openSftp(keyFirst);
      } catch (err) {
        if (hasPassword && isAuthError(err)) {
          return await bridge.openSftp({
            ...credentials,
            privateKey: undefined,
            certificate: undefined,
            publicKey: undefined,
            keyId: undefined,
            keySource: undefined,
            identityFilePaths: undefined,
          });
        }
        throw err;
      }
    }

    return bridge.openSftp(credentials);
  });
}

async function closeDedicatedSftpSession(sftpId: string | undefined): Promise<void> {
  if (!sftpId) return;
  try {
    await netcattyBridge.get()?.closeSftp?.(sftpId);
  } catch {
    // Best-effort cleanup of transfer-owned sessions.
  }
}

export type TransferEndpointKind = {
  isDownload: boolean;
  isUpload: boolean;
  isRemoteToRemote: boolean;
};

/** Classify transfer endpoints for dedicated resume (local↔remote and SFTP↔SFTP). */
export function classifyDedicatedResumeEndpoints(
  task: Pick<TransferTask, "direction" | "sourceHostId" | "targetHostId" | "sourceConnectionId" | "targetConnectionId">,
): TransferEndpointKind {
  const isRemoteToRemote = task.direction === "remote-to-remote"
    || (!!task.sourceHostId && !!task.targetHostId
      && task.sourceConnectionId !== "local"
      && task.targetConnectionId !== "local");
  if (isRemoteToRemote) {
    return { isDownload: false, isUpload: false, isRemoteToRemote: true };
  }
  const isDownload = task.direction === "download"
    || (!!task.sourceHostId && !task.targetHostId)
    || (task.targetConnectionId === "local" && !!task.sourceHostId);
  const isUpload = task.direction === "upload"
    || (!!task.targetHostId && !task.sourceHostId)
    || (task.sourceConnectionId === "local" && !!task.targetHostId);
  return { isDownload, isUpload, isRemoteToRemote: false };
}

export type DirectoryResumeFilePlan = {
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  size: number;
  lastModified?: number;
};

/**
 * Destination root for directory resume. Replace-mode parents write under
 * `stagedTargetPath` until the full tree is ready to promote.
 */
export function resolveDirectoryResumeTargetRoot(
  parent: Pick<TransferTask, "targetPath" | "stagedTargetPath" | "replaceExistingTarget">,
): string {
  if (parent.stagedTargetPath) return parent.stagedTargetPath;
  return parent.targetPath;
}

/** Match a planned file to a persisted child by exact source+target paths. */
export function findPersistedChildForResumeFile(
  children: readonly Pick<TransferTask, "id" | "status" | "sourcePath" | "targetPath" | "checkpointBytes" | "transferredBytes" | "resumeStage" | "downloadCheckpointBytes" | "uploadCheckpointBytes" | "sourceFingerprint" | "totalBytes" | "sourceLastModified">[],
  file: Pick<DirectoryResumeFilePlan, "sourcePath" | "targetPath">,
) {
  const exact = children.find((child) =>
    child.sourcePath === file.sourcePath && child.targetPath === file.targetPath
  );
  if (exact) return exact;
  // Fallback: unique sourcePath match only (avoid OR that can alias wrong child).
  const bySource = children.filter((child) => child.sourcePath === file.sourcePath);
  return bySource.length === 1 ? bySource[0]! : null;
}

export function shouldSkipCompletedResumeChild(
  child: Pick<TransferTask, "status"> | null | undefined,
): boolean {
  return child?.status === "completed";
}

/** Classify validateTransferResumeSource failures for UX (retry from 0 vs hard fail). */
export function classifyResumeSourceValidationError(message: string | null | undefined): {
  kind: "ok" | "restart" | "modified" | "fatal";
  message: string | null;
} {
  if (!message) return { kind: "ok", message: null };
  if (/beyond the current source size|size changed/i.test(message)) {
    return { kind: "restart", message };
  }
  if (/modified while the transfer was paused/i.test(message)) {
    return { kind: "modified", message };
  }
  return { kind: "fatal", message };
}

/**
 * Resume a transfer by opening dedicated SFTP session(s) (not tied to any UI
 * panel). Used after app restart or when the original browse connection is gone.
 *
 * - Single files: stream resume from checkpoint
 * - Directories: re-walk tree, skip completed children, concurrent file resume
 * - SFTP↔SFTP: open source + target dedicated sessions
 */
export async function resumeTransferWithDedicatedSession(
  task: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  options?: DedicatedResumeOptions,
): Promise<DedicatedResumeResult> {
  if (task.isDirectory) {
    return resumeDirectoryWithDedicatedSession(task, deps, onProgress, options);
  }
  return resumeSingleFileWithDedicatedSession(task, deps, onProgress, options?.shouldAbort);
}

type ResolvedEndpoints = {
  isDownload: boolean;
  isUpload: boolean;
  isRemoteToRemote: boolean;
  sourceHost: Host | null;
  targetHost: Host | null;
  resourceKeys: string[];
};

function resolveResumeHosts(
  task: TransferTask,
  deps: DedicatedResumeDeps,
): { ok: true; endpoints: ResolvedEndpoints } | { ok: false; error: string } {
  const kind = classifyDedicatedResumeEndpoints(task);

  if (kind.isRemoteToRemote) {
    const sourceHost = resolveHostForTransferEndpoint(deps.hosts, task.sourceHostId, task.sourceHostLabel);
    const targetHost = resolveHostForTransferEndpoint(deps.hosts, task.targetHostId, task.targetHostLabel);
    if (!sourceHost || !targetHost) {
      const missing = !sourceHost
        ? (task.sourceHostLabel || task.sourceHostId || "source")
        : (task.targetHostLabel || task.targetHostId || "target");
      return {
        ok: false,
        error: `Cannot find host "${missing}" in your vault. Re-add the host or start a new transfer.`,
      };
    }
    return {
      ok: true,
      endpoints: {
        ...kind,
        sourceHost,
        targetHost,
        resourceKeys: getSftpTransferResourceKeys({
          sourceHostId: sourceHost.id,
          targetHostId: targetHost.id,
        }),
      },
    };
  }

  if (!kind.isDownload && !kind.isUpload) {
    return {
      ok: false,
      error: "Unsupported transfer endpoints for dedicated resume.",
    };
  }

  const remoteHost = kind.isDownload
    ? resolveHostForTransferEndpoint(deps.hosts, task.sourceHostId, task.sourceHostLabel)
    : resolveHostForTransferEndpoint(deps.hosts, task.targetHostId, task.targetHostLabel);

  if (!remoteHost) {
    const label = kind.isDownload
      ? (task.sourceHostLabel || task.sourceHostId || "source")
      : (task.targetHostLabel || task.targetHostId || "target");
    return {
      ok: false,
      error: `Cannot find host "${label}" in your vault. Re-add the host or start a new transfer.`,
    };
  }

  return {
    ok: true,
    endpoints: {
      ...kind,
      sourceHost: kind.isDownload ? remoteHost : null,
      targetHost: kind.isUpload ? remoteHost : null,
      resourceKeys: getSftpTransferResourceKeys({
        sourceHostId: kind.isDownload ? remoteHost.id : undefined,
        targetHostId: kind.isUpload ? remoteHost.id : undefined,
      }),
    },
  };
}

async function openEndpointSessions(
  endpoints: ResolvedEndpoints,
  deps: DedicatedResumeDeps,
): Promise<{ sourceSftpId?: string; targetSftpId?: string }> {
  if (endpoints.isRemoteToRemote && endpoints.sourceHost && endpoints.targetHost) {
    // Open sequentially under the open-slot gate so we never hold 2×N dials.
    const sourceSftpId = await openTransferSftpSession(endpoints.sourceHost, deps);
    try {
      const targetSftpId = await openTransferSftpSession(endpoints.targetHost, deps);
      return { sourceSftpId, targetSftpId };
    } catch (error) {
      await closeDedicatedSftpSession(sourceSftpId);
      throw error;
    }
  }
  if (endpoints.isDownload && endpoints.sourceHost) {
    return { sourceSftpId: await openTransferSftpSession(endpoints.sourceHost, deps) };
  }
  if (endpoints.isUpload && endpoints.targetHost) {
    return { targetSftpId: await openTransferSftpSession(endpoints.targetHost, deps) };
  }
  throw new Error("No remote host for dedicated resume");
}

async function resumeSingleFileWithDedicatedSession(
  task: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  shouldAbort?: () => boolean,
): Promise<DedicatedResumeResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.startStreamTransfer) {
    return { success: false, error: "Transfer bridge unavailable" };
  }

  const resolved = resolveResumeHosts(task, deps);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { endpoints } = resolved;

  let sourceSftpId: string | undefined;
  let targetSftpId: string | undefined;
  try {
    const result = await globalSftpTransferScheduler.run(
      "dedicated-resume",
      task.id,
      endpoints.resourceKeys,
      () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
      async () => {
        if (shouldAbort?.()) throw new Error("Transfer cancelled");
        await runWithTransferRetry(async (attempt) => {
          if (shouldAbort?.()) throw new Error("Transfer cancelled");
          if (attempt > 0) {
            await closeDedicatedSftpSession(sourceSftpId);
            await closeDedicatedSftpSession(targetSftpId);
            sourceSftpId = undefined;
            targetSftpId = undefined;
          }
          if (!sourceSftpId && !targetSftpId) {
            const opened = await openEndpointSessions(endpoints, deps);
            sourceSftpId = opened.sourceSftpId;
            targetSftpId = opened.targetSftpId;
          }

          const sourceType = endpoints.isUpload ? "local" as const : "sftp" as const;
          const targetType = endpoints.isDownload ? "local" as const : "sftp" as const;

          const sourceStat = sourceType === "sftp" && sourceSftpId
            ? await bridge.statSftp?.(sourceSftpId, task.sourcePath, "auto")
            : sourceType === "local"
              ? await bridge.statLocal?.(task.sourcePath)
              : null;
          if (!sourceStat) throw new Error("Source is unavailable");
          {
            const validationError = validateTransferResumeSource(task, {
              size: sourceStat.size,
              lastModified: sourceStat.lastModified,
            });
            const classified = classifyResumeSourceValidationError(validationError);
            if (classified.kind === "modified") {
              const err = new Error(classified.message || validationError || "Source modified");
              (err as Error & { dedicatedAttention?: boolean; resetCheckpoint?: boolean }).dedicatedAttention = true;
              (err as Error & { resetCheckpoint?: boolean }).resetCheckpoint = true;
              throw err;
            }
            if (classified.kind === "restart") {
              // Source shrunk/grew — restart this file from byte 0.
              task = { ...task, checkpointBytes: 0, transferredBytes: 0, totalBytes: sourceStat.size };
            } else if (classified.kind === "fatal") {
              throw new Error(classified.message || validationError || "Resume validation failed");
            }
          }

          const streamResult = await bridge.startStreamTransfer!({
            transferId: task.id,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            sourceType,
            targetType,
            sourceSftpId,
            targetSftpId,
            sourceHostId: endpoints.sourceHost?.id,
            targetHostId: endpoints.targetHost?.id,
            totalBytes: task.totalBytes || undefined,
            resumable: task.resumable !== false,
            checkpointBytes: task.checkpointBytes ?? task.transferredBytes ?? 0,
            resumeStage: task.resumeStage,
            downloadCheckpointBytes: task.downloadCheckpointBytes,
            uploadCheckpointBytes: task.uploadCheckpointBytes,
            sourceFingerprint: task.sourceFingerprint,
            skipAdmission: true,
          }, (transferred, total, speed, checkpoint) => {
            if (shouldAbort?.()) return;
            onProgress?.({
              transferred,
              total,
              speed,
              checkpointBytes: checkpoint?.checkpointBytes ?? transferred,
              resumeStage: checkpoint?.resumeStage,
              downloadCheckpointBytes: checkpoint?.downloadCheckpointBytes,
              uploadCheckpointBytes: checkpoint?.uploadCheckpointBytes,
              sourceFingerprint: checkpoint?.sourceFingerprint,
            });
          });

          if (streamResult?.error) {
            throw new Error(streamResult.error);
          }
        }, { retries: 1, delayMs: 600 });
        return { transferId: task.id };
      },
    );

    if (result?.error) {
      throw new Error(result.error);
    }
    return { success: true };
  } catch (error) {
    const err = error as Error & { dedicatedAttention?: boolean; resetCheckpoint?: boolean };
    return {
      success: false,
      error: err instanceof Error ? err.message : String(error),
      needsAttention: !!err.dedicatedAttention,
      resetCheckpoint: !!err.resetCheckpoint,
    };
  } finally {
    await closeDedicatedSftpSession(sourceSftpId);
    await closeDedicatedSftpSession(targetSftpId);
  }
}

async function listRemoteFilesRecursive(
  sftpId: string,
  rootPath: string,
  relativePrefix = "",
): Promise<DirectoryResumeFilePlan[]> {
  const bridge = netcattyBridge.get();
  if (!bridge?.listSftp) throw new Error("SFTP list unavailable");
  const entries = await bridge.listSftp(sftpId, rootPath, "auto");
  const files: DirectoryResumeFilePlan[] = [];
  for (const entry of entries) {
    if (!entry?.name || entry.name === "." || entry.name === "..") continue;
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const fullPath = joinPath(rootPath, entry.name);
    if (entry.type === "directory" || (entry.type === "symlink" && entry.linkTarget === "directory")) {
      files.push(...await listRemoteFilesRecursive(sftpId, fullPath, relativePath));
      continue;
    }
    if (entry.type === "directory") continue;
    const sizeRaw = entry.size as unknown;
    const size = typeof sizeRaw === "number"
      ? sizeRaw
      : Number.parseInt(String(sizeRaw ?? "0"), 10) || 0;
    const mtimeRaw = entry.lastModified as unknown;
    const lastModified = typeof mtimeRaw === "number"
      ? mtimeRaw
      : (Number.parseInt(String(mtimeRaw ?? ""), 10) || undefined);
    files.push({
      relativePath,
      sourcePath: fullPath,
      targetPath: "",
      size,
      lastModified,
    });
  }
  return files;
}

async function collectDirectoryResumeFiles(
  parent: TransferTask,
  endpoints: ResolvedEndpoints,
  sourceSftpId: string | undefined,
): Promise<DirectoryResumeFilePlan[]> {
  const bridge = netcattyBridge.get();
  const destRoot = resolveDirectoryResumeTargetRoot(parent);

  // Upload: local source tree.
  if (endpoints.isUpload) {
    if (!bridge?.listLocalTree) {
      throw new Error("Local folder listing is unavailable for upload resume");
    }
    const localEntries = await bridge.listLocalTree(parent.sourcePath);
    return localEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        relativePath: entry.relativePath.replace(/\\/g, "/"),
        sourcePath: entry.localPath,
        targetPath: joinPath(destRoot, entry.relativePath.replace(/\\/g, "/")),
        size: entry.size,
        lastModified: entry.lastModified,
      }));
  }

  // Download or remote-to-remote: list remote source.
  if (!sourceSftpId) throw new Error("Source SFTP session missing for directory resume");
  const remoteFiles = await listRemoteFilesRecursive(sourceSftpId, parent.sourcePath);
  return remoteFiles.map((file) => ({
    ...file,
    targetPath: joinPath(destRoot, file.relativePath),
  }));
}

/** Atomically promote a replace-mode staged directory to the final target path. */
async function promoteDirectoryReplaceStage(
  parent: TransferTask,
  endpoints: ResolvedEndpoints,
  targetSftpId: string | undefined,
): Promise<void> {
  const staged = parent.stagedTargetPath;
  if (!staged || staged === parent.targetPath) return;
  const bridge = netcattyBridge.get();
  if (!bridge) throw new Error("Transfer bridge unavailable");
  const safeId = String(parent.id).replace(/[^A-Za-z0-9_-]/g, "_");
  const backupPath = `${parent.targetPath}.netcatty-${safeId}.backup`;
  let backedUp = false;
  try {
    if (endpoints.isDownload) {
      if (!bridge.renameLocalFile || !bridge.deleteLocalFile) {
        throw new Error("Local directory replacement is unavailable");
      }
      try {
        await bridge.renameLocalFile(parent.targetPath, backupPath);
        backedUp = true;
      } catch { /* target may not exist */ }
      await bridge.renameLocalFile(staged, parent.targetPath);
      if (backedUp) await bridge.deleteLocalFile(backupPath);
      return;
    }
    if (!targetSftpId) throw new Error("Target SFTP session missing for directory promote");
    if (!bridge.renameSftp || !bridge.deleteSftp) {
      throw new Error("Remote directory replacement is unavailable");
    }
    try {
      await bridge.renameSftp(targetSftpId, parent.targetPath, backupPath, "auto");
      backedUp = true;
    } catch { /* target may not exist */ }
    try {
      await bridge.renameSftp(targetSftpId, staged, parent.targetPath, "auto");
    } catch (error) {
      if (backedUp) {
        await bridge.renameSftp(targetSftpId, backupPath, parent.targetPath, "auto").catch(() => {});
      }
      throw error;
    }
    if (backedUp) await bridge.deleteSftp(targetSftpId, backupPath, "auto");
  } catch (error) {
    if (backedUp && endpoints.isDownload) {
      await bridge.renameLocalFile?.(backupPath, parent.targetPath).catch(() => {});
    }
    throw error;
  }
}

async function ensureLocalDir(dirPath: string): Promise<void> {
  if (!dirPath) return;
  try {
    await netcattyBridge.get()?.mkdirLocal?.(dirPath);
  } catch {
    // Parent may already exist.
  }
}

async function ensureRemoteDir(sftpId: string, dirPath: string): Promise<void> {
  if (!dirPath || dirPath === "/") return;
  try {
    await netcattyBridge.get()?.mkdirSftp?.(sftpId, dirPath, "auto");
  } catch {
    // Intermediate exists is fine.
  }
}

async function resumeDirectoryWithDedicatedSession(
  parent: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  options?: DedicatedResumeOptions,
): Promise<DedicatedResumeResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.startStreamTransfer) {
    return { success: false, error: "Transfer bridge unavailable" };
  }

  const resolved = resolveResumeHosts(parent, deps);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { endpoints } = resolved;

  const existingChildren = options?.children ?? [];
  let sourceSftpId: string | undefined;
  let targetSftpId: string | undefined;
  let completedCount = existingChildren.filter((child) => child.status === "completed").length;
  let failedCount = 0;
  let attentionCount = 0;
  let totalFiles = Math.max(parent.totalBytes, existingChildren.length, 0);

  const bumpParentProgress = (speed = 0) => {
    onProgress?.({
      transferred: completedCount,
      total: totalFiles,
      speed,
      checkpointBytes: completedCount,
    });
  };

  try {
    const result = await globalSftpTransferScheduler.run(
      "dedicated-resume",
      parent.id,
      endpoints.resourceKeys,
      () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
      async () => {
        if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");
        const opened = await openEndpointSessions(endpoints, deps);
        sourceSftpId = opened.sourceSftpId;
        targetSftpId = opened.targetSftpId;

        const destRoot = resolveDirectoryResumeTargetRoot(parent);
        if (endpoints.isDownload) await ensureLocalDir(destRoot);
        if (targetSftpId) await ensureRemoteDir(targetSftpId, destRoot);

        const planned = await collectDirectoryResumeFiles(parent, endpoints, sourceSftpId);
        totalFiles = planned.length;
        completedCount = planned.filter((file) =>
          shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(existingChildren, file)),
        ).length;
        bumpParentProgress(0);

        const pending = planned.filter((file) =>
          !shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(existingChildren, file)),
        );

        await runSftpTransferWorkers(
          pending,
          () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
          async (file) => {
            if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

            const persisted = findPersistedChildForResumeFile(existingChildren, file);
            if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

            const childId = persisted?.id ?? crypto.randomUUID();
            let childBase: TransferTask = {
              ...parent,
              ...persisted,
              id: childId,
              fileName: file.relativePath.split("/").pop() || file.relativePath,
              originalFileName: file.relativePath.split("/").pop() || file.relativePath,
              sourcePath: file.sourcePath,
              targetPath: file.targetPath,
              parentTaskId: parent.id,
              isDirectory: false,
              progressMode: "bytes",
              ownerId: "dedicated-resume",
              status: "transferring",
              totalBytes: file.size || persisted?.totalBytes || 0,
              transferredBytes: persisted?.checkpointBytes ?? persisted?.transferredBytes ?? 0,
              speed: 0,
              startTime: persisted?.startTime ?? Date.now(),
              endTime: undefined,
              error: undefined,
              reconnectRequired: false,
              phase: "transferring",
              resumable: parent.resumable !== false,
              checkpointBytes: persisted?.checkpointBytes ?? persisted?.transferredBytes ?? 0,
              resumeStage: persisted?.resumeStage,
              downloadCheckpointBytes: persisted?.downloadCheckpointBytes,
              uploadCheckpointBytes: persisted?.uploadCheckpointBytes,
              sourceFingerprint: persisted?.sourceFingerprint,
              sourceLastModified: file.lastModified ?? persisted?.sourceLastModified,
              conflict: undefined,
            };

            if (endpoints.isDownload) {
              await ensureLocalDir(getParentPath(file.targetPath));
            }
            if (targetSftpId) await ensureRemoteDir(targetSftpId, getParentPath(file.targetPath));

            try {
              if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

              const sourceType = endpoints.isUpload ? "local" as const : "sftp" as const;
              const targetType = endpoints.isDownload ? "local" as const : "sftp" as const;

              const sourceStat = sourceType === "sftp" && sourceSftpId
                ? await bridge.statSftp?.(sourceSftpId, file.sourcePath, "auto")
                : sourceType === "local"
                  ? await bridge.statLocal?.(file.sourcePath)
                  : null;
              if (!sourceStat) {
                throw new Error("Source is unavailable");
              }
              childBase = {
                ...childBase,
                totalBytes: sourceStat.size || childBase.totalBytes,
                sourceLastModified: sourceStat.lastModified ?? childBase.sourceLastModified,
              };
              const validationError = validateTransferResumeSource(childBase, {
                size: sourceStat.size,
                lastModified: sourceStat.lastModified,
              });
              const classified = classifyResumeSourceValidationError(validationError);
              if (classified.kind === "restart") {
                childBase = {
                  ...childBase,
                  checkpointBytes: 0,
                  transferredBytes: 0,
                  totalBytes: sourceStat.size,
                };
              } else if (classified.kind === "modified") {
                attentionCount += 1;
                options?.onChildUpdate?.({
                  ...childBase,
                  status: "attention",
                  error: classified.message || validationError || "Source was modified",
                  speed: 0,
                  reconnectRequired: false,
                  phase: undefined,
                  retryable: true,
                });
                return;
              } else if (classified.kind === "fatal") {
                throw new Error(classified.message || validationError || "Resume validation failed");
              }

              // Re-check abort after async stat before inserting a transferring child.
              if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");
              options?.onChildUpdate?.(childBase);

              const streamResult = await bridge.startStreamTransfer!({
                transferId: childId,
                sourcePath: file.sourcePath,
                targetPath: file.targetPath,
                sourceType,
                targetType,
                sourceSftpId,
                targetSftpId,
                sourceHostId: endpoints.sourceHost?.id,
                targetHostId: endpoints.targetHost?.id,
                totalBytes: childBase.totalBytes || file.size || undefined,
                resumable: parent.resumable !== false,
                checkpointBytes: childBase.checkpointBytes ?? 0,
                resumeStage: childBase.resumeStage,
                downloadCheckpointBytes: childBase.downloadCheckpointBytes,
                uploadCheckpointBytes: childBase.uploadCheckpointBytes,
                sourceFingerprint: childBase.sourceFingerprint,
                skipAdmission: true,
              }, (transferred, total, speed, checkpoint) => {
                if (options?.shouldAbort?.()) return;
                options?.onChildUpdate?.({
                  ...childBase,
                  status: "transferring",
                  transferredBytes: transferred,
                  totalBytes: total > 0 ? total : childBase.totalBytes,
                  speed,
                  checkpointBytes: checkpoint?.checkpointBytes ?? transferred,
                  resumeStage: checkpoint?.resumeStage ?? childBase.resumeStage,
                  downloadCheckpointBytes: checkpoint?.downloadCheckpointBytes ?? childBase.downloadCheckpointBytes,
                  uploadCheckpointBytes: checkpoint?.uploadCheckpointBytes ?? childBase.uploadCheckpointBytes,
                  sourceFingerprint: checkpoint?.sourceFingerprint ?? childBase.sourceFingerprint,
                });
                bumpParentProgress(speed);
              });

              if (streamResult?.error || streamResult?.cancelled) {
                throw new Error(streamResult.error || "Transfer cancelled");
              }

              completedCount += 1;
              options?.onChildUpdate?.({
                ...childBase,
                status: "completed",
                transferredBytes: childBase.totalBytes || file.size || childBase.transferredBytes,
                speed: 0,
                endTime: Date.now(),
                error: undefined,
                reconnectRequired: false,
                phase: undefined,
              });
              bumpParentProgress(0);
            } catch (error) {
              if (options?.shouldAbort?.() || /cancelled|canceled/i.test(error instanceof Error ? error.message : String(error))) {
                throw error instanceof Error ? error : new Error(String(error));
              }
              failedCount += 1;
              options?.onChildUpdate?.({
                ...childBase,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                speed: 0,
                endTime: Date.now(),
                reconnectRequired: false,
                phase: undefined,
              });
            }
          },
        );

        return { transferId: parent.id };
      },
    );

    if (result?.error) throw new Error(result.error);

    if (attentionCount > 0 && failedCount === 0 && completedCount + attentionCount >= totalFiles) {
      return {
        success: false,
        needsAttention: true,
        error: attentionCount === 1
          ? "Source was modified for 1 file — review and retry"
          : `Source was modified for ${attentionCount} files — review and retry`,
      };
    }
    if (failedCount > 0 || attentionCount > 0) {
      return {
        success: false,
        needsAttention: attentionCount > 0 && failedCount === 0,
        error: [
          failedCount > 0
            ? (failedCount === totalFiles
              ? `All ${failedCount} files failed to resume`
              : `${failedCount} of ${totalFiles} files failed to resume`)
            : null,
          attentionCount > 0 ? `${attentionCount} file(s) need attention (source changed)` : null,
        ].filter(Boolean).join("; "),
      };
    }
    // Full success — promote replace-mode stage onto the final target path.
    if (parent.stagedTargetPath) {
      await promoteDirectoryReplaceStage(parent, endpoints, targetSftpId);
      // Partial upsert only — do not re-publish a stale full parent snapshot
      // (would clobber live transferredBytes / totalBytes from patchTask).
      options?.onChildUpdate?.({
        id: parent.id,
        stagedTargetPath: undefined,
        replaceExistingTarget: undefined,
      } as TransferTask);
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeDedicatedSftpSession(sourceSftpId);
    await closeDedicatedSftpSession(targetSftpId);
  }
}
