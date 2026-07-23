import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createGlobalSftpTransferScheduler } from "./globalTransferScheduler.ts";
import {
  allPauseResultsBenignOrSuccess,
  isBenignPauseMiss,
  isHardPauseFailure,
  planPartialPauseRollback,
  resolveDirectoryPauseParentOutcome,
  shouldLatchPauseWaiters,
} from "./pauseTransferOutcome.ts";

test("benign pause misses match store regex (no longer active / not found / session)", () => {
  assert.equal(isBenignPauseMiss("Transfer is no longer active"), true);
  assert.equal(isBenignPauseMiss("session not found"), true);
  assert.equal(isBenignPauseMiss("SFTP session closed"), true);
  assert.equal(isBenignPauseMiss("This transfer cannot be paused safely"), false);
  assert.equal(isBenignPauseMiss("Pause unavailable"), false);
});

test("allPauseResultsBenignOrSuccess rejects mixed hard failures", () => {
  assert.equal(allPauseResultsBenignOrSuccess([
    { success: true },
    { success: false, reason: "no longer active" },
  ]), true);
  assert.equal(allPauseResultsBenignOrSuccess([
    { success: true },
    { success: false, reason: "cannot be paused safely" },
  ]), false);
  assert.equal(allPauseResultsBenignOrSuccess([]), true);
});

test("directory parent stays transferring when any child hard-fails pause", () => {
  assert.deepEqual(
    resolveDirectoryPauseParentOutcome([
      { success: true },
      { success: false, reason: "cannot be paused safely" },
    ]),
    { kind: "still_transferring", reason: "cannot be paused safely" },
  );
  assert.deepEqual(
    resolveDirectoryPauseParentOutcome([
      { success: false, reason: "no longer active" },
      { success: true },
    ]),
    { kind: "paused" },
  );
});

test("pause waiters latch only on successful pause", () => {
  assert.equal(shouldLatchPauseWaiters({ pauseSucceeded: true }), true);
  assert.equal(shouldLatchPauseWaiters({ pauseSucceeded: false }), false);
});

test("isHardPauseFailure treats missing result as hard", () => {
  assert.equal(isHardPauseFailure(undefined), true);
  assert.equal(isHardPauseFailure({ success: false, reason: "no longer active" }), false);
  assert.equal(isHardPauseFailure({ success: true }), false);
});

test("planPartialPauseRollback unparks scheduler jobs and successful bridge pauses", () => {
  // active: parent + 3 children. scheduler.pause succeeded for child-a (not in backendIds).
  // bridge: child-b success, child-c hard fail, parent not in directory activeIds.
  const plan = planPartialPauseRollback({
    activeIds: ["child-a", "child-b", "child-c"],
    backendIds: ["child-b", "child-c"],
    bridgeResults: [
      { success: true },
      { success: false, reason: "cannot be paused safely" },
    ],
  });
  assert.deepEqual(plan.schedulerIdsToResume, ["child-a"]);
  assert.deepEqual(plan.bridgeIdsToResume, ["child-b"]);
});

test("planPartialPauseRollback for single-file includes parent when only children hit bridge", () => {
  // Single-file: activeIds = [parent, child]; scheduler parked parent, bridge paused child then hard-fails parent.
  const plan = planPartialPauseRollback({
    activeIds: ["parent", "child"],
    backendIds: ["parent", "child"],
    bridgeResults: [
      { success: false, reason: "cannot be paused safely" },
      { success: true },
    ],
  });
  assert.deepEqual(plan.schedulerIdsToResume, []);
  assert.deepEqual(plan.bridgeIdsToResume, ["child"]);
});

test("mixed hard-fail rollback resumes real scheduler-parked jobs so work continues", async () => {
  const scheduler = createGlobalSftpTransferScheduler();
  let childAFinished = false;
  const hold = { release: null as null | (() => void) };
  const block = new Promise<void>((resolve) => {
    hold.release = resolve;
  });

  // Concurrency 1: hold the only slot so child-a stays queued and can be pause()'d.
  const holder = scheduler.run("owner", "holder", ["host-1"], () => 1, async () => {
    await block;
  });
  const childA = scheduler.run("owner", "child-a", ["host-1"], () => 1, async () => {
    childAFinished = true;
  });

  // Allow holder to become active and child-a to queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scheduler.pause("child-a"), true, "child-a must be queued so pause parks it");

  // Mimic panel path: activeIds include scheduler-parked + bridge targets; bridge hard-fails one.
  const plan = planPartialPauseRollback({
    activeIds: ["child-a", "child-b"],
    backendIds: ["child-b"],
    bridgeResults: [{ success: false, reason: "cannot be paused safely" }],
  });
  assert.deepEqual(plan.schedulerIdsToResume, ["child-a"]);

  for (const id of plan.schedulerIdsToResume) {
    assert.equal(scheduler.resume(id), true);
  }
  hold.release?.();
  await holder;
  await childA;
  assert.equal(childAFinished, true, "parked child-a must run after rollback resume");
});

test("useSftpTransfers pauseTransfer rolls back partial pause via planPartialPauseRollback", () => {
  const source = readFileSync(new URL("./useSftpTransfers.ts", import.meta.url), "utf8");
  assert.match(source, /planPartialPauseRollback/);
  assert.match(source, /rollbackPartialPause/);
  assert.match(source, /schedulerIdsToResume/);
  assert.match(source, /bridgeIdsToResume/);
  // Must not latch before knowing success.
  assert.match(source, /Latch workers only after a real pause succeeds/);
  // On hard fail must resume scheduler + bridge before failPause.
  assert.match(source, /await rollbackPartialPause\(\)/);
});
