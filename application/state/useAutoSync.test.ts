import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("auto-sync establishes the initial data baseline before debouncing edits", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const baselineCommentIndex = source.indexOf("Establish the initial baseline immediately");
  const baselineHelperIndex = source.indexOf("const establishInitialBaseline = () =>", baselineCommentIndex);
  const initializedAssignmentIndex = source.indexOf("isInitializedRef.current = true;", baselineHelperIndex);
  const hashReadIndex = source.indexOf("const currentHash = await getDataHash();", baselineHelperIndex);
  const initializationGuardIndex = source.indexOf("if (!isInitializedRef.current)", baselineCommentIndex);
  const baselineCallIndex = source.indexOf("establishInitialBaseline();", initializationGuardIndex);
  const debounceCommentIndex = source.indexOf("Debounce first, then build the expensive full-data hash", initializationGuardIndex);
  const debounceTimerIndex = source.indexOf("syncTimeoutRef.current = setTimeout", debounceCommentIndex);

  assert.notEqual(baselineCommentIndex, -1);
  assert.notEqual(baselineHelperIndex, -1);
  assert.notEqual(initializationGuardIndex, -1);
  assert.notEqual(initializedAssignmentIndex, -1);
  assert.notEqual(hashReadIndex, -1);
  assert.notEqual(baselineCallIndex, -1);
  assert.notEqual(debounceCommentIndex, -1);
  assert.notEqual(debounceTimerIndex, -1);
  assert.ok(
    initializedAssignmentIndex < hashReadIndex,
    "initialization must be marked synchronously before reading the baseline hash",
  );
  assert.ok(
    baselineCallIndex < debounceTimerIndex,
    "the first baseline hash must be captured before scheduling the debounced auto-sync timer",
  );
});

test("paused convergent sync captures a baseline before returning", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const effectIndex = source.indexOf("// Debounced auto-sync when data changes");
  const pausedGuardIndex = source.indexOf("if (convergentSyncPaused)", effectIndex);
  const initializationGuardIndex = source.indexOf("if (!isInitializedRef.current)", pausedGuardIndex);
  const baselineCallIndex = source.indexOf("establishInitialBaseline();", initializationGuardIndex);
  const pausedReturnIndex = source.indexOf("return () =>", baselineCallIndex);

  assert.notEqual(pausedGuardIndex, -1);
  assert.notEqual(initializationGuardIndex, -1);
  assert.notEqual(baselineCallIndex, -1);
  assert.notEqual(pausedReturnIndex, -1);
  assert.ok(
    pausedGuardIndex < initializationGuardIndex
      && initializationGuardIndex < baselineCallIndex
      && baselineCallIndex < pausedReturnIndex,
    "paused mode must preserve the pre-edit baseline before suppressing network sync",
  );
});

test("an unchanged remote check cannot absorb an existing paused-edit baseline", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const baselineSnapshotIndex = source.indexOf("const hadInitialBaseline = isInitializedRef.current");
  const remoteChangeIndex = source.indexOf("inspectedRemoteChange = true", baselineSnapshotIndex);
  const guardedUpdateIndex = source.indexOf(
    "if (markCurrentDataSynced && (!hadInitialBaseline || inspectedRemoteChange))",
    remoteChangeIndex,
  );

  assert.notEqual(baselineSnapshotIndex, -1);
  assert.notEqual(remoteChangeIndex, -1);
  assert.notEqual(guardedUpdateIndex, -1);
  assert.ok(
    baselineSnapshotIndex < remoteChangeIndex && remoteChangeIndex < guardedUpdateIndex,
    "remote inspection must preserve an existing baseline unless it reconciled changed cloud data",
  );
});

test("enabled convergent remote checks use the CRDT runtime before legacy inspection", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const checkIndex = source.indexOf("const checkRemoteVersion = useCallback");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
    checkIndex,
  );
  const convergentSyncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    convergentGuardIndex,
  );
  const legacyInspectionIndex = source.indexOf(
    "manager.inspectProviderRemote(connectedProvider)",
    convergentSyncIndex,
  );

  assert.notEqual(checkIndex, -1);
  assert.notEqual(convergentGuardIndex, -1);
  assert.notEqual(convergentSyncIndex, -1);
  assert.notEqual(legacyInspectionIndex, -1);
  assert.ok(
    convergentGuardIndex < convergentSyncIndex && convergentSyncIndex < legacyInspectionIndex,
    "v2 checks must return through the CRDT runtime before the legacy snapshot inspector",
  );
});

test("enabled convergent startup checks preview empty-vault recovery before syncing", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
  );
  const previewIndex = source.indexOf("manager.previewConvergentRecovery()", convergentGuardIndex);
  const recoveryPromptIndex = source.indexOf(
    "requestEmptyVaultRecovery(recoveryPayload)",
    previewIndex,
  );
  const cloudWinsIndex = source.indexOf(
    "conflictActionOverride: 'download-remote'",
    recoveryPromptIndex,
  );
  const normalSyncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    cloudWinsIndex,
  );

  assert.notEqual(convergentGuardIndex, -1);
  assert.notEqual(previewIndex, -1);
  assert.notEqual(recoveryPromptIndex, -1);
  assert.notEqual(cloudWinsIndex, -1);
  assert.notEqual(normalSyncIndex, -1);
  assert.ok(
    convergentGuardIndex < previewIndex
      && previewIndex < recoveryPromptIndex
      && recoveryPromptIndex < cloudWinsIndex
      && cloudWinsIndex < normalSyncIndex,
    "v2 startup must offer recovery and use cloud-wins before the normal CRDT sync path",
  );
});

test("empty v2 startup checks allow a validated empty sync to open the gate", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
  );
  const replicaIndex = source.indexOf("manager.loadConvergentReplica()", convergentGuardIndex);
  const emptyDecisionIndex = source.indexOf("allowEmptyConvergentSync = (", replicaIndex);
  const syncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    emptyDecisionIndex,
  );
  const guardIndex = source.indexOf(
    "options?.allowEmptyConvergentSync !== true",
    source.indexOf("const syncNow = useCallback"),
  );

  assert.notEqual(replicaIndex, -1);
  assert.notEqual(emptyDecisionIndex, -1);
  assert.notEqual(syncIndex, -1);
  assert.notEqual(guardIndex, -1);
  assert.ok(replicaIndex < emptyDecisionIndex && emptyDecisionIndex < syncIndex);
});

test("auto-sync skips only the exact remote-applied data hash", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const helperIndex = source.indexOf("const getSyncPayloadDataHash = (payload: SyncPayload): string");
  const skipRefIndex = source.indexOf("const skipNextSyncHashRef = useRef<string | null>(null)");
  const assignmentIndex = source.indexOf("skipNextSyncHashRef.current = getSyncPayloadDataHash(remotePayload)");
  const debounceTimerIndex = source.indexOf("syncTimeoutRef.current = setTimeout", assignmentIndex);
  const skipHashIndex = source.indexOf("const skipHash = skipNextSyncHashRef.current", debounceTimerIndex);
  const decisionIndex = source.indexOf("resolveAutoSyncHashDecision({", skipHashIndex);
  const appliedSkipIndex = source.indexOf("appliedSkipHash: skipHash", decisionIndex);
  const syncingGuardIndex = source.indexOf("if (sync.isSyncing || isSyncRunningRef.current)", decisionIndex);
  const restoreGuardIndex = source.indexOf("if (isRestoreInProgress())", decisionIndex);
  const interruptedGuardIndex = source.indexOf("if (readInterruptedVaultApply())", decisionIndex);
  const syncNowIndex = source.indexOf("const didSync = await syncNow();", interruptedGuardIndex);
  const didSyncGuardIndex = source.indexOf("if (didSync && skipHash !== null", syncNowIndex);
  const clearAfterSyncIndex = source.indexOf("skipNextSyncHashRef.current = null;", didSyncGuardIndex);
  const booleanSkipIndex = source.indexOf("skipNextSyncRef");

  assert.notEqual(helperIndex, -1);
  assert.notEqual(skipRefIndex, -1);
  assert.notEqual(assignmentIndex, -1);
  assert.notEqual(debounceTimerIndex, -1);
  assert.notEqual(skipHashIndex, -1);
  assert.notEqual(decisionIndex, -1);
  assert.notEqual(appliedSkipIndex, -1);
  assert.notEqual(syncingGuardIndex, -1);
  assert.notEqual(restoreGuardIndex, -1);
  assert.notEqual(interruptedGuardIndex, -1);
  assert.notEqual(syncNowIndex, -1);
  assert.notEqual(didSyncGuardIndex, -1);
  assert.notEqual(clearAfterSyncIndex, -1);
  assert.equal(booleanSkipIndex, -1);
  assert.ok(
    skipHashIndex < decisionIndex,
    "remote-apply skip must pass through the hash decision helper before suppressing a sync",
  );
  assert.ok(
    interruptedGuardIndex < syncNowIndex && syncNowIndex < clearAfterSyncIndex,
    "remote-apply skip hash must survive temporary sync blockers and clear only after a successful sync",
  );
});
