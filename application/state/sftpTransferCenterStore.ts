import { useSyncExternalStore } from "react";

import type { FileConflictAction, TransferTask } from "../../domain/models";
import {
  deserializeSftpTransferCenter,
  pruneSftpTransferHistory,
  serializeSftpTransferCenter,
} from "../../domain/sftpTransferCenter";
import { STORAGE_KEY_SFTP_TRANSFER_CENTER } from "../../infrastructure/config/storageKeys";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { globalSftpTransferScheduler } from "./sftp/globalTransferScheduler";

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

export type DedicatedTransferResumeHandler = (task: TransferTask) => Promise<{ success: boolean; error?: string }>;

export interface SftpTransferCenterStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): SftpTransferCenterSnapshot;
  getOwnerTasks(ownerId: string): TransferTask[];
  publishOwner(ownerId: string, tasks: readonly TransferTask[]): void;
  registerOwner(ownerId: string, controls: SftpTransferOwnerControls): () => void;
  setDedicatedResumeHandler(handler: DedicatedTransferResumeHandler | null): void;
  patchTask(taskId: string, updates: Partial<TransferTask>): void;
  canControl(taskId: string): boolean;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  prioritize(taskId: string): Promise<void>;
  dismiss(taskId: string): void;
  clearTerminal(status?: TransferTask["status"]): void;
  markReconnectRequired(taskId: string, error?: string): void;
  reportResumePreparationFailure(taskId: string, error: string): void;
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
    sourceHostId?: string;
    targetHostId?: string;
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
  const resumeInvocations = new Map<string, Promise<void>>();
  const resumePreparationFailures = new Map<string, string>();
  let dedicatedResumeHandler: DedicatedTransferResumeHandler | null = null;

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
    let preparationError: string | undefined;
    let cancelled = false;
    if (!adopter && typeof globalThis.window !== "undefined") {
      // Open the SFTP panel on the active terminal tab first so a preparer can
      // register, then ask it to reconnect the required hosts.
      globalThis.window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
        detail: { task, forResume: true },
      }));
      // ~45s is enough for MFA/password prompts; longer felt like a hang.
      const maxAttempts = 90;
      let prepareDispatched = false;
      for (let attempt = 0; attempt < maxAttempts && !adopter && !preparationError; attempt += 1) {
        const currentTask = tasks.find((candidate) => candidate.id === task.id);
        if (!currentTask || ["cancelled", "completed"].includes(currentTask.status)) {
          cancelled = true;
          break;
        }
        preparationError = resumePreparationFailures.get(task.id);
        if (preparationError) break;
        const preparer = [...controllers.entries()].find(([, controls]) => controls.canPrepareAdoption);
        if (preparer && !prepareDispatched) {
          prepareDispatched = true;
          globalThis.window.dispatchEvent(new CustomEvent("netcatty:prepare-sftp-transfer-resume", {
            detail: {
              task,
              targetOwnerId: preparer[0],
              reportFailure: (error: string) => {
                preparationError = error;
                resumePreparationFailures.set(task.id, error);
              },
            },
          }));
        } else if (!preparer && attempt === 10) {
          // Re-request panel open if nothing registered after a few seconds.
          globalThis.window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
            detail: { task, forResume: true },
          }));
          prepareDispatched = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        adopter = findAdopter(task);
      }
      if (!adopter && !preparationError && !cancelled) {
        preparationError = resumePreparationFailures.get(task.id)
          ?? "Could not reconnect in time. Open an SFTP panel and try again.";
      }
    }
    resumePreparationFailures.delete(task.id);
    return { adopter, error: preparationError, cancelled };
  };
  const invoke = async (taskId: string, requestedAction: "pause" | "resume" | "cancel" | "retry" | "prioritize") => {
    let action = requestedAction;
    const ownerId = findOwner(taskId);
    let controller = ownerId ? controllers.get(ownerId) : undefined;
    const task = tasks.find((candidate) => candidate.id === taskId);
    // Intentional resume/retry must clear a pre-start cancel latch left by an
    // earlier cancel that never hit startTransferNow (same transferId).
    if (action === "resume" || action === "retry") {
      try {
        await netcattyBridge.get()?.clearPendingTransferCancel?.(taskId);
      } catch {
        // best-effort
      }
    }
    // After app restart (or any reconnectRequired task), a retained panel owner
    // often cannot resume (missing panes / dead sftpId). Prefer a dedicated
    // transfer session instead of failing with "Reconnect the source and target".
    // Never dedicated-resume rows waiting on conflict resolution — that would
    // stream with replace semantics and skip Replace/Skip/Duplicate UI.
    const needsDedicatedReconnect = action === "resume" && !!task && !task.conflict && (
      task.reconnectRequired === true
      || task.status === "interrupted"
      || (task.status === "attention" && !task.conflict)
      || task.ownerId === "background-agent"
    );
    if (needsDedicatedReconnect && controller && !controller.canAdopt?.(task)) {
      controller = undefined;
    }
    // Prefer the live owner controller for pause/resume of still-active work.
    // Do NOT drop it just because canAdopt is false when the transfer is still
    // live in the backend — downloads often have only a remote pane open.
    if (action === "resume" && task && (needsDedicatedReconnect || !controller)) {
      // Immediate UI feedback: spinner + "Reconnecting…" while we open a session.
      tasks = tasks.map((candidate) => candidate.id === taskId ? {
        ...candidate,
        status: "pending",
        error: undefined,
        speed: 0,
        phase: undefined,
        reconnectRequired: true,
      } : candidate);
      emit();
    }
    if (!controller && (action === "resume" || action === "pause")) {
      // Transfer-owned session leases keep the backend transfer alive after the
      // SFTP panel disconnects/unmounts. Unpause/pause directly before forcing
      // a UI re-connect.
      try {
        const bridge = netcattyBridge.get();
        if (action === "resume" && bridge?.resumeTransfer) {
          const live = await bridge.resumeTransfer(taskId);
          if (live?.success) {
            tasks = tasks.map((candidate) => candidate.id === taskId ? {
              ...candidate,
              status: "transferring",
              error: undefined,
              reconnectRequired: false,
              pauseUnavailableReason: undefined,
              phase: undefined,
              speed: candidate.speed,
            } : candidate);
            emit();
            return;
          }
        }
        if (action === "pause" && bridge?.pauseTransfer) {
          // Dedicated reconnect cannot soft-pause before the stream exists.
          // Do not cancel here (quit confirmation also calls pause) — user must
          // Cancel explicitly; skip demotion so the reconnect spinner remains.
          if (task?.ownerId === "dedicated-resume" && task.reconnectRequired) {
            return;
          }
          const live = await bridge.pauseTransfer(taskId);
          const afterLivePause = tasks.find((candidate) => candidate.id === taskId);
          if (afterLivePause?.status === "cancelled") return;
          if (live?.success) {
            tasks = tasks.map((candidate) => candidate.id === taskId ? {
              ...candidate,
              status: "paused",
              speed: 0,
              checkpointBytes: live.checkpointBytes ?? candidate.checkpointBytes,
              resumeStage: live.resumeStage ?? candidate.resumeStage,
              downloadCheckpointBytes: live.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
              uploadCheckpointBytes: live.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
              sourceFingerprint: live.sourceFingerprint ?? candidate.sourceFingerprint,
            } : candidate);
            emit();
            return;
          }
          // Live transfer that cannot pause safely — keep transferring, do not
          // demote to interrupted (that falsely claims work stopped).
          if (live && /cannot be paused|unavailable|no longer active/i.test(live.reason || "")
            && !/not found|session/i.test(live.reason || "")) {
            if (live.reason && !/no longer active/i.test(live.reason)) {
              tasks = tasks.map((candidate) => candidate.id === taskId ? {
                ...candidate,
                pauseUnavailableReason: live.reason,
              } : candidate);
              emit();
            }
            // "no longer active" falls through to interrupted demotion below.
            if (!/no longer active/i.test(live.reason || "")) return;
          }
        }
      } catch {
        // Bridge unavailable (tests / non-Electron) — fall through.
      }
      // Dead "transferring" rows after restart have no backend handle. Demote
      // them so pause-all / the UI stop claiming work is still active.
      // Do not demote a row that was cancelled while pause was in flight.
      const afterPause = tasks.find((candidate) => candidate.id === taskId);
      if (afterPause?.status === "cancelled") return;
      if (action === "pause" && task && ["transferring", "pausing", "pending", "queued"].includes(afterPause?.status ?? task.status)) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "interrupted",
          speed: 0,
          phase: undefined,
          reconnectRequired: true,
          error: candidate.error ?? "Transfer was interrupted. Resume to continue.",
        } : candidate);
        emit();
        return;
      }
    }
    // Preferred path after app restart / closed server: open a dedicated SFTP
    // session from vault credentials and continue from the checkpoint. Does not
    // require any UI panel to still be open. Directory trees need panel/process
    // recursion — skip dedicated single-file resume for those.
    if (
      (!controller || needsDedicatedReconnect)
      && action === "resume"
      && task
      && !task.conflict
      && dedicatedResumeHandler
      && !task.isDirectory
    ) {
      const previousOwnerId = task.ownerId;
      // Detach from the panel owner immediately so publishOwner cannot clobber
      // in-flight dedicated progress with a stale interrupted/paused snapshot.
      tasks = tasks.map((candidate) => candidate.id === taskId ? {
        ...candidate,
        ownerId: "dedicated-resume",
        status: "pending",
        error: undefined,
        reconnectRequired: true,
        speed: 0,
        phase: undefined,
        updatedAt: Date.now(),
      } : candidate);
      emit();
      const latest = tasks.find((candidate) => candidate.id === taskId) ?? task;
      const result = await dedicatedResumeHandler({
        ...latest,
        ownerId: "dedicated-resume",
        reconnectRequired: true,
      });
      // Cancel/pause may finish while dedicated resume was still reconnecting.
      const afterDedicated = tasks.find((candidate) => candidate.id === taskId);
      if (!afterDedicated || afterDedicated.status === "cancelled") {
        try { await netcattyBridge.get()?.cancelTransfer?.(taskId); } catch { /* best-effort */ }
        return;
      }
      if (result.success) {
        // Stream finished successfully. Even if the user hit pause during the
        // reconnect spinner (status demoted to interrupted), the file is done —
        // promote to completed rather than leaving a false interrupted row.
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          ownerId: "dedicated-resume",
          status: "completed",
          transferredBytes: Math.max(candidate.transferredBytes, candidate.totalBytes || candidate.transferredBytes),
          speed: 0,
          endTime: Date.now(),
          error: undefined,
          reconnectRequired: false,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
      if (afterDedicated.status === "paused" || afterDedicated.status === "interrupted") {
        // Keep interrupted/paused without calling cancelTransfer — that would
        // poison pendingCancelTransferIds and break a later same-id resume.
        return;
      }
      const cancelLike = /cancelled|canceled/i.test(result.error || "");
      if (cancelLike) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "cancelled",
          error: undefined,
          endTime: Date.now(),
          speed: 0,
          reconnectRequired: false,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
      // Soft failure for server-to-server (needs panel) — restore prior owner
      // so a live controller can still resume, or fall through to adoption.
      if (result.error && /SFTP panel|both hosts/i.test(result.error)) {
        const restoreOwner = previousOwnerId && previousOwnerId !== "dedicated-resume"
          ? previousOwnerId
          : ownerId;
        const restoredTask = {
          ...(tasks.find((candidate) => candidate.id === taskId) ?? task),
          ownerId: restoreOwner || "dedicated-resume",
          status: "attention" as const,
          error: result.error,
          reconnectRequired: true,
          speed: 0,
          phase: undefined,
        };
        if (restoreOwner) {
          tasks = tasks.map((candidate) => candidate.id === taskId ? restoredTask : candidate);
          emit();
          controller = controllers.get(restoreOwner);
          // Re-home via adopt (not resume) — the panel dropped the row while
          // ownership was dedicated-resume, so resume would no-op.
          if (controller?.canAdopt?.(restoredTask) && controller.adopt) {
            await controller.adopt({ ...restoredTask, ownerId: restoreOwner, reconnectRequired: true });
            return;
          }
          // Live owner cannot adopt (missing host panes) — clear so prepareAdopter runs.
          controller = undefined;
        }
      } else if (result.error) {
        // Hard dedicated failure.
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention",
          error: result.error,
          reconnectRequired: true,
          speed: 0,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
    }
    if (!controller && action === "resume") {
      const prepared = task ? await prepareAdopter(task) : undefined;
      const adopter = prepared?.adopter;
      const currentTask = tasks.find((candidate) => candidate.id === taskId);
      if (prepared?.cancelled || !currentTask || ["cancelled", "completed"].includes(currentTask.status)) return;
      if (task && adopter) {
        const [adopterId, adopterControls] = adopter;
        // Rehome parent + directory children together so completed child
        // checkpoints survive publishOwner / foreign-owner stripping.
        tasks = tasks.map((candidate) => (
          candidate.id === taskId || candidate.parentTaskId === taskId
            ? { ...candidate, ownerId: adopterId }
            : candidate
        ));
        emit();
        await adopterControls.adopt?.({ ...task, ownerId: adopterId, reconnectRequired: true });
        return;
      }
      if (task) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "attention",
          error: prepared?.error ?? "Could not reconnect. Check the host credentials and try again.",
          reconnectRequired: true,
        } : candidate);
        emit();
      }
    }
    if (!controller && action === "cancel" && task && ["paused", "interrupted", "attention", "pending", "queued", "transferring", "pausing"].includes(task.status)) {
      const childIds = tasks
        .filter((candidate) => candidate.parentTaskId === taskId)
        .map((candidate) => candidate.id);
      try {
        globalSftpTransferScheduler.cancel(taskId);
        for (const childId of childIds) globalSftpTransferScheduler.cancel(childId);
      } catch {
        // best-effort
      }
      try {
        await netcattyBridge.get()?.cancelTransfer?.(taskId);
        for (const childId of childIds) {
          try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
        }
      } catch {
        // Best-effort backend cancel when the owning panel is gone / no window.
      }
      try {
        await netcattyBridge.get()?.cleanupTransferArtifacts?.({
          transferId: taskId,
          sourcePath: task.sourcePath,
          targetPath: task.targetPath,
          stagedTargetPath: task.stagedTargetPath,
        });
      } catch {
        // best-effort temp/.part cleanup
      }
      const cancelIds = new Set([taskId, ...childIds]);
      tasks = tasks.map((candidate) => cancelIds.has(candidate.id) ? {
        ...candidate,
        status: "cancelled",
        error: undefined,
        endTime: Date.now(),
        speed: 0,
        conflict: undefined,
      } : candidate);
      emit();
      return;
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
        // Tasks reassigned to dedicated-resume (or other owners) are not
        // clobbered by this panel's local snapshot.
        if (task.ownerId !== ownerId) return [task];
        const replacement = incoming.get(task.id);
        if (!replacement) return [];
        return [{ ...replacement, ownerId, updatedAt: replacement.updatedAt ?? Date.now() }];
      });
      for (const task of ownerTasks) {
        // Never re-introduce a panel row that already exists under another owner
        // (e.g. completed via dedicated resume while the panel still holds interrupted).
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
    setDedicatedResumeHandler(handler) {
      dedicatedResumeHandler = handler;
    },
    patchTask(taskId, updates) {
      let changed = false;
      tasks = tasks.map((task) => {
        if (task.id !== taskId) return task;
        // Never resurrect a user-stopped row via dedicated-resume progress.
        if (task.status === "cancelled") return task;
        // Dedicated-owned rows may move pending → transferring while a panel
        // still holds a local interrupted copy that is no longer authoritative.
        if (
          task.ownerId !== "dedicated-resume"
          && (task.status === "paused" || task.status === "interrupted")
          && (updates.status === "transferring" || updates.status === "pending" || updates.status === "completed")
        ) {
          return task;
        }
        changed = true;
        return { ...task, ...updates, updatedAt: Date.now() };
      });
      if (changed) emit();
    },
    canControl(taskId) {
      const ownerId = findOwner(taskId);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return false;
      const hasLiveOwner = !!ownerId && controllers.has(ownerId);
      if (hasLiveOwner) return true;
      // After restart (or panel unmount) unfinished tasks stay in the store with
      // no owner controller. The global center must still be able to resume,
      // cancel, or dismiss them — otherwise they become dead rows.
      const terminal = task.status === "completed" || task.status === "cancelled";
      // Failed rows stay controllable so orphan Retry/Resume can still run after restart.
      if (!terminal && task.status !== "failed") return true;
      if (task.status === "failed") return true;
      return !!(task && [...controllers.values()].some((controls) => (
        controls.adopt && controls.canAdopt?.(task)
      )));
    },
    pause: (taskId) => invoke(taskId, "pause"),
    async resume(taskId) {
      const existing = resumeInvocations.get(taskId);
      if (existing) {
        // Dedicated resume holds the invocation for the full stream lifetime.
        // If the user paused mid-transfer, unpause the backend instead of
        // returning a promise that never re-issues resumeTransfer.
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (task && (task.status === "paused" || task.status === "pausing")) {
          try {
            const live = await netcattyBridge.get()?.resumeTransfer?.(taskId);
            if (live?.success) {
              tasks = tasks.map((candidate) => candidate.id === taskId ? {
                ...candidate,
                status: "transferring",
                error: undefined,
                reconnectRequired: false,
                pauseUnavailableReason: undefined,
                phase: undefined,
              } : candidate);
              emit();
            }
          } catch {
            // Fall through to returning the in-flight resume promise.
          }
        }
        return existing;
      }
      const running = invoke(taskId, "resume").finally(() => {
        if (resumeInvocations.get(taskId) === running) resumeInvocations.delete(taskId);
      });
      resumeInvocations.set(taskId, running);
      return running;
    },
    cancel: (taskId) => invoke(taskId, "cancel"),
    async retry(taskId) {
      const ownerId = findOwner(taskId);
      const controller = controllers.get(ownerId ?? "");
      if (controller) {
        await controller.retry(taskId);
        return;
      }
      // Orphaned after restart: clear checkpoint so Retry truly restarts, then
      // resume (dedicated or adopt) from byte 0.
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (task) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          status: "interrupted",
          error: undefined,
          checkpointBytes: 0,
          transferredBytes: 0,
          downloadCheckpointBytes: undefined,
          uploadCheckpointBytes: undefined,
          resumeStage: undefined,
          sourceFingerprint: undefined,
          reconnectRequired: true,
          speed: 0,
          endTime: undefined,
        } : candidate);
        emit();
        try {
          await netcattyBridge.get()?.cleanupTransferArtifacts?.({
            transferId: taskId,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            stagedTargetPath: task.stagedTargetPath,
          });
        } catch {
          // best-effort
        }
      }
      await this.resume(taskId);
    },
    prioritize(taskId) {
      const ownerId = findOwner(taskId);
      const controller = controllers.get(ownerId ?? "");
      if (controller) {
        void controller.prioritize(taskId);
        return;
      }
      // Orphan: still bump store priority and ask backend / renderer scheduler.
      tasks = tasks.map((candidate) => candidate.id === taskId
        ? { ...candidate, priority: Date.now(), updatedAt: Date.now() }
        : candidate);
      emit();
      try {
        void netcattyBridge.get()?.prioritizeTransfer?.(taskId);
      } catch {
        // best-effort
      }
      try {
        globalSftpTransferScheduler.prioritize(taskId);
      } catch {
        // Scheduler may be empty in pure node tests.
      }
    },
    async resolveConflict(taskId, action, applyToAll) {
      let ownerId = findOwner(taskId);
      let controller = controllers.get(ownerId ?? "");
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!controller && task) {
        const prepared = await prepareAdopter(task);
        if (prepared.cancelled) return;
        const adopter = prepared.adopter;
        if (!adopter) {
          tasks = tasks.map((candidate) => candidate.id === taskId ? {
            ...candidate,
            status: "attention",
            error: prepared.error ?? "Could not open an SFTP panel to resolve this conflict.",
            reconnectRequired: true,
          } : candidate);
          emit();
          return;
        }
        const [adopterId, adopterControls] = adopter;
        const current = tasks.find((candidate) => candidate.id === taskId);
        if (!current || current.status === "cancelled" || current.status === "completed") return;
        ownerId = adopterId;
        controller = adopterControls;
        tasks = tasks.map((candidate) => candidate.id === taskId ? { ...candidate, ownerId: adopterId } : candidate);
        emit();
        await adopterControls.adopt?.({ ...current, ownerId: adopterId });
        const afterAdopt = tasks.find((candidate) => candidate.id === taskId);
        if (!afterAdopt || afterAdopt.status === "cancelled") return;
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
      const unfinishedParents = new Set(
        tasks.filter((task) => !terminal.has(task.status)).map((task) => task.id),
      );
      // Do not wipe completed children of an unfinished directory parent —
      // those rows are resume checkpoints, not disposable history.
      const removing = tasks.filter((task) =>
        terminal.has(task.status)
        && (status === undefined || task.status === status)
        && !(task.parentTaskId && unfinishedParents.has(task.parentTaskId)),
      );
      for (const task of removing) {
        controllers.get(task.ownerId ?? "")?.dismiss(task.id);
      }
      const removingIds = new Set(removing.map((task) => task.id));
      tasks = tasks.filter((task) => !removingIds.has(task.id) && !removingIds.has(task.parentTaskId ?? ""));
      emit();
    },
    markReconnectRequired(taskId, error) {
      tasks = tasks.map((task) => task.id === taskId ? {
        ...task,
        status: "attention",
        error: error ?? "The original server connection is unavailable",
        reconnectRequired: true,
        speed: 0,
      } : task);
      emit();
    },
    reportResumePreparationFailure(taskId, error) {
      resumePreparationFailures.set(taskId, error);
    },
    ingestBackgroundEvent(event) {
      const existing = tasks.find((task) => task.id === event.transferId);
      const terminal = existing
        && (existing.status === "cancelled" || existing.status === "completed" || existing.status === "failed");
      // Never resurrect a finished/cancelled agent row with late queued/progress.
      if (terminal && event.type !== "cancelled") {
        // Allow a late explicit cancel to stick; ignore everything else.
        if (event.type === "completed" || event.type === "failed") {
          // Keep existing terminal state (prefer cancelled over late completed).
          return;
        }
        if (event.type === "queued" || event.type === "started" || event.type === "progress" || event.type === "resumed" || event.type === "paused") {
          return;
        }
      }
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
          sourceHostId: event.sourceHostId,
          targetHostId: event.targetHostId,
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
          checkpointBytes: event.checkpointBytes ?? task.checkpointBytes,
          resumeStage: event.resumeStage ?? task.resumeStage,
          downloadCheckpointBytes: event.downloadCheckpointBytes ?? task.downloadCheckpointBytes,
          uploadCheckpointBytes: event.uploadCheckpointBytes ?? task.uploadCheckpointBytes,
          sourceFingerprint: event.sourceFingerprint ?? task.sourceFingerprint,
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
