import type { TransferTask, TransferStatus } from "../../../domain/models";
import type { UploadCallbacks, UploadTaskInfo } from "../../../lib/uploadService";
import { joinPath } from "./utils";

interface UploadTaskCallbacksParams {
  connectionId: string;
  targetPath: string;
  targetHostId?: string;
  targetHostLabel?: string;
  targetConnectionKey?: string;
  addExternalUpload?: (task: TransferTask) => void;
  updateExternalUpload?: (taskId: string, updates: Partial<TransferTask>) => void;
  dismissExternalUpload?: (taskId: string) => void;
}

export const createUploadTaskCallbacks = ({
  connectionId,
  targetPath,
  targetHostId,
  targetHostLabel,
  targetConnectionKey,
  addExternalUpload,
  updateExternalUpload,
  dismissExternalUpload,
}: UploadTaskCallbacksParams): UploadCallbacks => ({
  onScanningStart: (taskId: string) => {
    if (!addExternalUpload) return;
    addExternalUpload({
      id: taskId,
      fileName: "Scanning files...",
      sourcePath: "local",
      targetPath,
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetHostLabel,
      sourceHostLabel: "Local",
      targetConnectionKey,
      direction: "upload",
      status: "pending" as TransferStatus,
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: true,
      progressMode: "bytes",
      origin: "drag-drop",
      background: false,
      resumable: true,
      phase: "scanning",
    });
  },
  onScanningEnd: (taskId: string) => {
    dismissExternalUpload?.(taskId);
  },
  onTaskCreated: (task: UploadTaskInfo) => {
    if (!addExternalUpload) return;
    addExternalUpload({
      id: task.id,
      fileName: task.displayName,
      sourcePath: task.sourcePath ?? "local",
      targetPath: joinPath(targetPath, task.fileName),
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetHostLabel,
      sourceHostLabel: "Local",
      targetConnectionKey,
      direction: "upload",
      status: "transferring" as TransferStatus,
      totalBytes: task.totalBytes,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: task.isDirectory,
      progressMode: task.progressMode ?? "bytes",
      parentTaskId: task.parentTaskId,
      origin: "drag-drop",
      background: false,
      resumable: true,
      phase: "transferring",
    });
  },
  onTaskProgress: (taskId: string, progress) => {
    updateExternalUpload?.(taskId, {
      transferredBytes: progress.transferred,
      checkpointBytes: progress.transferred,
      speed: progress.speed,
      resumable: progress.resumable,
      pauseUnavailableReason: progress.pauseUnavailableReason,
    });
  },
  onTaskNameUpdate: (taskId: string, value: string) => {
    const separator = value.lastIndexOf("|");
    const phase = separator >= 0 ? value.slice(separator + 1) : "transferring";
    updateExternalUpload?.(taskId, {
      phase: phase === "compressed" ? "transferring" : phase as TransferTask["phase"],
    });
  },
  onTaskCompleted: (taskId: string, totalBytes: number) => {
    updateExternalUpload?.(taskId, {
      status: "completed" as TransferStatus,
      endTime: Date.now(),
      transferredBytes: totalBytes,
      speed: 0,
    });
  },
  onTaskFailed: (taskId: string, error: string) => {
    updateExternalUpload?.(taskId, {
      status: "failed" as TransferStatus,
      endTime: Date.now(),
      error,
      speed: 0,
    });
  },
  onTaskCancelled: (taskId: string) => {
    updateExternalUpload?.(taskId, {
      status: "cancelled" as TransferStatus,
      endTime: Date.now(),
      speed: 0,
    });
  },
});
