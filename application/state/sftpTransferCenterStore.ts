import { useSyncExternalStore } from "react";

import type { FileConflictAction, TransferTask } from "../../domain/models";
import {
  deserializeSftpTransferCenter,
  pruneSftpTransferHistory,
  serializeSftpTransferCenter,
} from "../../domain/sftpTransferCenter";
import { STORAGE_KEY_SFTP_TRANSFER_CENTER } from "../../infrastructure/config/storageKeys";

type Listener = () => void;

export interface SftpTransferOwnerControls {
  pause: (taskId: string) => void | Promise<void>;
  resume: (taskId: string) => void | Promise<void>;
  cancel: (taskId: string) => void | Promise<void>;
  retry: (taskId: string) => void | Promise<void>;
  prioritize: (taskId: string) => void | Promise<void>;
  dismiss: (taskId: string) => void;
  canAdopt?: (task: TransferTask) => boolean;
  canPrepareAdoption?: boolean;
  adopt?: (task: TransferTask) => void | Promise<void>;
  resolveConflict?: (taskId: string, action: FileConflictAction, applyToAll?: boolean) => void | Promise<void>;
}

export interface SftpTransferCenterSnapshot {
  tasks: readonly TransferTask[];
  activeCount: number;
  queuedCount: number;
  attentionCount: number;
}

export interface SftpTransferCenterStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): SftpTransferCenterSnapshot;
  getOwnerTasks(ownerId: string): TransferTask[];
  publishOwner(ownerId: string, tasks: readonly TransferTask[]): void;
  registerOwner(ownerId: string, controls: SftpTransferOwnerControls): () => void;
  canControl(taskId: string): boolean;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  prioritize(taskId: string): Promise<void>;
  dismiss(taskId: string): void;
  clearTerminal(status?: TransferTask["status"]): void;
  ingestBackgroundEvent(event: {
    type: "queued" | "started" | "progress" | "paused" | "resumed" | "cancelled" | "completed" | "failed";
    transferId: string;
    direction?: TransferTask["direction"];
    sourcePath?: string;
    targetPath?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
    transferred?: number;
    totalBytes?: number;
    speed?: number;
    checkpointBytes?: number;
    resumeStage?: TransferTask["resumeStage"];
    downloadCheckpointBytes?: number;
    uploadCheckpointBytes?: number;
    sourceFingerprint?: string;
    sessionId?: string;
  }): void;
  resolveConflict(taskId: string, action: FileConflictAction, applyToAll?: boolean): Promise<void>;
}

interface StorePersistence {
  read(): string | null;
  write(value: string): void;
}

const EMPTY_SNAPSHOT: SftpTransferCenterSnapshot = {
  tasks: [],
  activeCount: 0,
  queuedCount: 0,
  attentionCount: 0,
};

function buildSnapshot(tasks: readonly TransferTask[]): SftpTransferCenterSnapshot {
  const topLevelTasks = tasks.filter((task) => !task.parentTaskId);
  return {
    tasks,
    activeCount: topLevelTasks.filter((task) => task.status === "transferring" || task.status === "pausing").length,
    queuedCount: topLevelTasks.filter((task) => task.status === "pending" || task.status === "queued").length,
    attentionCount: topLevelTasks.filter((task) => task.status === "attention" || task.status === "failed").length,
  };
}

export function createSftpTransferCenterStore(persistence?: StorePersistence): SftpTransferCenterStore {
  const restored = deserializeSftpTransferCenter(persistence?.read() ?? null);
  let tasks = pruneSftpTransferHistory(restored.tasks);
  let snapshot = tasks.length > 0 ? buildSnapshot(tasks) : EMPTY_SNAPSHOT;
  const listeners = new Set<Listener>();
  const controllers = new Map<string, SftpTransferOwnerControls>();

  const persist = () => {
    persistence?.write(serializeSftpTransferCenter(tasks));
  };
  const emit = () => {
    const beforePrune = tasks;
    tasks = pruneSftpTransferHistory(tasks);
    const retainedIds = new Set(tasks.map((task) => task.id));
    for (const removed of beforePrune) {
      if (retainedIds.has(removed.id)) continue;
      controllers.get(removed.ownerId ?? "")?.dismiss(removed.id);
    }
    snapshot = buildSnapshot(tasks);
    persist();
    for (const listener of listeners) listener();
  };
  const findOwner = (taskId: string) => tasks.find((task) => task.id === taskId)?.ownerId;
  const findAdopter = (task: TransferTask) => [...controllers.entries()].find(([, controls]) => (
    controls.adopt && controls.canAdopt?.(task)
  ));
  const prepareAdopter = async (task: TransferTask) => {
    let adopter = findAdopter(task);
    const preparer = [...controllers.entries()].find(([, controls]) => controls.canPrepareAdoption);
    if (!adopter && preparer && typeof globalThis.window !== "undefined") {
      const targetOwnerId = preparer[0];
      for (let attempt = 0; attempt < 60 && !adopter; attempt += 1) {
        globalThis.window.dispatchEvent(new CustomEvent("netcatty:prepare-sftp-transfer-resume", {
          detail: { task, targetOwnerId },
        }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        adopter = findAdopter(task);
      }
    }
    return adopter;
  };
  const invoke = async (taskId: string, action: "pause" | "resume" | "cancel" | "retry" | "prioritize") => {
    const ownerId = findOwner(taskId);
    let controller = ownerId ? controllers.get(ownerId) : undefined;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (
      action === "resume"
      && task
      && controller?.canAdopt
      && !controller.canAdopt(task)
    ) {
      controller = undefined;
    }
    if (!controller && action === "resume") {
      const adopter = task ? await prepareAdopter(task) : undefined;
      if (task && adopter) {
        const [adopterId, adopterControls] = adopter;
        tasks = tasks.map((candidate) => candidate.id === taskId ? { ...candidate, ownerId: adopterId } : candidate);
        emit();
        await adopterControls.adopt?.({ ...task, ownerId: adopterId });
        return;
      }
      if (task) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention",
          error: undefined,
        } : candidate);
        emit();
      }
    }
    if (!controller) return;
    await controller[action](taskId);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getOwnerTasks(ownerId) {
      return tasks.filter((task) => task.ownerId === ownerId).map((task) => ({ ...task }));
    },
    publishOwner(ownerId, ownerTasks) {
      const incoming = new Map(ownerTasks.map((task) => [task.id, task]));
      const existingIds = new Set(tasks.map((task) => task.id));
      tasks = tasks.flatMap((task) => {
        if (task.ownerId !== ownerId) return [task];
        const replacement = incoming.get(task.id);
        if (!replacement) return [];
        return [{ ...replacement, ownerId, updatedAt: replacement.updatedAt ?? Date.now() }];
      });
      for (const task of ownerTasks) {
        if (!existingIds.has(task.id)) {
          tasks.push({ ...task, ownerId, updatedAt: task.updatedAt ?? Date.now() });
        }
      }
      emit();
    },
    registerOwner(ownerId, controls) {
      controllers.set(ownerId, controls);
      return () => {
        if (controllers.get(ownerId) === controls) controllers.delete(ownerId);
      };
    },
    canControl(taskId) {
      const ownerId = findOwner(taskId);
      const task = tasks.find((candidate) => candidate.id === taskId);
      return (!!ownerId && controllers.has(ownerId)) || task?.status === "interrupted" || task?.status === "attention" || !!(task && [...controllers.values()].some((controls) => (
        controls.adopt && controls.canAdopt?.(task)
      )));
    },
    pause: (taskId) => invoke(taskId, "pause"),
    resume: (taskId) => invoke(taskId, "resume"),
    cancel: (taskId) => invoke(taskId, "cancel"),
    retry: (taskId) => invoke(taskId, "retry"),
    prioritize: (taskId) => invoke(taskId, "prioritize"),
    async resolveConflict(taskId, action, applyToAll) {
      let ownerId = findOwner(taskId);
      let controller = controllers.get(ownerId ?? "");
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!controller && task) {
        const adopter = await prepareAdopter(task);
        if (adopter) {
          const [adopterId, adopterControls] = adopter;
          ownerId = adopterId;
          controller = adopterControls;
          tasks = tasks.map((candidate) => candidate.id === taskId ? { ...candidate, ownerId: adopterId } : candidate);
          emit();
          await adopterControls.adopt?.({ ...task, ownerId: adopterId });
        }
      }
      await controller?.resolveConflict?.(taskId, action, applyToAll);
    },
    dismiss(taskId) {
      const ownerId = findOwner(taskId);
      const controller = ownerId ? controllers.get(ownerId) : undefined;
      if (controller) {
        controller.dismiss(taskId);
      }
      tasks = tasks.filter((task) => task.id !== taskId && task.parentTaskId !== taskId);
      emit();
    },
    clearTerminal(status) {
      const terminal = new Set<TransferTask["status"]>(["completed", "failed", "cancelled"]);
      const removing = tasks.filter((task) => terminal.has(task.status) && (status === undefined || task.status === status));
      for (const task of removing) {
        controllers.get(task.ownerId ?? "")?.dismiss(task.id);
      }
      const removingIds = new Set(removing.map((task) => task.id));
      tasks = tasks.filter((task) => !removingIds.has(task.id) && !removingIds.has(task.parentTaskId ?? ""));
      emit();
    },
    ingestBackgroundEvent(event) {
      const existing = tasks.find((task) => task.id === event.transferId);
      if ((event.type === "queued" || event.type === "started") && !existing) {
        const sourcePath = event.sourcePath ?? "";
        const targetPath = event.targetPath ?? "";
        tasks.push({
          id: event.transferId,
          ownerId: "background-agent",
          fileName: targetPath.split(/[\\/]/).pop() || sourcePath.split(/[\\/]/).pop() || event.transferId,
          sourcePath,
          targetPath,
          sourceConnectionId: event.direction === "upload" ? "local" : (event.sessionId ?? "agent"),
          targetConnectionId: event.direction === "download" ? "local" : (event.sessionId ?? "agent"),
          direction: event.direction ?? "upload",
          status: event.type === "queued" ? "queued" : "transferring",
          totalBytes: 0,
          transferredBytes: 0,
          speed: 0,
          startTime: event.startedAt ?? Date.now(),
          isDirectory: false,
          origin: "agent",
          background: true,
          resumable: true,
        });
      } else if (existing && (event.type === "queued" || event.type === "started")) {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          status: event.type === "queued" ? "queued" : "transferring",
          error: undefined,
          endTime: undefined,
        } : task);
      } else if (existing && event.type === "progress") {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          transferredBytes: event.transferred ?? task.transferredBytes,
          totalBytes: event.totalBytes ?? task.totalBytes,
          speed: event.speed ?? task.speed,
        } : task);
      } else if (existing && (event.type === "paused" || event.type === "resumed")) {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          status: event.type === "paused" ? "paused" : "transferring",
          speed: event.type === "paused" ? 0 : task.speed,
          checkpointBytes: event.checkpointBytes ?? task.checkpointBytes,
          resumeStage: event.resumeStage ?? task.resumeStage,
          downloadCheckpointBytes: event.downloadCheckpointBytes ?? task.downloadCheckpointBytes,
          uploadCheckpointBytes: event.uploadCheckpointBytes ?? task.uploadCheckpointBytes,
          sourceFingerprint: event.sourceFingerprint ?? task.sourceFingerprint,
        } : task);
      } else if (existing && event.type !== "started") {
        tasks = tasks.map((task) => task.id === event.transferId ? {
          ...task,
          status: event.type === "completed" ? "completed" : event.type === "cancelled" ? "cancelled" : "failed",
          error: event.error,
          endTime: event.endedAt ?? Date.now(),
          speed: 0,
        } : task);
      }
      emit();
    },
  };
}

const browserPersistence: StorePersistence | undefined = typeof globalThis.localStorage === "undefined"
  ? undefined
  : {
      read: () => globalThis.localStorage.getItem(STORAGE_KEY_SFTP_TRANSFER_CENTER),
      write: (value) => globalThis.localStorage.setItem(STORAGE_KEY_SFTP_TRANSFER_CENTER, value),
    };

export const sftpTransferCenterStore = createSftpTransferCenterStore(browserPersistence);

export function useSftpTransferCenter(): SftpTransferCenterSnapshot {
  return useSyncExternalStore(
    sftpTransferCenterStore.subscribe,
    sftpTransferCenterStore.getSnapshot,
    sftpTransferCenterStore.getSnapshot,
  );
}
