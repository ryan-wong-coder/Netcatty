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
import { isBenignPauseMiss, planPartialPauseRollback } from "./sftp/pauseTransferOutcome";

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

export type DedicatedTransferResumeHandler = (task: TransferTask) => Promise<{
  success: boolean;
  error?: string;
  needsAttention?: boolean;
  resetCheckpoint?: boolean;
}>;

export interface SftpTransferCenterStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): SftpTransferCenterSnapshot;
  getOwnerTasks(ownerId: string): TransferTask[];
  publishOwner(ownerId: string, tasks: readonly TransferTask[]): void;
  registerOwner(ownerId: string, controls: SftpTransferOwnerControls): () => void;
  setDedicatedResumeHandler(handler: DedicatedTransferResumeHandler | null): void;
  patchTask(taskId: string, updates: Partial<TransferTask>): void;
  /** Insert or merge tasks by id (used by dedicated directory resume for children). */
  upsertTasks(incoming: readonly TransferTask[]): void;
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
          const afterLiveResume = tasks.find((candidate) => candidate.id === taskId);
          if (afterLiveResume?.status === "cancelled") return;
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
          // Directory dedicated resume streams use child transferIds — pause them all.
          const childIds = task?.isDirectory
            ? tasks
              .filter((candidate) => candidate.parentTaskId === taskId
                && !["completed", "cancelled", "failed"].includes(candidate.status))
              .map((candidate) => candidate.id)
            : [];
          const pauseIds = task?.isDirectory ? childIds : [taskId, ...childIds];
          const pauseResults = await Promise.all(pauseIds.map(async (id) => ({
            id,
            result: await bridge.pauseTransfer?.(id) ?? { success: false, reason: "Pause unavailable" },
          })));
          const afterLivePause = tasks.find((candidate) => candidate.id === taskId);
          if (afterLivePause?.status === "cancelled") return;
          const allBenignOrSuccess = pauseIds.length === 0 || pauseResults.every(
            ({ result }) => result.success || isBenignPauseMiss(result.reason),
          );
          // Only claim paused when EVERY targeted stream paused or is already gone.
          // Mixed success + hard failure must not paint a paused parent over live children.
          if (allBenignOrSuccess) {
            const byId = new Map(pauseResults.map((row) => [row.id, row.result]));
            tasks = tasks.map((candidate) => {
              if (candidate.id === taskId) {
                return {
                  ...candidate,
                  status: "paused" as const,
                  speed: 0,
                  // Directory parents keep file-count transferredBytes.
                  checkpointBytes: task?.isDirectory
                    ? candidate.transferredBytes
                    : (byId.get(taskId)?.checkpointBytes ?? candidate.checkpointBytes),
                  resumeStage: byId.get(taskId)?.resumeStage ?? candidate.resumeStage,
                  downloadCheckpointBytes: byId.get(taskId)?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
                  uploadCheckpointBytes: byId.get(taskId)?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
                  sourceFingerprint: byId.get(taskId)?.sourceFingerprint ?? candidate.sourceFingerprint,
                };
              }
              if (!pauseIds.includes(candidate.id)) return candidate;
              const result = byId.get(candidate.id);
              if (result && !result.success && !isBenignPauseMiss(result.reason)) {
                return { ...candidate, pauseUnavailableReason: result.reason };
              }
              return {
                ...candidate,
                status: "paused" as const,
                speed: 0,
                checkpointBytes: result?.checkpointBytes ?? candidate.checkpointBytes ?? candidate.transferredBytes,
                resumeStage: result?.resumeStage ?? candidate.resumeStage,
                downloadCheckpointBytes: result?.downloadCheckpointBytes ?? candidate.downloadCheckpointBytes,
                uploadCheckpointBytes: result?.uploadCheckpointBytes ?? candidate.uploadCheckpointBytes,
                sourceFingerprint: result?.sourceFingerprint ?? candidate.sourceFingerprint,
              };
            });
            emit();
            return;
          }
          // Partial / hard fail: unpause any streams we successfully paused so
          // the parent can stay transferring without soft-deadlocking children
          // (match panel planPartialPauseRollback path).
          const rollback = planPartialPauseRollback({
            activeIds: pauseIds,
            backendIds: pauseIds,
            bridgeResults: pauseResults.map((row) => row.result),
          });
          for (const id of rollback.bridgeIdsToResume) {
            try { await bridge.resumeTransfer?.(id); } catch { /* best-effort */ }
          }
          const hard = pauseResults.find(({ result }) =>
            result && !result.success && !isBenignPauseMiss(result.reason),
          )?.result;
          if (hard?.reason) {
            tasks = tasks.map((candidate) => candidate.id === taskId ? {
              ...candidate,
              status: "transferring" as const,
              pauseUnavailableReason: hard.reason,
            } : candidate);
            emit();
          }
          // Bridge was reachable — do not demote to interrupted (ghost restart path
          // only applies when pauseTransfer is unavailable).
          return;
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
        const demoteIds = new Set([
          taskId,
          ...tasks.filter((candidate) => candidate.parentTaskId === taskId
            && !["completed", "cancelled"].includes(candidate.status))
            .map((candidate) => candidate.id),
        ]);
        // Stop backends immediately so streams do not finish under a demoted parent.
        for (const id of demoteIds) {
          try { await netcattyBridge.get()?.cancelTransfer?.(id); } catch { /* best-effort */ }
        }
        tasks = tasks.map((candidate) => demoteIds.has(candidate.id) ? {
          ...candidate,
          status: candidate.status === "completed" || candidate.status === "cancelled"
            ? candidate.status
            : "interrupted",
          speed: 0,
          phase: undefined,
          reconnectRequired: true,
          error: candidate.id === taskId
            ? (candidate.error ?? "Transfer was interrupted. Resume to continue.")
            : candidate.error,
        } : candidate);
        emit();
        return;
      }
    }
    // Preferred path after app restart / closed server: open a dedicated SFTP
    // session from vault credentials and continue from the checkpoint. Does not
    // require any UI panel. Single files resume the stream; directories re-walk
    // the tree, skip completed children, and resume partial files.
    if (
      (!controller || needsDedicatedReconnect)
      && action === "resume"
      && task
      && !task.conflict
      && dedicatedResumeHandler
    ) {
      const previousOwnerId = task.ownerId;
      // Detach parent + directory children so publishOwner cannot clobber
      // in-flight dedicated progress with a stale interrupted/paused snapshot.
      tasks = tasks.map((candidate) => {
        if (candidate.id !== taskId && candidate.parentTaskId !== taskId) return candidate;
        if (candidate.id === taskId) {
          return {
            ...candidate,
            ownerId: "dedicated-resume",
            status: "pending" as const,
            error: undefined,
            reconnectRequired: true,
            speed: 0,
            phase: undefined,
            updatedAt: Date.now(),
          };
        }
        // Re-home children (keep completed status for skip-on-resume).
        return {
          ...candidate,
          ownerId: "dedicated-resume",
          updatedAt: Date.now(),
        };
      });
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
        const childIds = tasks
          .filter((candidate) => candidate.parentTaskId === taskId)
          .map((candidate) => candidate.id);
        try { await netcattyBridge.get()?.cancelTransfer?.(taskId); } catch { /* best-effort */ }
        for (const childId of childIds) {
          try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
        }
        const cancelIds = new Set([taskId, ...childIds]);
        tasks = tasks.map((candidate) => cancelIds.has(candidate.id) && candidate.status !== "completed" ? {
          ...candidate,
          status: "cancelled",
          error: undefined,
          endTime: candidate.endTime ?? Date.now(),
          speed: 0,
        } : candidate);
        emit();
        return;
      }
      if (result.success) {
        // Stream / directory finished successfully. Even if the user hit pause
        // during reconnect (status demoted to interrupted), work is done —
        // promote to completed rather than leaving a false interrupted row.
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          ownerId: "dedicated-resume",
          status: "completed",
          transferredBytes: Math.max(
            candidate.transferredBytes,
            candidate.totalBytes || candidate.transferredBytes,
          ),
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
        // Finalize any children still marked transferring after abort wind-down.
        const childIds = tasks
          .filter((candidate) => candidate.parentTaskId === taskId
            && ["transferring", "pausing", "pending", "queued"].includes(candidate.status))
          .map((candidate) => candidate.id);
        if (childIds.length > 0) {
          for (const childId of childIds) {
            try { await netcattyBridge.get()?.cancelTransfer?.(childId); } catch { /* best-effort */ }
          }
          tasks = tasks.map((candidate) => childIds.includes(candidate.id) ? {
            ...candidate,
            status: "interrupted",
            speed: 0,
            reconnectRequired: true,
            phase: undefined,
          } : candidate);
          emit();
        }
        return;
      }
      // Abort throws "Transfer cancelled" when shouldAbort (pause/interrupt).
      // Do not force-cancel a row the user already re-activated (transferring/
      // pending after a quick Resume during wind-down).
      const cancelLike = /cancelled|canceled/i.test(result.error || "");
      if (cancelLike) {
        const liveAfter = tasks.find((candidate) => candidate.id === taskId);
        // Soft-unpause may have painted transferring while the held dedicated
        // walk was already dying. If no invocation remains, demote so Resume works.
        if (
          liveAfter
          && ["transferring", "pending", "queued", "paused", "pausing"].includes(liveAfter.status)
        ) {
          if (!resumeInvocations.has(taskId) && liveAfter.status === "transferring") {
            tasks = tasks.map((candidate) => candidate.id === taskId || candidate.parentTaskId === taskId
              ? {
                ...candidate,
                status: candidate.status === "completed" || candidate.status === "cancelled"
                  ? candidate.status
                  : "interrupted" as const,
                speed: 0,
                reconnectRequired: true,
                phase: undefined,
              }
              : candidate);
            emit();
          }
          return;
        }
        const cancelIds = new Set([
          taskId,
          ...tasks.filter((candidate) => candidate.parentTaskId === taskId).map((c) => c.id),
        ]);
        tasks = tasks.map((candidate) => cancelIds.has(candidate.id) && candidate.status !== "completed" ? {
          ...candidate,
          status: "cancelled",
          error: undefined,
          endTime: candidate.endTime ?? Date.now(),
          speed: 0,
          reconnectRequired: false,
          phase: undefined,
        } : candidate);
        emit();
        return;
      }
      // Source changed / partial directory attention — keep progress, show retry UI.
      if (result.needsAttention) {
        tasks = tasks.map((candidate) => candidate.id === taskId ? {
          ...candidate,
          ownerId: "dedicated-resume",
          status: "attention",
          error: result.error,
          reconnectRequired: false,
          speed: 0,
          phase: undefined,
          retryable: true,
          ...(result.resetCheckpoint
            ? { checkpointBytes: 0, transferredBytes: 0 }
            : null),
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
    upsertTasks(incoming) {
      if (incoming.length === 0) return;
      const byId = new Map(incoming.map((task) => [task.id, task]));
      const seen = new Set<string>();
      const parentTerminal = new Map<string, TransferTask["status"]>();
      for (const task of tasks) {
        if (!task.parentTaskId) parentTerminal.set(task.id, task.status);
      }
      tasks = tasks.map((task) => {
        const replacement = byId.get(task.id);
        if (!replacement) return task;
        seen.add(task.id);
        if (task.status === "cancelled" && replacement.status !== "cancelled") return task;
        return { ...task, ...replacement, updatedAt: Date.now() };
      });
      for (const task of incoming) {
        if (seen.has(task.id)) continue;
        // Do not resurrect work under a cancelled/completed directory parent.
        if (task.parentTaskId) {
          const parentStatus = parentTerminal.get(task.parentTaskId)
            ?? tasks.find((candidate) => candidate.id === task.parentTaskId)?.status;
          if (parentStatus === "cancelled" || parentStatus === "completed") continue;
        }
        tasks.push({ ...task, updatedAt: task.updatedAt ?? Date.now() });
      }
      emit();
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
      const startFresh = () => {
        const running = invoke(taskId, "resume").finally(() => {
          if (resumeInvocations.get(taskId) === running) resumeInvocations.delete(taskId);
        });
        resumeInvocations.set(taskId, running);
        return running;
      };

      const existing = resumeInvocations.get(taskId);
      if (existing) {
        // Dedicated resume holds the invocation for the full stream lifetime.
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (task?.status === "cancelled") return existing;

        // Soft-unpause live backend streams when still paused under a held run.
        // Dedicated *directory* walks treat status===paused as shouldAbort between
        // files, so soft-rejoin is unsafe (dying promise + false transferring).
        // Wind down soft-paused children then startFresh from checkpoints.
        // Single-file dedicated (and non-directory live streams) soft-unpause.
        if (task && (task.status === "paused" || task.status === "pausing")) {
          const childIds = tasks
            .filter((candidate) => candidate.parentTaskId === taskId
              && (candidate.status === "paused"
                || candidate.status === "pausing"
                || candidate.status === "transferring"))
            .map((candidate) => candidate.id);

          if (task.ownerId === "dedicated-resume" && task.isDirectory) {
            const bridge = netcattyBridge.get();
            // Cancel soft-paused child streams so the held walk settles. When a
            // child is not in activeTransfers, cancelTransfer leaves a sticky
            // pendingCancel latch — clear it before startFresh reuses the same
            // child transferIds (otherwise startStreamTransfer aborts immediately).
            for (const id of childIds) {
              try { await bridge?.cancelTransfer?.(id); } catch { /* best-effort wind-down */ }
              try { await bridge?.clearPendingTransferCancel?.(id); } catch { /* best-effort */ }
            }
            try { await bridge?.clearPendingTransferCancel?.(taskId); } catch { /* best-effort */ }
            try {
              await existing;
            } catch { /* previous aborted / cancelled */ }
            // Clear again after wind-down in case cancel raced during await.
            for (const id of childIds) {
              try { await bridge?.clearPendingTransferCancel?.(id); } catch { /* best-effort */ }
            }
            try { await bridge?.clearPendingTransferCancel?.(taskId); } catch { /* best-effort */ }
            return resumeInvocations.get(taskId) ?? startFresh();
          }

          try {
            const resumeIds = [taskId, ...childIds.filter((id) => id !== taskId)];
            const results = await Promise.all(resumeIds.map(async (id) =>
              netcattyBridge.get()?.resumeTransfer?.(id) ?? { success: false },
            ));
            const after = tasks.find((candidate) => candidate.id === taskId);
            if (after?.status === "cancelled") return existing;
            // Only rejoin when at least one backend stream actually resumed.
            // Empty/all-fail must not paint transferring over a dead held run.
            const successIds = resumeIds.filter((_, index) => results[index]?.success);
            if (successIds.length > 0) {
              const resumed = new Set(successIds);
              tasks = tasks.map((candidate) => {
                if (candidate.id === taskId || resumed.has(candidate.id)) {
                  return {
                    ...candidate,
                    status: "transferring" as const,
                    error: undefined,
                    reconnectRequired: false,
                    pauseUnavailableReason: undefined,
                    phase: undefined,
                  };
                }
                return candidate;
              });
              emit();
              return existing;
            }
          } catch {
            // Fall through to await + restart.
          }
          try {
            await existing;
          } catch { /* previous aborted */ }
          return resumeInvocations.get(taskId) ?? startFresh();
        }

        // After demotion to interrupted/attention/failed while work unwinds:
        // wait then re-invoke (do not rejoin a dying canceling promise).
        if (task && (task.status === "interrupted" || task.status === "attention" || task.status === "failed")) {
          try {
            await existing;
          } catch { /* previous aborted */ }
          return resumeInvocations.get(taskId) ?? startFresh();
        }
        return existing;
      }
      return startFresh();
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
