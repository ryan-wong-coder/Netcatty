import type { TransferTask } from "./models";

export const SFTP_TRANSFER_CENTER_VERSION = 1;
export const SFTP_TRANSFER_HISTORY_MAX = 200;
export const SFTP_TRANSFER_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set<TransferTask["status"]>(["completed", "failed", "cancelled"]);
const RUNNING_STATUSES = new Set<TransferTask["status"]>(["transferring", "pausing"]);
// After an app restart no backend streams/sessions remain. Any non-terminal
// in-flight status must become a manual-resume "interrupted" task — including
// paused work, which also loses its live transfer handle on quit.
const RESTORED_INTERRUPTED_STATUSES = new Set<TransferTask["status"]>([
  "pending",
  "queued",
  "transferring",
  "pausing",
  "paused",
]);

export interface PersistedSftpTransferCenter {
  version: typeof SFTP_TRANSFER_CENTER_VERSION;
  tasks: TransferTask[];
}

const SAFE_TASK_KEYS: ReadonlySet<keyof TransferTask> = new Set([
  "id", "batchId", "fileName", "originalFileName", "sourcePath", "targetPath",
  "sourceConnectionId", "targetConnectionId", "targetHostId", "targetConnectionKey",
  "direction", "status", "totalBytes", "transferredBytes", "speed", "error",
  "startTime", "endTime", "isDirectory", "progressMode", "childTasks", "parentTaskId",
  "sourceLastModified", "skipConflictCheck", "replaceExistingTarget", "retryable",
  "ownerId", "sourceHostId", "sourceHostLabel", "targetHostLabel", "origin", "background",
  "phase", "resumable", "checkpointBytes", "priority", "updatedAt", "pauseUnavailableReason",
  "resumeStage", "downloadCheckpointBytes", "uploadCheckpointBytes",
  "conflict",
  "stagedTargetPath",
  "sourceFingerprint",
  "reconnectRequired",
]);

function sanitizeTask(value: unknown): TransferTask | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.fileName !== "string") return null;
  if (typeof source.sourcePath !== "string" || typeof source.targetPath !== "string") return null;
  const sanitized: Record<string, unknown> = {};
  for (const key of SAFE_TASK_KEYS) {
    if (source[key] !== undefined) sanitized[key] = source[key];
  }
  const task = sanitized as unknown as TransferTask;
  if (RESTORED_INTERRUPTED_STATUSES.has(task.status)) {
    task.status = "interrupted";
    task.speed = 0;
    task.reconnectRequired = true;
    // Phase labels like "transferring" would otherwise still render as "传输中"
    // even though the task is dead after restart.
    task.phase = undefined;
    task.error = task.error || undefined;
  }
  return task;
}

export function serializeSftpTransferCenter(tasks: readonly TransferTask[]): string {
  return JSON.stringify({
    version: SFTP_TRANSFER_CENTER_VERSION,
    tasks: tasks.map((task) => sanitizeTask(task)).filter((task): task is TransferTask => task !== null),
  } satisfies PersistedSftpTransferCenter);
}

export function deserializeSftpTransferCenter(raw: string | null | undefined): PersistedSftpTransferCenter {
  if (!raw) return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; tasks?: unknown };
    if (parsed.version !== SFTP_TRANSFER_CENTER_VERSION || !Array.isArray(parsed.tasks)) {
      return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
    }
    return {
      version: SFTP_TRANSFER_CENTER_VERSION,
      tasks: parsed.tasks.map(sanitizeTask).filter((task): task is TransferTask => task !== null),
    };
  } catch {
    return { version: SFTP_TRANSFER_CENTER_VERSION, tasks: [] };
  }
}

export function pruneSftpTransferHistory(
  tasks: readonly TransferTask[],
  now = Date.now(),
): TransferTask[] {
  const unfinished = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const unfinishedIds = new Set(unfinished.map((task) => task.id));
  // Keep terminal children of unfinished parents forever (until the parent
  // finishes) so directory resume can skip already-completed files.
  const checkpointChildren = tasks.filter((task) =>
    TERMINAL_STATUSES.has(task.status)
    && !!task.parentTaskId
    && unfinishedIds.has(task.parentTaskId),
  );
  const checkpointIds = new Set(checkpointChildren.map((task) => task.id));
  const terminal = tasks
    .filter((task) => TERMINAL_STATUSES.has(task.status) && !checkpointIds.has(task.id))
    .filter((task) => now - (task.endTime ?? task.updatedAt ?? task.startTime) <= SFTP_TRANSFER_HISTORY_MAX_AGE_MS)
    .sort((a, b) => (b.endTime ?? b.updatedAt ?? b.startTime) - (a.endTime ?? a.updatedAt ?? a.startTime))
    .slice(0, SFTP_TRANSFER_HISTORY_MAX);
  return [...unfinished, ...checkpointChildren, ...terminal].sort((a, b) => a.startTime - b.startTime);
}

export function validateTransferResumeSource(
  task: Pick<TransferTask, "totalBytes" | "sourceLastModified" | "checkpointBytes">,
  source: { size: number; lastModified?: number },
): string | null {
  const checkpoint = Math.max(0, task.checkpointBytes ?? 0);
  if (checkpoint > source.size) return "Saved checkpoint is beyond the current source size";
  if (task.totalBytes > 0 && source.size !== task.totalBytes) return "Source size changed while the transfer was paused";
  if (
    task.sourceLastModified
    && source.lastModified
    && source.lastModified !== task.sourceLastModified
  ) {
    return "Source was modified while the transfer was paused";
  }
  return null;
}

export interface SftpTransferCenter {
  add(ownerId: string, tasks: readonly TransferTask[]): void;
  update(taskId: string, updates: Partial<TransferTask>): void;
  pause(taskId: string): void;
  resume(taskId: string): void;
  prioritize(taskId: string): void;
  complete(taskId: string): void;
  takeRunnable(): TransferTask[];
  getTask(taskId: string): TransferTask | undefined;
  getTasks(): readonly TransferTask[];
}

export function createSftpTransferCenter({ concurrency }: { concurrency: number }): SftpTransferCenter {
  let tasks: TransferTask[] = [];
  let prioritySequence = 0;

  const replace = (taskId: string, updates: Partial<TransferTask>) => {
    tasks = tasks.map((task) => task.id === taskId
      ? { ...task, ...updates, updatedAt: updates.updatedAt ?? Date.now() }
      : task);
  };

  return {
    add(ownerId, incoming) {
      const existingIds = new Set(tasks.map((item) => item.id));
      tasks = [
        ...tasks,
        ...incoming.filter((item) => !existingIds.has(item.id)).map((item) => ({ ...item, ownerId })),
      ];
    },
    update: replace,
    pause(taskId) {
      const current = tasks.find((item) => item.id === taskId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      replace(taskId, { status: "paused", speed: 0 });
    },
    resume(taskId) {
      const current = tasks.find((item) => item.id === taskId);
      if (!current || !["paused", "interrupted", "failed", "attention"].includes(current.status)) return;
      replace(taskId, { status: "queued", error: undefined, endTime: undefined });
    },
    prioritize(taskId) {
      prioritySequence += 1;
      replace(taskId, { priority: prioritySequence });
    },
    complete(taskId) {
      replace(taskId, { status: "completed", endTime: Date.now(), speed: 0 });
    },
    takeRunnable() {
      const openSlots = Math.max(0, Math.floor(concurrency) - tasks.filter((item) => RUNNING_STATUSES.has(item.status)).length);
      if (openSlots === 0) return [];
      const queued = tasks
        .filter((item) => item.status === "queued" && !item.parentTaskId)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.startTime - b.startTime);
      const selected: TransferTask[] = [];
      const owners = new Set<string>();
      for (const task of queued) {
        const owner = task.ownerId ?? "global";
        if (owners.has(owner) && queued.some((candidate) => (
          candidate.id !== task.id
          && !selected.includes(candidate)
          && !owners.has(candidate.ownerId ?? "global")
        ))) continue;
        selected.push(task);
        owners.add(owner);
        if (selected.length >= openSlots) break;
      }
      for (const task of selected) replace(task.id, { status: "transferring" });
      return selected.map((task) => tasks.find((item) => item.id === task.id) ?? task);
    },
    getTask(taskId) {
      return tasks.find((item) => item.id === taskId);
    },
    getTasks() {
      return tasks;
    },
  };
}
