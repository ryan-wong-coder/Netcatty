import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "../../domain/models";
import { createSftpTransferCenterStore } from "./sftpTransferCenterStore";

const makeTask = (id: string, status: TransferTask["status"] = "transferring"): TransferTask => ({
  id,
  fileName: `${id}.txt`,
  sourcePath: `/source/${id}.txt`,
  targetPath: `/target/${id}.txt`,
  sourceConnectionId: "local",
  targetConnectionId: `remote-${id}`,
  direction: "upload",
  status,
  totalBytes: 10,
  transferredBytes: 2,
  speed: 1,
  startTime: 1,
  isDirectory: false,
  resumable: true,
});

test("store aggregates owner snapshots without duplicating tasks", () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("panel-a", [makeTask("a")]);
  store.publishOwner("panel-b", [makeTask("b")]);
  store.publishOwner("panel-a", [{ ...makeTask("a"), transferredBytes: 5 }]);

  assert.deepEqual(store.getSnapshot().tasks.map((task) => [task.id, task.transferredBytes]), [
    ["a", 5],
    ["b", 2],
  ]);
});

test("store routes controls to the task owner", async () => {
  const calls: string[] = [];
  const store = createSftpTransferCenterStore();
  store.registerOwner("panel-a", {
    pause: async (id) => { calls.push(`pause:${id}`); },
    resume: async (id) => { calls.push(`resume:${id}`); },
    cancel: async (id) => { calls.push(`cancel:${id}`); },
    retry: async (id) => { calls.push(`retry:${id}`); },
    prioritize: async (id) => { calls.push(`prioritize:${id}`); },
    dismiss: (id) => calls.push(`dismiss:${id}`),
  });
  store.publishOwner("panel-a", [makeTask("a")]);

  await store.pause("a");
  await store.resume("a");
  await store.cancel("a");
  await store.retry("a");
  await store.prioritize("a");
  store.dismiss("a");

  assert.deepEqual(calls, [
    "pause:a",
    "resume:a",
    "cancel:a",
    "retry:a",
    "prioritize:a",
    "dismiss:a",
  ]);
});

test("persisted unfinished tasks restore as interrupted without controllers", () => {
  let persisted = "";
  const first = createSftpTransferCenterStore({
    read: () => null,
    write: (value) => { persisted = value; },
  });
  first.publishOwner("panel-a", [makeTask("a")]);

  const restored = createSftpTransferCenterStore({
    read: () => persisted,
    write: () => {},
  });
  assert.equal(restored.getSnapshot().tasks[0]?.status, "interrupted");
  assert.equal(restored.getSnapshot().tasks[0]?.ownerId, "panel-a");
  assert.equal(restored.canControl("a"), true);
});

test("snapshot counts only parent tasks and clearing completed history preserves failures", () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("panel-a", [
    makeTask("parent"),
    { ...makeTask("child"), parentTaskId: "parent" },
    makeTask("done", "completed"),
    makeTask("failed", "failed"),
  ]);

  assert.equal(store.getSnapshot().activeCount, 1);
  store.clearTerminal("completed");
  assert.deepEqual(store.getSnapshot().tasks.map((task) => task.id), ["parent", "child", "failed"]);
});

test("background agent transfers are recorded and retained in history", () => {
  const store = createSftpTransferCenterStore();
  const now = Date.now();
  store.ingestBackgroundEvent({
    type: "started",
    transferId: "agent-transfer",
    direction: "upload",
    sourcePath: "/local/report.txt",
    targetPath: "/remote/report.txt",
    startedAt: now - 10,
  });
  assert.equal(store.getSnapshot().tasks[0]?.background, true);
  assert.equal(store.getSnapshot().tasks[0]?.origin, "agent");

  store.ingestBackgroundEvent({ type: "completed", transferId: "agent-transfer", endedAt: now });
  assert.equal(store.getSnapshot().tasks[0]?.status, "completed");
  assert.equal(store.getSnapshot().tasks[0]?.endTime, now);
});

test("clearing terminal history asks each owner to clean transfer artifacts", () => {
  const dismissed: string[] = [];
  const store = createSftpTransferCenterStore();
  store.registerOwner("panel-a", {
    pause: async () => {}, resume: async () => {}, cancel: async () => {}, retry: async () => {}, prioritize: async () => {},
    dismiss: (id) => { dismissed.push(id); },
  });
  store.publishOwner("panel-a", [makeTask("done", "completed"), makeTask("failed", "failed")]);

  store.clearTerminal("completed");

  assert.deepEqual(dismissed, ["done"]);
  assert.deepEqual(store.getSnapshot().tasks.map((task) => task.id), ["failed"]);
});
