import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "./models";
import {
  createSftpTransferCenter,
  deserializeSftpTransferCenter,
  pruneSftpTransferHistory,
  validateTransferResumeSource,
} from "./sftpTransferCenter";

const task = (id: string, status: TransferTask["status"], startTime: number): TransferTask => ({
  id,
  fileName: `${id}.bin`,
  sourcePath: `/source/${id}.bin`,
  targetPath: `/target/${id}.bin`,
  sourceConnectionId: "local",
  targetConnectionId: "remote-1",
  targetHostId: "host-1",
  direction: "upload",
  status,
  totalBytes: 100,
  transferredBytes: status === "completed" ? 100 : 25,
  speed: 0,
  startTime,
  isDirectory: false,
  origin: "manual",
  resumable: true,
});

test("global transfer center queues fairly and promotes a task to the front", () => {
  const center = createSftpTransferCenter({ concurrency: 2 });
  center.add("panel-a", [task("a", "queued", 1), task("b", "queued", 2)]);
  center.add("panel-b", [task("c", "queued", 3)]);

  assert.deepEqual(center.takeRunnable().map((item) => item.id), ["a", "c"]);
  center.prioritize("b");
  center.complete("a");

  assert.deepEqual(center.takeRunnable().map((item) => item.id), ["b"]);
});

test("pause and resume preserve the transfer checkpoint", () => {
  const center = createSftpTransferCenter({ concurrency: 1 });
  center.add("panel-a", [task("a", "transferring", 1)]);
  center.update("a", { transferredBytes: 48, checkpointBytes: 48 });
  center.pause("a");

  assert.equal(center.getTask("a")?.status, "paused");
  assert.equal(center.getTask("a")?.transferredBytes, 48);
  assert.equal(center.getTask("a")?.checkpointBytes, 48);

  center.resume("a");
  assert.equal(center.getTask("a")?.status, "queued");
  assert.equal(center.getTask("a")?.checkpointBytes, 48);
});

test("restoring persisted state interrupts unfinished work and ignores secrets", () => {
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{
      ...task("a", "transferring", 1),
      phase: "transferring",
      password: "must-not-survive",
      privateKey: "must-not-survive",
    }],
  }));

  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.tasks[0]?.reconnectRequired, true);
  assert.equal(restored.tasks[0]?.phase, undefined);
  assert.equal("password" in (restored.tasks[0] ?? {}), false);
  assert.equal("privateKey" in (restored.tasks[0] ?? {}), false);
});

test("restoring a paused task also marks it interrupted after restart", () => {
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{
      ...task("paused", "paused", 1),
      phase: "transferring",
      checkpointBytes: 40,
    }],
  }));

  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.tasks[0]?.reconnectRequired, true);
  assert.equal(restored.tasks[0]?.phase, undefined);
  assert.equal(restored.tasks[0]?.checkpointBytes, 40);
});

test("history keeps unfinished tasks and caps terminal tasks by age and count", () => {
  const now = Date.UTC(2026, 6, 23);
  const old = now - 31 * 24 * 60 * 60 * 1000;
  const recent = now - 1000;
  const tasks = [
    task("paused", "paused", old),
    task("old", "completed", old),
    ...Array.from({ length: 205 }, (_, index) => task(`done-${index}`, "completed", recent + index)),
  ];

  const pruned = pruneSftpTransferHistory(tasks, now);
  assert.equal(pruned.some((item) => item.id === "paused"), true);
  assert.equal(pruned.some((item) => item.id === "old"), false);
  assert.equal(pruned.filter((item) => item.status === "completed").length, 200);
});

test("resume rejects changed or shortened source files", () => {
  const resumable = {
    ...task("a", "interrupted", 1),
    totalBytes: 100,
    sourceLastModified: 50,
    checkpointBytes: 60,
  };
  assert.equal(validateTransferResumeSource(resumable, { size: 100, lastModified: 50 }), null);
  assert.match(validateTransferResumeSource(resumable, { size: 90, lastModified: 50 }) ?? "", /size changed/);
  assert.match(validateTransferResumeSource(resumable, { size: 100, lastModified: 51 }) ?? "", /modified/);
  assert.match(validateTransferResumeSource(resumable, { size: 40, lastModified: 50 }) ?? "", /checkpoint/);
});

test("prune keeps completed children of unfinished directory parents", () => {
  const now = Date.now();
  const parent: TransferTask = {
    ...task("dir", "interrupted", now - 1000),
    isDirectory: true,
    fileName: "folder",
  };
  const children = Array.from({ length: 5 }, (_, i) => ({
    ...task(`child-${i}`, "completed", now - 500 + i),
    parentTaskId: "dir",
    endTime: now - 400,
  }));
  // Add many other terminal tasks that would push children out of the cap.
  const noise = Array.from({ length: 220 }, (_, i) => ({
    ...task(`old-${i}`, "completed", now - 10_000 + i),
    endTime: now - 1000 + i,
  }));
  const pruned = pruneSftpTransferHistory([parent, ...children, ...noise], now);
  assert.ok(pruned.some((item) => item.id === "dir"));
  for (const child of children) {
    assert.ok(
      pruned.some((item) => item.id === child.id),
      `expected checkpoint child ${child.id} to survive prune`,
    );
  }
});
