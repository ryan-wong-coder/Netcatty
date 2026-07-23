import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "../domain/models";
import {
  getGlobalTransferBadge,
  getGlobalTransferBucket,
  splitBackgroundTransfers,
} from "./GlobalSftpTransferCenter";

const task = (id: string, status: TransferTask["status"], background = false) => ({
  id,
  fileName: id,
  sourcePath: "/a",
  targetPath: "/b",
  sourceConnectionId: "local",
  targetConnectionId: "remote",
  direction: "upload" as const,
  status,
  totalBytes: 10,
  transferredBytes: 1,
  speed: 1,
  startTime: 1,
  isDirectory: false,
  background,
});

test("global transfer statuses map to the five user-facing buckets", () => {
  assert.equal(getGlobalTransferBucket(task("a", "transferring")), "active");
  assert.equal(getGlobalTransferBucket(task("a", "pausing")), "active");
  assert.equal(getGlobalTransferBucket(task("a", "queued")), "queued");
  assert.equal(getGlobalTransferBucket(task("a", "paused")), "paused");
  assert.equal(getGlobalTransferBucket(task("a", "interrupted")), "paused");
  assert.equal(getGlobalTransferBucket(task("a", "attention")), "paused");
  assert.equal(getGlobalTransferBucket(task("a", "failed")), "failed");
  assert.equal(getGlobalTransferBucket(task("a", "completed")), "completed");
  assert.equal(getGlobalTransferBucket(task("a", "cancelled")), "completed");
});

test("badge counts active and queued work while surfacing attention", () => {
  assert.deepEqual(getGlobalTransferBadge([
    task("a", "transferring"),
    task("b", "queued"),
    task("c", "failed"),
  ]), { count: 2, hasAttention: true });
});

test("badge does not double count child files in a folder transfer", () => {
  assert.deepEqual(getGlobalTransferBadge([
    task("parent", "transferring"),
    { ...task("child", "transferring"), parentTaskId: "parent" },
  ]), { count: 1, hasAttention: false });
});

test("successful background work is collapsed but failures stay visible", () => {
  const split = splitBackgroundTransfers([
    task("a", "completed", true),
    task("b", "failed", true),
    task("c", "completed", false),
  ]);
  assert.deepEqual(split.visible.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(split.collapsed.map((item) => item.id), ["a"]);
});
