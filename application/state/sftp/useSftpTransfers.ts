import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileConflict,
  FileConflictAction,
  SftpFilenameEncoding,
  TransferDirection,
  TransferStatus,
  TransferTask,
} from "../../../domain/models";
import {
  canReplaceSftpConflict,
  describeSftpExistingKind,
  describeSftpIncomingKind,
  getSftpConflictTypeKey,
} from "../../../domain/sftpConflict";
import { validateTransferResumeSource } from "../../../domain/sftpTransferCenter";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { SftpPane } from "./types";
import { useSftpDirectoryTransferOps } from "./transferDirectoryOps";
import { useSftpTransferConflictOps } from "./transferConflictOps";
import { useSftpTransferTaskOps } from "./transferTaskOps";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";
import type { TransferResult, UseSftpTransfersParams, UseSftpTransfersResult } from "./useSftpTransfers.types";
import { getParentPath, joinPath } from "./utils";

export const useSftpTransfers = ({
  ownerId,
  canPrepareAdoption,
  getActivePane,
  getPaneByConnectionId,
  getTabByConnectionId,
  updateTab,
  refresh,
  clearCacheForConnection,
  sftpSessionsRef,
  connectionCacheKeyMapRef,
  listLocalFiles,
  listRemoteFiles,
  handleSessionError,
}: UseSftpTransfersParams): UseSftpTransfersResult => {
  const [transfers, setTransfers] = useState<TransferTask[]>(() => sftpTransferCenterStore.getOwnerTasks(ownerId));
  const [conflicts, setConflicts] = useState<FileConflict[]>(() => sftpTransferCenterStore
    .getOwnerTasks(ownerId)
    .map((task) => task.conflict)
    .filter((conflict): conflict is FileConflict => !!conflict));

  // Track cancelled task IDs for checking during async operations
  const cancelledTasksRef = useRef<Set<string>>(new Set());
  const pausedTasksRef = useRef<Set<string>>(new Set());
  const pauseWaitersRef = useRef<Map<string, Set<() => void>>>(new Map());
  // Track active child transfer IDs per parent (outside React state for immediate visibility)
  const activeChildIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  const completionHandlersRef = useRef<Map<string, (result: TransferResult) => void | Promise<void>>>(new Map());
  const conflictDefaultsRef = useRef<Map<string, FileConflictAction>>(new Map());

  const clearCancelledTask = useCallback((taskId: string) => {
    cancelledTasksRef.current.delete(taskId);
  }, []);

  const waitUntilTransferResumed = useCallback(async (taskId: string) => {
    if (!pausedTasksRef.current.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = pauseWaitersRef.current.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve);
      pauseWaitersRef.current.set(taskId, waiters);
    });
  }, []);

  const releasePausedTransfer = useCallback((taskId: string) => {
    pausedTasksRef.current.delete(taskId);
    const waiters = pauseWaitersRef.current.get(taskId);
    pauseWaitersRef.current.delete(taskId);
    for (const resolve of waiters ?? []) resolve();
  }, []);

  const resolveTaskEndpoints = useCallback((task: TransferTask) => {
    const sourceTab = getTabByConnectionId(task.sourceConnectionId);
    const targetTab = getTabByConnectionId(task.targetConnectionId);
    if (!sourceTab?.pane.connection || !targetTab?.pane.connection) {
      return null;
    }

    return {
      sourceSide: sourceTab.side,
      targetSide: targetTab.side,
      sourcePane: sourceTab.pane,
      targetPane: targetTab.pane,
    };
  }, [getTabByConnectionId]);

  const cleanupTaskArtifacts = useCallback(async (task: TransferTask) => {
    const endpoints = resolveTaskEndpoints(task);
    const targetPane = endpoints?.targetPane;
    const targetSftpId = targetPane?.connection && !targetPane.connection.isLocal
      ? sftpSessionsRef.current.get(targetPane.connection.id)
      : undefined;
    await netcattyBridge.get()?.cleanupTransferArtifacts?.({
      transferId: task.id,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      targetSftpId,
      targetEncoding: targetPane?.filenameEncoding,
      stagedTargetPath: task.stagedTargetPath,
    });
  }, [resolveTaskEndpoints, sftpSessionsRef]);

  const isTransferCancelledError = useCallback(
    (error: unknown): boolean =>
      error instanceof Error && error.message === "Transfer cancelled",
    [],
  );

  const conflictDefaultKey = useCallback(
    (batchId: string | undefined, isDirectory: boolean, existingType?: "file" | "directory" | "symlink") =>
      `${batchId ?? "global"}:${getSftpConflictTypeKey(isDirectory, existingType)}`,
    [],
  );

  const buildReplaceTypeMismatchError = useCallback(
    (isDirectory: boolean, existingType: "file" | "directory" | "symlink" | undefined, targetPath: string) =>
      `Cannot replace existing ${describeSftpExistingKind(existingType)} with ${describeSftpIncomingKind(isDirectory)}: ${targetPath}`,
    [],
  );

  const { completeCancelledTask, cancelBackendTransfers, markBatchStopped } = useSftpTransferTaskOps({
    cancelledTasksRef,
    activeChildIdsRef,
    transfersRef,
    completionHandlersRef,
    setConflicts,
    setTransfers,
  });

  const { statTargetPath, getDuplicateTarget } = useSftpTransferConflictOps();

  const { estimateDirectoryBytes, transferFile, countDirectoryFiles, transferDirectory } = useSftpDirectoryTransferOps({
    ownerId,
    cancelledTasksRef,
    pausedTasksRef,
    waitUntilTransferResumed,
    activeChildIdsRef,
    transfersRef,
    setTransfers,
    listLocalFiles,
    listRemoteFiles,
  });

  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
    targetSide: "left" | "right",
  ): Promise<TransferStatus> => {
    if (cancelledTasksRef.current.has(task.id)) {
      return "cancelled";
    }

    const updateTask = (updates: Partial<TransferTask>) => {
      setTransfers((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, ...updates } : t)),
      );
    };

    // Initialize encoding early to avoid temporal dead zone issues
    const sourceEncoding: SftpFilenameEncoding = sourcePane.connection?.isLocal
      ? "auto"
      : sourcePane.filenameEncoding || "auto";
    const targetEncoding: SftpFilenameEncoding = targetPane.connection?.isLocal
      ? "auto"
      : targetPane.filenameEncoding || "auto";

    const sourceSftpId = sourcePane.connection?.isLocal
      ? null
      : sftpSessionsRef.current.get(sourcePane.connection!.id);
    const targetSftpId = targetPane.connection?.isLocal
      ? null
      : sftpSessionsRef.current.get(targetPane.connection!.id);

    // Detect same-host: both sides connected to the same remote endpoint.
    // Use per-connection cache keys (hostname+port+protocol+sudo+username) instead of
    // just hostId, because the same hostId can have different session-time overrides.
    const sourceCacheKey = sourcePane.connection?.id
      ? connectionCacheKeyMapRef.current.get(sourcePane.connection.id)
      : undefined;
    const targetCacheKey = targetPane.connection?.id
      ? connectionCacheKeyMapRef.current.get(targetPane.connection.id)
      : undefined;
    const sameHost = !!(
      sourceSftpId && targetSftpId &&
      !sourcePane.connection?.isLocal && !targetPane.connection?.isLocal &&
      sourceCacheKey && targetCacheKey &&
      sourceCacheKey === targetCacheKey
    );

    if (!sourcePane.connection?.isLocal && !sourceSftpId) {
      const sourceSide = targetSide === "left" ? "right" : "left";
      handleSessionError(sourceSide, new Error("Source SFTP session lost"));
      throw new Error("Source SFTP session not found");
    }

    if (!targetPane.connection?.isLocal && !targetSftpId) {
      handleSessionError(targetSide, new Error("Target SFTP session lost"));
      throw new Error("Target SFTP session not found");
    }

    const discoverTransferSize = async () => {
      try {
        if (task.isDirectory) {
          const discoveredSize = await estimateDirectoryBytes(
            task.sourcePath,
            sourceSftpId,
            sourcePane.connection!.isLocal,
            sourceEncoding,
            task.id,
          );
          if (cancelledTasksRef.current.has(task.id)) return;
          updateTask({
            totalBytes: Math.max(discoveredSize, 0),
          });
          return;
        }

        if (task.totalBytes > 0 || !!task.sourceLastModified) return;

        if (sourcePane.connection?.isLocal) {
          const stat = await netcattyBridge.get()?.statLocal?.(task.sourcePath);
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
          return;
        }

        if (sourceSftpId) {
          const stat = await netcattyBridge.get()?.statSftp?.(
            sourceSftpId,
            task.sourcePath,
            sourceEncoding,
          );
          if (stat) {
            if (!task.sourceLastModified && stat.lastModified) {
              task.sourceLastModified = stat.lastModified;
            }
            if (!cancelledTasksRef.current.has(task.id)) {
              updateTask({
                totalBytes: stat.size,
              });
            }
          }
        }
      } catch (err) {
        if (!isTransferCancelledError(err)) {
          logger.debug?.("[SFTP] Deferred transfer size discovery failed", err);
        }
      }
    };

    try {
      const t0 = performance.now();
      logger.debug(`[SFTP:perf] processTransfer START — file=${task.fileName} isDir=${task.isDirectory}`);

      updateTask({
        status: "transferring",
        totalBytes: Math.max(task.totalBytes, 0),
        transferredBytes: task.checkpointBytes ?? 0,
        startTime: Date.now(),
        phase: "transferring",
        resumable: task.resumable !== false,
      });

      // Run size discovery and conflict check in parallel
      const conflictCheckPromise = (async (): Promise<FileConflict | null> => {
        if (task.skipConflictCheck || !targetPane.connection) return null;

        const sourceStat: { size: number; mtime: number } | null =
          (task.totalBytes > 0 || task.sourceLastModified)
            ? { size: task.totalBytes, mtime: task.sourceLastModified || Date.now() }
            : null;

        try {
          const existingStat = await statTargetPath(targetPane, targetSftpId, task.targetPath, targetEncoding);

          if (existingStat) {
            const applyToAllCount = task.batchId
              ? await (async () => {
                  const candidates = transfersRef.current.filter((candidate) =>
                    candidate.batchId === task.batchId &&
                    candidate.isDirectory === task.isDirectory &&
                    !candidate.parentTaskId &&
                    candidate.status !== "completed" &&
                    candidate.status !== "cancelled",
                  );
                  const matches = await Promise.all(candidates.map(async (candidate) => {
                    if (candidate.id === task.id) return true;
                    try {
                      const candidateStat = await statTargetPath(
                        targetPane,
                        targetSftpId,
                        candidate.targetPath,
                        targetEncoding,
                      );
                      return candidateStat?.type === existingStat.type;
                    } catch {
                      return false;
                    }
                  }));
                  return Math.max(1, matches.filter(Boolean).length);
                })()
              : 1;

            return {
              transferId: task.id,
              batchId: task.batchId,
              fileName: task.fileName,
              sourcePath: task.sourcePath,
              targetPath: task.targetPath,
              isDirectory: task.isDirectory,
              existingType: existingStat.type,
              applyToAllCount,
              existingSize: existingStat.size,
              newSize: sourceStat?.size || task.totalBytes || 0,
              existingModified: existingStat.mtime,
              newModified: sourceStat?.mtime || Date.now(),
            };
          }
        } catch {
          // ignore
        }
        return null;
      })();

      // For single files: fire-and-forget size discovery
      if (!task.isDirectory) {
        void discoverTransferSize();
      }

      // Only await conflict check (fast single stat call)
      const conflict = await conflictCheckPromise;

      if (conflict) {
        const defaultAction = conflictDefaultsRef.current.get(
          conflictDefaultKey(task.batchId, task.isDirectory, conflict.existingType),
        );
        if (defaultAction) {
          if (defaultAction === "stop") {
            await markBatchStopped(task);
            return "cancelled";
          }

          if (defaultAction === "skip") {
            cancelledTasksRef.current.add(task.id);
            updateTask({ status: "cancelled", endTime: Date.now() });
            await completeCancelledTask(task);
            return "cancelled";
          }

          if (defaultAction === "replace" && !canReplaceSftpConflict(task.isDirectory, conflict.existingType)) {
            updateTask({
              status: "failed",
              endTime: Date.now(),
              error: buildReplaceTypeMismatchError(task.isDirectory, conflict.existingType, task.targetPath),
              retryable: false,
            });
            return "failed";
          }

          const duplicateTarget = defaultAction === "duplicate"
            ? await getDuplicateTarget(task, targetPane, targetSftpId, targetEncoding)
            : null;
          const updatedTask: TransferTask = {
            ...task,
            ...(duplicateTarget
              ? {
                  fileName: duplicateTarget.fileName,
                  targetPath: duplicateTarget.targetPath,
                }
              : null),
            skipConflictCheck: true,
            replaceExistingTarget: defaultAction === "replace",
          };
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === task.id
                ? { ...updatedTask, status: "pending" as TransferStatus }
                : t,
            ),
          );
          return processTransfer(updatedTask, sourcePane, targetPane, targetSide);
        }

        setConflicts((prev) => [...prev, conflict]);
        updateTask({
          status: "attention",
          totalBytes: conflict.newSize || task.totalBytes || 0,
          conflict,
        });
        return "attention";
      }

      logger.debug(`[SFTP:perf] starting actual transfer — file=${task.fileName} isDir=${task.isDirectory} — ${(performance.now() - t0).toFixed(0)}ms since start`);
      await waitUntilTransferResumed(task.id);
      if (cancelledTasksRef.current.has(task.id)) return "cancelled";

      let dirPartialFailure = false;

      // Same-host exec-based paths are only safe for UTF-8 compatible encodings.
      // "auto" is allowed here — the backend resolves it to the actual encoding
      // and skips exec if it resolved to non-UTF-8 (e.g. gb18030).
      const encodingSafeForExec =
        (!sourceEncoding || sourceEncoding === "utf-8" || sourceEncoding === "auto") &&
        (!targetEncoding || targetEncoding === "utf-8" || targetEncoding === "auto");

      // Try same-host directory optimization first; falls back to recursive transfer
      // if remote cp is unavailable (e.g. Windows SSH servers).
      let dirHandledBySameHost = false;
      if (task.isDirectory && task.resumable === false && sameHost && encodingSafeForExec && sourceSftpId) {
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        const result = await netcattyBridge.require().sameHostCopyDirectory!(
          sourceSftpId,
          task.sourcePath,
          task.targetPath,
          sourceEncoding,
          task.id,
        );
        if (cancelledTasksRef.current.has(task.id)) {
          throw new Error("Transfer cancelled");
        }
        dirHandledBySameHost = result.success;
      }

      if (task.isDirectory && !dirHandledBySameHost) {
        // For directory transfers, parent task uses:
        //   totalBytes = total file count (discovered async)
        //   transferredBytes = completed file count (incremented by child completions)
        // Child file tasks are registered in transfers array with their own byte progress.

        // Fire-and-forget: count total files for parent progress display
        void countDirectoryFiles(
          task.sourcePath,
          sourceSftpId,
          sourcePane.connection!.isLocal,
          sourceEncoding,
          task.id,
        ).then((fileCount) => {
          if (!cancelledTasksRef.current.has(task.id)) {
            updateTask({ totalBytes: fileCount });
          }
        }).catch(() => {});

        const stagedTargetPath = task.replaceExistingTarget
          ? `${task.targetPath}.netcatty-${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}.part`
          : undefined;
        const directoryTask = stagedTargetPath ? { ...task, targetPath: stagedTargetPath } : task;
        if (stagedTargetPath) updateTask({ stagedTargetPath });

        const dirErrors = await transferDirectory(
          directoryTask,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );

        if (dirErrors > 0) {
          dirPartialFailure = true;
        } else if (stagedTargetPath) {
          const bridge = netcattyBridge.require();
          const backupPath = `${task.targetPath}.netcatty-${task.id.replace(/[^A-Za-z0-9_-]/g, "_")}.backup`;
          let backedUp = false;
          try {
            if (targetPane.connection!.isLocal) {
              if (!bridge.renameLocalFile || !bridge.deleteLocalFile) throw new Error("Local directory replacement is unavailable");
              try {
                await bridge.renameLocalFile(task.targetPath, backupPath);
                backedUp = true;
              } catch { /* target may not exist */ }
              await bridge.renameLocalFile(stagedTargetPath, task.targetPath);
              if (backedUp) await bridge.deleteLocalFile(backupPath);
            } else if (targetSftpId) {
              if (!bridge.renameSftp || !bridge.deleteSftp) throw new Error("Remote directory replacement is unavailable");
              try {
                await bridge.renameSftp(targetSftpId, task.targetPath, backupPath, targetEncoding);
                backedUp = true;
              } catch { /* target may not exist */ }
              try {
                await bridge.renameSftp(targetSftpId, stagedTargetPath, task.targetPath, targetEncoding);
              } catch (error) {
                if (backedUp) await bridge.renameSftp(targetSftpId, backupPath, task.targetPath, targetEncoding).catch(() => {});
                throw error;
              }
              if (backedUp) await bridge.deleteSftp(targetSftpId, backupPath, targetEncoding);
            }
            updateTask({ stagedTargetPath: undefined });
          } catch (error) {
            if (backedUp && targetPane.connection!.isLocal) {
              await bridge.renameLocalFile?.(backupPath, task.targetPath).catch(() => {});
            }
            throw error;
          }
        }
      } else if (!task.isDirectory) {
        await transferFile(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
          sourceEncoding,
          targetEncoding,
          task.id, // rootTaskId - this is the top-level task
          sameHost,
        );
      }

      if (cancelledTasksRef.current.has(task.id)) {
        throw new Error("Transfer cancelled");
      }

      const finalStatus: TransferStatus = dirPartialFailure ? "failed" : "completed";
      setTransfers((prev) => {
        return prev.map((t) => {
          if (t.id !== task.id) return t;
          return {
            ...t,
            status: finalStatus,
            error: dirPartialFailure ? "Some files failed to transfer" : undefined,
            // Disable retry for partial failures — retrying replays the entire
            // directory without conflict checks, overwriting already-copied files
            retryable: dirPartialFailure ? false : t.retryable,
            endTime: Date.now(),
            transferredBytes: dirPartialFailure ? t.transferredBytes : t.totalBytes,
            speed: 0,
          };
        });
      });

      // Target contents may have been cached before this transfer started,
      // especially when dropping into a subdirectory like "/tmp" from its parent.
      // Clear the target connection cache so the next navigation reloads fresh data.
      clearCacheForConnection(task.targetConnectionId);

      const targetTab = getTabByConnectionId(task.targetConnectionId);
      if (targetTab) {
        updateTab(targetTab.side, targetTab.tabId, (prev) => ({
          ...prev,
          transferMutationToken: prev.transferMutationToken + 1,
        }));
      }

      // Refresh the specific target tab, not whichever tab happens to be
      // active now — focus may have switched during the transfer.
      if (getParentPath(task.targetPath) === targetPane.connection!.currentPath) {
        await refresh(targetSide, { tabId: targetPane.id });
      }
      // Clean up tracked child IDs for this transfer
      activeChildIdsRef.current.delete(task.id);

      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: finalStatus,
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return finalStatus;
    } catch (err) {
      activeChildIdsRef.current.delete(task.id);
      // Check if this was a cancellation
      const isCancelled = cancelledTasksRef.current.has(task.id) ||
        (err instanceof Error && err.message === "Transfer cancelled");

      if (isCancelled) {
        // Don't update status - cancelTransfer already set it to cancelled
        const completionHandler = completionHandlersRef.current.get(task.id);
        if (completionHandler) {
          try {
            await completionHandler({
              id: task.id,
              fileName: task.fileName,
              originalFileName: task.originalFileName ?? task.fileName,
              status: "cancelled",
            });
          } finally {
            completionHandlersRef.current.delete(task.id);
          }
        }
        clearCancelledTask(task.id);
        return "cancelled";
      }

      updateTask({
        status: "failed",
        error: err instanceof Error ? err.message : "Transfer failed",
        endTime: Date.now(),
        speed: 0,
      });
      const completionHandler = completionHandlersRef.current.get(task.id);
      if (completionHandler) {
        try {
          await completionHandler({
            id: task.id,
            fileName: task.fileName,
            originalFileName: task.originalFileName ?? task.fileName,
            status: "failed",
          });
        } finally {
          completionHandlersRef.current.delete(task.id);
        }
      }
      return "failed";
    }
  };

  const startTransfer = useCallback(
    async (
      sourceFiles: { name: string; isDirectory: boolean }[],
      sourceSide: "left" | "right",
      targetSide: "left" | "right",
      options?: {
        sourcePane?: SftpPane;
        sourcePath?: string;
        sourceConnectionId?: string;
        targetPath?: string;
        onTransferComplete?: (result: TransferResult) => void | Promise<void>;
      },
    ) => {
      const sourcePane = options?.sourcePane
        ?? (options?.sourceConnectionId ? getPaneByConnectionId(options.sourceConnectionId) : null)
        ?? getActivePane(sourceSide);
      const targetPane = getActivePane(targetSide);

      if (!sourcePane?.connection || !targetPane?.connection) return [];

      const sourcePath = options?.sourcePath ?? sourcePane.connection.currentPath;
      const targetPath = options?.targetPath ?? targetPane.connection.currentPath;
      const sourceConnectionId = options?.sourceConnectionId ?? sourcePane.connection.id;
      const batchId = crypto.randomUUID();
      const usesLegacyScp = sourcePane.connection.fileProtocol === "scp" || targetPane.connection.fileProtocol === "scp";

      const newTasks: TransferTask[] = [];

      const canReusePaneMetadata = sourcePath === sourcePane.connection.currentPath;
      const fileEntryMap = canReusePaneMetadata
        ? new Map(sourcePane.files.map(f => [f.name, f]))
        : null;

      for (const file of sourceFiles) {
        const direction: TransferDirection =
          sourcePane.connection!.isLocal && !targetPane.connection!.isLocal
            ? "upload"
            : !sourcePane.connection!.isLocal && targetPane.connection!.isLocal
              ? "download"
              : "remote-to-remote";

        // Use cached metadata from the source pane's file list to avoid
        // redundant stat calls over the network, but only when the transfer
        // source matches the pane's currently listed directory.
        const fileEntry = fileEntryMap?.get(file.name);
        const fileSize = file.isDirectory ? 0 : (fileEntry?.size ?? 0);
        const sourceLastModified = fileEntry?.lastModified ?? 0;

        newTasks.push({
          id: crypto.randomUUID(),
          batchId,
          fileName: file.name,
          originalFileName: file.name,
          sourcePath: joinPath(sourcePath, file.name),
          targetPath: joinPath(targetPath, file.name),
          sourceConnectionId,
          targetConnectionId: targetPane.connection!.id,
          sourceHostId: sourcePane.connection!.isLocal ? undefined : sourcePane.connection!.hostId,
          sourceHostLabel: sourcePane.connection!.isLocal ? "Local" : sourcePane.connection!.hostLabel,
          targetHostId: targetPane.connection!.isLocal ? undefined : targetPane.connection!.hostId,
          targetHostLabel: targetPane.connection!.isLocal ? "Local" : targetPane.connection!.hostLabel,
          direction,
          status: "pending" as TransferStatus,
          totalBytes: fileSize,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: file.isDirectory,
          progressMode: file.isDirectory ? "files" : "bytes",
          sourceLastModified,
          origin: "manual",
          resumable: !usesLegacyScp,
          pauseUnavailableReason: usesLegacyScp ? "This server uses legacy SCP; cancel and retry from the beginning instead" : undefined,
          phase: file.isDirectory ? "scanning" : "transferring",
        });
      }

      setTransfers((prev) => [...prev, ...newTasks]);

      if (options?.onTransferComplete) {
        for (const task of newTasks) {
          completionHandlersRef.current.set(task.id, options.onTransferComplete);
        }
      }

      const results = await Promise.all(newTasks.map(async (task): Promise<TransferResult> => {
        const status = await processTransfer(task, sourcePane, targetPane, targetSide);
        return {
          id: task.id,
          fileName: task.fileName,
          originalFileName: task.originalFileName ?? task.fileName,
          status,
        };
      }));

      return results;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getActivePane, getPaneByConnectionId, getTabByConnectionId, sftpSessionsRef, updateTab],
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      const taskToCancel = transfersRef.current.find((task) => task.id === transferId);
      // Add to cancelled set so async operations can check
      cancelledTasksRef.current.add(transferId);
      releasePausedTransfer(transferId);
      globalSftpTransferScheduler.cancel(transferId);

      // Cancel parent + remove child tasks
      setTransfers((prev) => {
        // Find child task IDs to cancel at backend too
        const childIds = prev.filter((t) => t.parentTaskId === transferId && (t.status === "transferring" || t.status === "pending")).map((t) => t.id);
        for (const cid of childIds) {
          cancelledTasksRef.current.add(cid);
          globalSftpTransferScheduler.cancel(cid);
        }
        return prev
          .filter((t) => t.parentTaskId !== transferId)
          .map((t) =>
            t.id === transferId
              ? { ...t, status: "cancelled" as TransferStatus, endTime: Date.now(), conflict: undefined }
              : t,
          );
      });

      setConflicts((prev) => prev.filter((c) => c.transferId !== transferId));

      await cancelBackendTransfers([transferId]);
      if (taskToCancel) await cleanupTaskArtifacts(taskToCancel);

    },
    [cancelBackendTransfers, cleanupTaskArtifacts, releasePausedTransfer],
  );

  const pauseTransfer = useCallback(async (transferId: string) => {
    const task = transfersRef.current.find((candidate) => candidate.id === transferId);
    if (!task || task.status === "completed" || task.status === "cancelled") return;
    const commitPauseState = (update: (candidate: TransferTask) => TransferTask) => {
      const next = transfersRef.current.map((candidate) => candidate.id === transferId ? update(candidate) : candidate);
      transfersRef.current = next;
      setTransfers(next);
      sftpTransferCenterStore.publishOwner(ownerId, next);
    };
    pausedTasksRef.current.add(transferId);
    if (task.resumable === false) {
      commitPauseState((candidate) => ({
        ...candidate,
        pauseUnavailableReason: candidate.pauseUnavailableReason ?? "Pause is unavailable for this transfer",
      }));
      return;
    }
    if (task.status === "pending" || task.status === "queued" || task.status === "interrupted") {
      globalSftpTransferScheduler.pause(transferId);
      commitPauseState((candidate) => ({ ...candidate, status: "paused" as TransferStatus, speed: 0 }));
      return;
    }
    commitPauseState((candidate) => ({ ...candidate, status: "pausing" as TransferStatus }));
    const isCompressedUpload = task.isDirectory && (
      task.fileName.endsWith(" (compressed)")
      || task.phase === "compressing"
      || task.phase === "uploading"
      || task.phase === "extracting"
    );
    if (isCompressedUpload) {
      const result = await (netcattyBridge.get()?.pauseCompressedUpload?.(transferId)
        ?? { success: false, reason: "Pause unavailable" });
      commitPauseState((candidate) => (
        result.success
          ? { ...candidate, status: "paused" as TransferStatus, speed: 0, checkpointBytes: candidate.transferredBytes }
          : { ...candidate, status: "transferring" as TransferStatus, pauseUnavailableReason: result.reason }
      ));
      return;
    }
    const childIds = [...(activeChildIdsRef.current.get(transferId) ?? [])];
    const activeIds = task.isDirectory ? childIds : [transferId, ...childIds];
    const backendIds = activeIds.filter((id) => !globalSftpTransferScheduler.pause(id));
    if (activeIds.length === 0) {
      commitPauseState((candidate) => ({ ...candidate, status: "paused" as TransferStatus, speed: 0 }));
      return;
    }
    const results = await Promise.all(backendIds.map(async (id) => (
      netcattyBridge.get()?.pauseTransfer?.(id) ?? { success: false, reason: "Pause unavailable" }
    )));
    const failed = results.find((result) => !result.success);
    const checkpoint = results.find((result) => result.checkpointBytes !== undefined)?.checkpointBytes;
    if (task.isDirectory) {
      const backendResults = new Map(backendIds.map((id, index) => [id, results[index]]));
      const next = transfersRef.current.map((candidate) => {
        if (!activeIds.includes(candidate.id)) return candidate;
        const result = backendResults.get(candidate.id);
        if (result && !result.success) {
          return {
            ...candidate,
            resumable: false,
            pauseUnavailableReason: result.reason,
          };
        }
        return {
          ...candidate,
          status: "paused" as TransferStatus,
          speed: 0,
          checkpointBytes: result?.checkpointBytes ?? candidate.checkpointBytes ?? candidate.transferredBytes,
          resumeStage: result?.resumeStage ?? candidate.resumeStage,
          downloadCheckpointBytes: result?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
          uploadCheckpointBytes: result?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
          sourceFingerprint: result?.sourceFingerprint ?? candidate.sourceFingerprint,
        };
      });
      transfersRef.current = next;
      setTransfers(next);
      sftpTransferCenterStore.publishOwner(ownerId, next);
    }
    commitPauseState((candidate) => (
      failed
        ? {
            ...candidate,
            status: "transferring" as TransferStatus,
            resumable: false,
            pauseUnavailableReason: failed.reason,
          }
        : task.isDirectory
          ? {
            ...candidate,
            status: "paused" as TransferStatus,
            speed: 0,
            checkpointBytes: undefined,
            resumeStage: undefined,
            downloadCheckpointBytes: undefined,
            uploadCheckpointBytes: undefined,
            sourceFingerprint: undefined,
          }
          : {
            ...candidate,
            status: "paused" as TransferStatus,
            speed: 0,
            checkpointBytes: checkpoint ?? candidate.transferredBytes,
            resumeStage: results[0]?.resumeStage ?? candidate.resumeStage,
            downloadCheckpointBytes: results[0]?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
            uploadCheckpointBytes: results[0]?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
            sourceFingerprint: results[0]?.sourceFingerprint ?? candidate.sourceFingerprint,
          }
    ));
  }, [activeChildIdsRef, ownerId]);

  const resumeTransfer = useCallback(async (transferId: string) => {
    const task = transfersRef.current.find((candidate) => candidate.id === transferId);
    if (!task || (
      task.status !== "paused"
      && task.status !== "interrupted"
      && !(task.status === "failed" && (task.checkpointBytes ?? 0) > 0)
    )) return;
    releasePausedTransfer(transferId);
    if (globalSftpTransferScheduler.resume(transferId)) {
      setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
        ? { ...candidate, status: "queued" as TransferStatus, error: undefined }
        : candidate));
      return;
    }
    const isCompressedUpload = task.isDirectory && (
      task.fileName.endsWith(" (compressed)")
      || task.phase === "compressing"
      || task.phase === "uploading"
      || task.phase === "extracting"
    );
    if (isCompressedUpload) {
      const result = await (netcattyBridge.get()?.resumeCompressedUpload?.(transferId)
        ?? { success: false, reason: "Resume unavailable" });
      if (result.success) {
        setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
          ? { ...candidate, status: "transferring" as TransferStatus, pauseUnavailableReason: undefined }
          : candidate));
        return;
      }
      // After an app restart there is no in-memory compression worker. Rebuild
      // the directory transfer from its persisted source, target, and child
      // checkpoints instead of leaving it permanently stuck.
    }
    const childIds = [...(activeChildIdsRef.current.get(transferId) ?? [])];
    const activeIds = task.isDirectory ? childIds : [transferId, ...childIds];
    const backendIds = activeIds.filter((id) => !globalSftpTransferScheduler.resume(id));
    if (activeIds.length === 0) {
      const endpoints = resolveTaskEndpoints(task);
      if (!endpoints) {
        setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
          ? { ...candidate, status: "attention" as TransferStatus, error: "Reconnect the source and target before resuming" }
          : candidate));
        return;
      }
      const restartedTask = { ...task, status: "queued" as TransferStatus, error: undefined };
      setTransfers((prev) => prev.map((candidate) => candidate.id === transferId ? restartedTask : candidate));
      void processTransfer(restartedTask, endpoints.sourcePane, endpoints.targetPane, endpoints.targetSide);
      return;
    }
    const results = await Promise.all(backendIds.map(async (id) => (
      netcattyBridge.get()?.resumeTransfer?.(id) ?? { success: false, reason: "Resume unavailable" }
    )));
    if (backendIds.length < activeIds.length || results.some((result) => result.success)) {
      setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
        ? { ...candidate, status: "transferring" as TransferStatus, pauseUnavailableReason: undefined }
        : candidate));
      return;
    }

    const endpoints = resolveTaskEndpoints(task);
    if (!endpoints) {
      setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
        ? { ...candidate, status: "attention" as TransferStatus, error: "Reconnect the source and target before resuming" }
        : candidate));
      return;
    }
    try {
      const sourcePane = endpoints.sourcePane;
      const sourceStat = sourcePane.connection?.isLocal
        ? await netcattyBridge.get()?.statLocal?.(task.sourcePath)
        : await (() => {
            const sourceSftpId = sourcePane.connection
              ? sftpSessionsRef.current.get(sourcePane.connection.id)
              : undefined;
            return sourceSftpId
              ? netcattyBridge.get()?.statSftp?.(sourceSftpId, task.sourcePath, sourcePane.filenameEncoding)
              : undefined;
          })();
      if (!sourceStat) throw new Error("Source is unavailable");
      const validationError = validateTransferResumeSource(task, {
        size: sourceStat.size,
        lastModified: sourceStat.lastModified,
      });
      if (validationError) {
        setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
          ? { ...candidate, status: "attention" as TransferStatus, error: validationError }
          : candidate));
        return;
      }
    } catch (error) {
      setTransfers((prev) => prev.map((candidate) => candidate.id === transferId
        ? { ...candidate, status: "attention" as TransferStatus, error: error instanceof Error ? error.message : String(error) }
        : candidate));
      return;
    }
    clearCancelledTask(task.id);
    const resumedTask = { ...task, status: "queued" as TransferStatus, error: undefined, speed: 0 };
    setTransfers((prev) => prev.map((candidate) => candidate.id === transferId ? resumedTask : candidate));
    await processTransfer(resumedTask, endpoints.sourcePane, endpoints.targetPane, endpoints.targetSide);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer reads current transfer refs
  }, [activeChildIdsRef, clearCancelledTask, releasePausedTransfer, resolveTaskEndpoints]);

  const prioritizeTransfer = useCallback((transferId: string) => {
    globalSftpTransferScheduler.prioritize(transferId);
    setTransfers((prev) => {
      const nextPriority = prev.reduce((max, task) => Math.max(max, task.priority ?? 0), 0) + 1;
      return prev.map((task) => task.id === transferId ? { ...task, priority: nextPriority } : task);
    });
  }, []);

  const retryTransfer = useCallback(
    async (transferId: string) => {
      const task = transfersRef.current.find((t) => t.id === transferId);
      if (!task || task.retryable === false) return;
      await cleanupTaskArtifacts(task);

      const retriedTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        status: "pending" as TransferStatus,
        error: undefined,
        transferredBytes: 0,
        checkpointBytes: 0,
        resumeStage: undefined,
        downloadCheckpointBytes: undefined,
        uploadCheckpointBytes: undefined,
        speed: 0,
        startTime: Date.now(),
        endTime: undefined,
      };

      const endpoints = resolveTaskEndpoints(task);
      if (!endpoints) return;
      const { targetSide, sourcePane, targetPane } = endpoints;

      const completionHandler = completionHandlersRef.current.get(transferId);
      if (completionHandler) {
        completionHandlersRef.current.set(retriedTask.id, completionHandler);
        completionHandlersRef.current.delete(transferId);
      }

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? retriedTask
            : t,
        ),
      );
      await processTransfer(retriedTask, sourcePane, targetPane, targetSide);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline
    [cleanupTaskArtifacts, resolveTaskEndpoints],
  );

  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) =>
      prev.filter((t) => t.status !== "completed" && t.status !== "cancelled"),
    );
  }, []);

  const dismissTransfer = useCallback((transferId: string) => {
    const task = transfersRef.current.find((candidate) => candidate.id === transferId);
    if (task) void cleanupTaskArtifacts(task);
    setTransfers((prev) => prev.filter((t) => t.id !== transferId && t.parentTaskId !== transferId));
  }, [cleanupTaskArtifacts]);

  const isTransferCancelled = useCallback((transferId: string) => {
    return cancelledTasksRef.current.has(transferId);
  }, []);

  const addExternalUpload = useCallback((task: TransferTask) => {
    // Filter out any pending scanning tasks before adding the new task.
    // This ensures that even if dismissExternalUpload's state update hasn't been applied yet
    // (due to React state batching), the scanning placeholder will still be removed.
    if (task.parentTaskId) {
      const childIds = activeChildIdsRef.current.get(task.parentTaskId) ?? new Set<string>();
      childIds.add(task.id);
      activeChildIdsRef.current.set(task.parentTaskId, childIds);
    }
    setTransfers((prev) => [
      ...prev.filter(t => !(t.status === "pending" && t.fileName === "Scanning files...")),
      task
    ]);
  }, []);

  const updateExternalUpload = useCallback((taskId: string, updates: Partial<TransferTask>) => {
    const currentTask = transfersRef.current.find((task) => task.id === taskId);
    if (currentTask?.parentTaskId && updates.status && ["completed", "failed", "cancelled"].includes(updates.status)) {
      activeChildIdsRef.current.get(currentTask.parentTaskId)?.delete(taskId);
    }
    setTransfers((prev) =>
      prev.map((t) => {
        if (
          currentTask?.parentTaskId
          && t.id === currentTask.parentTaskId
          && updates.resumable === false
        ) {
          return {
            ...t,
            resumable: false,
            pauseUnavailableReason: updates.pauseUnavailableReason,
          };
        }
        if (t.id !== taskId) return t;

        const merged: TransferTask = { ...t, ...updates };

        // Keep progress monotonic and bounded for stable progress UI.
        if (typeof merged.totalBytes === "number" && merged.totalBytes > 0) {
          merged.transferredBytes = Math.max(
            t.transferredBytes,
            Math.min(merged.transferredBytes, merged.totalBytes),
          );
        } else {
          merged.transferredBytes = Math.max(t.transferredBytes, merged.transferredBytes);
        }

        if (!Number.isFinite(merged.speed) || merged.speed < 0) {
          merged.speed = 0;
        }

        return merged;
      }),
    );
  }, []);

  const resolveConflict = useCallback(
    async (conflictId: string, action: FileConflictAction, applyToAll = false) => {
      const conflict = conflictsRef.current.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      const task = transfersRef.current.find((t) => t.id === conflictId);
      if (!task) {
        setConflicts((prev) => prev.filter((c) => c.transferId !== conflictId));
        return;
      }

      const selectedConflictKey = conflictDefaultKey(conflict.batchId, conflict.isDirectory, conflict.existingType);
      const affectedConflicts = applyToAll
        ? conflictsRef.current.filter((candidate) =>
            conflictDefaultKey(candidate.batchId, candidate.isDirectory, candidate.existingType) === selectedConflictKey,
          )
        : [conflict];
      const affectedConflictIds = new Set(affectedConflicts.map((candidate) => candidate.transferId));
      const affectedTasks = affectedConflicts
        .map((candidate) => transfersRef.current.find((transfer) => transfer.id === candidate.transferId))
        .filter((candidate): candidate is TransferTask => Boolean(candidate));
      const affectedConflictById = new Map<string, FileConflict>(
        affectedConflicts.map((candidate): [string, FileConflict] => [candidate.transferId, candidate]),
      );

      if (applyToAll) {
        conflictDefaultsRef.current.set(selectedConflictKey, action);
      }

      setConflicts((prev) => prev.filter((c) => !affectedConflictIds.has(c.transferId)));

      if (affectedTasks.length === 0) {
        return;
      }

      if (action === "stop") {
        await markBatchStopped(task);
        return;
      }

      if (action === "skip") {
        for (const affectedTask of affectedTasks) {
          cancelledTasksRef.current.add(affectedTask.id);
        }
        setTransfers((prev) =>
          prev.map((t) => affectedConflictIds.has(t.id)
              ? { ...t, status: "cancelled" as TransferStatus, endTime: Date.now() }
              : t,
          ),
        );
        for (const affectedTask of affectedTasks) {
          await completeCancelledTask(affectedTask);
        }
        return;
      }

      const updatedTasks: TransferTask[] = [];
      const blockedReplaceTasks: Array<{ task: TransferTask; conflict: FileConflict }> = [];

      for (const affectedTask of affectedTasks) {
        let updatedTask = { ...affectedTask };
        const affectedConflict = affectedConflictById.get(affectedTask.id);

        if (action === "duplicate") {
          const endpoints = resolveTaskEndpoints(affectedTask);
          if (!endpoints) continue;
          const targetSftpId = endpoints.targetPane.connection?.isLocal
            ? null
            : sftpSessionsRef.current.get(endpoints.targetPane.connection!.id) ?? null;
          const targetEncoding = endpoints.targetPane.connection?.isLocal
            ? "auto"
            : endpoints.targetPane.filenameEncoding || "auto";
          const duplicateTarget = await getDuplicateTarget(affectedTask, endpoints.targetPane, targetSftpId, targetEncoding);
          updatedTask = {
            ...affectedTask,
            fileName: duplicateTarget.fileName,
            targetPath: duplicateTarget.targetPath,
            skipConflictCheck: true,
          };
        } else if (action === "replace") {
          if (
            affectedConflict &&
            !canReplaceSftpConflict(affectedTask.isDirectory, affectedConflict.existingType)
          ) {
            blockedReplaceTasks.push({ task: affectedTask, conflict: affectedConflict });
            continue;
          }
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: true,
          };
        } else if (action === "merge") {
          updatedTask = {
            ...affectedTask,
            skipConflictCheck: true,
            replaceExistingTarget: false,
          };
        }

        updatedTasks.push(updatedTask);
      }

      if (blockedReplaceTasks.length > 0) {
        const blockedTaskIds = new Set(blockedReplaceTasks.map(({ task }) => task.id));
        const blockedErrors = new Map(
          blockedReplaceTasks.map(({ task, conflict }) => [
            task.id,
            buildReplaceTypeMismatchError(task.isDirectory, conflict.existingType, task.targetPath),
          ]),
        );
        setTransfers((prev) =>
          prev.map((t) => blockedTaskIds.has(t.id)
            ? {
                ...t,
                status: "failed" as TransferStatus,
                endTime: Date.now(),
                error: blockedErrors.get(t.id),
                retryable: false,
                conflict: undefined,
              }
            : t,
          ),
        );
      }

      const updatedTaskMap = new Map(updatedTasks.map((updatedTask) => [updatedTask.id, updatedTask]));
      setTransfers((prev) =>
        prev.map((t) => {
          const updatedTask = updatedTaskMap.get(t.id);
          return updatedTask
            ? { ...updatedTask, status: "pending" as TransferStatus, conflict: undefined }
            : t;
        }),
      );

      for (const updatedTask of updatedTasks) {
        setTimeout(async () => {
          const endpoints = resolveTaskEndpoints(updatedTask);
          if (!endpoints) return;
          await processTransfer(updatedTask, endpoints.sourcePane, endpoints.targetPane, endpoints.targetSide);
        }, 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processTransfer is defined inline; transfers/conflicts accessed via refs
    [
      completeCancelledTask,
      conflictDefaultKey,
      getDuplicateTarget,
      markBatchStopped,
      resolveTaskEndpoints,
      sftpSessionsRef,
    ],
  );

  const activeTransfersCount = useMemo(() => transfers.filter(
    (t) => !(["completed", "cancelled"] as TransferStatus[]).includes(t.status) && !t.parentTaskId,
  ).length, [transfers]);

  const downloadToLocal = useCallback(
    async (params: {
      fileName: string;
      sourcePath: string;
      targetPath: string;
      sftpId: string;
      connectionId: string;
      sourceEncoding?: SftpFilenameEncoding;
      isDirectory: boolean;
      totalBytes?: number;
    }): Promise<TransferStatus> => {
      const task: TransferTask = {
        id: crypto.randomUUID(),
        fileName: params.fileName,
        originalFileName: params.fileName,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        sourceConnectionId: params.connectionId,
        targetConnectionId: "local",
        direction: "download",
        status: "transferring",
        totalBytes: params.totalBytes ?? 0,
        transferredBytes: 0,
        speed: 0,
        startTime: Date.now(),
        isDirectory: params.isDirectory,
        progressMode: params.isDirectory ? "files" : "bytes",
        retryable: false,
        origin: "manual",
        resumable: true,
        phase: "transferring",
      };

      setTransfers((prev) => [...prev, task]);

      const sourceEncoding = params.sourceEncoding ?? "auto";
      // Mutable counter to track child failures outside React state,
      // so the final status check doesn't depend on render timing.
      let childFailureCount = 0;

      try {
        if (params.isDirectory) {
          // Count files for progress display
          void countDirectoryFiles(
            params.sourcePath,
            params.sftpId,
            false,
            sourceEncoding,
            task.id,
            0,     // symlinkDepth
            true,  // followSymlinks
          ).then((fileCount) => {
            if (!cancelledTasksRef.current.has(task.id)) {
              setTransfers((prev) =>
                prev.map((t) => (t.id === task.id ? { ...t, totalBytes: fileCount } : t)),
              );
            }
          }).catch(() => {});

          childFailureCount = await transferDirectory(
            task,
            params.sftpId,
            null,       // targetSftpId = null (local)
            false,       // sourceIsLocal = false
            true,        // targetIsLocal = true
            sourceEncoding,
            "auto",      // targetEncoding
            task.id,
            false,       // sameHost
            0,           // symlinkDepth
            true,        // followSymlinks — download should expand symlink dirs
          );
        } else {
          await transferFile(
            task,
            params.sftpId,
            null,
            false,
            true,
            sourceEncoding,
            "auto",
            task.id,
          );
        }

        // Use childFailureCount (tracked outside React state) to determine
        // final status reliably, regardless of render timing.
        const hasFailures = childFailureCount > 0;
        const finalStatus: TransferStatus = hasFailures ? "failed" : "completed";
        setTransfers((prev) => {
          const completedCount = prev.filter(
            (t) => t.parentTaskId === task.id && t.status === "completed",
          ).length;
          return prev.map((t) => {
            if (t.id !== task.id) return t;
            const finalTotal = t.totalBytes > 0 ? t.totalBytes : completedCount;
            return {
              ...t,
              status: finalStatus,
              error: hasFailures ? "Some files failed to transfer" : undefined,
              endTime: Date.now(),
              totalBytes: finalTotal,
              transferredBytes: hasFailures ? completedCount : finalTotal,
            };
          });
        });
        activeChildIdsRef.current.delete(task.id);
        return finalStatus;
      } catch (err) {
        activeChildIdsRef.current.delete(task.id);
        const isCancelled = cancelledTasksRef.current.has(task.id);
        // Clean up cancelled task tracking to prevent memory leak
        if (isCancelled) cancelledTasksRef.current.delete(task.id);
        const errMsg = err instanceof Error ? err.message : String(err);
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status: isCancelled ? ("cancelled" as TransferStatus) : ("failed" as TransferStatus),
                  error: isCancelled ? undefined : errMsg,
                  endTime: Date.now(),
                }
              : t,
          ),
        );
        return isCancelled ? "cancelled" : "failed";
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sftpSessionsRef],
  );

  useEffect(() => {
    sftpTransferCenterStore.publishOwner(ownerId, transfers);
  }, [ownerId, transfers]);

  const resolveAdoptionPanes = useCallback((task: TransferTask) => {
    const panes = [getActivePane("left"), getActivePane("right")].filter((pane): pane is SftpPane => !!pane?.connection);
    const sourcePane = panes.find((pane) => task.sourceHostId
      ? pane.connection?.hostId === task.sourceHostId
      : pane.connection?.isLocal);
    const targetPane = panes.find((pane) => task.targetHostId
      ? pane.connection?.hostId === task.targetHostId
      : pane.connection?.isLocal);
    return sourcePane && targetPane ? { sourcePane, targetPane } : null;
  }, [getActivePane]);

  const adoptInterruptedTransfer = useCallback(async (task: TransferTask) => {
    const panes = resolveAdoptionPanes(task);
    if (!panes?.sourcePane.connection || !panes.targetPane.connection) return;
    const adoptedTask: TransferTask = {
      ...task,
      ownerId,
      sourceConnectionId: panes.sourcePane.connection.id,
      targetConnectionId: panes.targetPane.connection.id,
    };
    const nextTransfers = [
      ...transfersRef.current.filter((candidate) => candidate.id !== task.id),
      adoptedTask,
    ];
    transfersRef.current = nextTransfers;
    setTransfers(nextTransfers);
    if (task.status !== "attention") await resumeTransfer(task.id);
  }, [ownerId, resolveAdoptionPanes, resumeTransfer]);

  useEffect(() => sftpTransferCenterStore.registerOwner(ownerId, {
    pause: pauseTransfer,
    resume: resumeTransfer,
    cancel: cancelTransfer,
    retry: retryTransfer,
    prioritize: prioritizeTransfer,
    dismiss: dismissTransfer,
    resolveConflict,
    canAdopt: (task) => resolveAdoptionPanes(task) !== null,
    canPrepareAdoption,
    adopt: adoptInterruptedTransfer,
  }), [adoptInterruptedTransfer, canPrepareAdoption, cancelTransfer, dismissTransfer, ownerId, pauseTransfer, prioritizeTransfer, resolveAdoptionPanes, resolveConflict, resumeTransfer, retryTransfer]);

  return {
    transfers,
    conflicts,
    activeTransfersCount,
    startTransfer,
    downloadToLocal,
    addExternalUpload,
    updateExternalUpload,
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    prioritizeTransfer,
    isTransferCancelled,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,
    resolveConflict,
  };
};
