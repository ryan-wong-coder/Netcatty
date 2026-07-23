/**
 * Shared pause-result classification for panel + global transfer center.
 * Keep panel and store pause UX consistent.
 */

export type PauseBridgeResult = {
  success: boolean;
  reason?: string;
  checkpointBytes?: number;
  resumeStage?: string;
  downloadCheckpointBytes?: number;
  uploadCheckpointBytes?: number;
  sourceFingerprint?: string;
};

/** Backend miss that means "nothing to pause" — not a hard failure. */
export function isBenignPauseMiss(reason?: string): boolean {
  return /no longer active|not found|session/i.test(reason || "");
}

export function isHardPauseFailure(result: PauseBridgeResult | undefined): boolean {
  if (!result) return true;
  if (result.success) return false;
  return !isBenignPauseMiss(result.reason);
}

/**
 * Whether a multi-id pause (directory children or single+children) fully
 * succeeded: every targeted id paused or was already gone.
 */
export function allPauseResultsBenignOrSuccess(
  results: readonly PauseBridgeResult[],
): boolean {
  if (results.length === 0) return true;
  return results.every((result) => result.success || isBenignPauseMiss(result.reason));
}

export type DirectoryPauseParentOutcome =
  | { kind: "paused" }
  | { kind: "still_transferring"; reason?: string };

/**
 * Parent directory pause UI outcome after per-child bridge pause results.
 * Matches store semantics: never paint paused over hard child pause failures.
 */
export function resolveDirectoryPauseParentOutcome(
  results: readonly PauseBridgeResult[],
): DirectoryPauseParentOutcome {
  if (allPauseResultsBenignOrSuccess(results)) {
    return { kind: "paused" };
  }
  const hard = results.find((result) => isHardPauseFailure(result));
  return { kind: "still_transferring", reason: hard?.reason };
}

/**
 * Whether pauseTransfer should latch waiters (pausedTasksRef).
 * Only latch on true pause success so workers do not soft-deadlock.
 */
export function shouldLatchPauseWaiters(params: {
  pauseSucceeded: boolean;
}): boolean {
  return params.pauseSucceeded;
}

/**
 * After a multi-id pause attempt fails overall, which ids must be unpaused so
 * work can continue (scheduler jobs + successfully bridge-paused streams).
 *
 * `activeIds` — every id we attempted to pause
 * `backendIds` — ids sent to the bridge (scheduler.pause returned false)
 * `bridgeResults` — bridge pause outcomes for backendIds (same order)
 */
export function planPartialPauseRollback(params: {
  activeIds: readonly string[];
  backendIds: readonly string[];
  bridgeResults: readonly PauseBridgeResult[];
}): {
  schedulerIdsToResume: string[];
  bridgeIdsToResume: string[];
} {
  const backendSet = new Set(params.backendIds);
  const schedulerIdsToResume = params.activeIds.filter((id) => !backendSet.has(id));
  const bridgeIdsToResume: string[] = [];
  for (let i = 0; i < params.backendIds.length; i += 1) {
    const result = params.bridgeResults[i];
    if (result?.success) {
      bridgeIdsToResume.push(params.backendIds[i]!);
    }
  }
  return { schedulerIdsToResume, bridgeIdsToResume };
}
