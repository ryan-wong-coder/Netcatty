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

test("resume without an owner uses a live backend transfer session when available", async (t) => {
  const resumeCalls: string[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        resumeTransfer: async (id: string) => {
          resumeCalls.push(id);
          return { success: true };
        },
      },
    },
  });

  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("orphaned-paused", "paused"),
    direction: "download",
    sourceHostId: "host-a",
    sourceConnectionId: "remote-conn",
    targetConnectionId: "local",
  }]);

  await store.resume("orphaned-paused");

  assert.deepEqual(resumeCalls, ["orphaned-paused"]);
  assert.equal(store.getSnapshot().tasks[0]?.status, "transferring");
  assert.equal(store.getSnapshot().tasks[0]?.error, undefined);
});

test("resume still uses the live owner when canAdopt is false", async () => {
  // Downloads often have only the remote pane open, so canAdopt (which wants
  // both endpoints) returns false. Pause/resume must still unpause the live
  // backend transfer through the owning panel instead of failing with
  // "server no longer exists".
  const calls: string[] = [];
  const store = createSftpTransferCenterStore();
  store.registerOwner("panel-a", {
    pause: async (id) => { calls.push(`pause:${id}`); },
    resume: async (id) => { calls.push(`resume:${id}`); },
    cancel: async () => {},
    retry: async () => {},
    prioritize: async () => {},
    dismiss: () => {},
    canAdopt: () => false,
    canPrepareAdoption: true,
  });
  store.publishOwner("panel-a", [{
    ...makeTask("download-paused", "paused"),
    direction: "download",
    sourceHostId: "host-a",
    sourceConnectionId: "remote-conn",
    targetConnectionId: "local",
  }]);

  await store.resume("download-paused");

  assert.deepEqual(calls, ["resume:download-paused"]);
  assert.equal(store.getSnapshot().tasks[0]?.status, "paused");
  assert.equal(store.getSnapshot().tasks[0]?.error, undefined);
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

test("orphaned unfinished tasks stay controllable so dead rows can be cancelled", () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("gone-panel", [
    makeTask("dead-transferring", "transferring"),
    makeTask("dead-paused", "paused"),
  ]);
  // No owner controller registered — simulates app restart.
  assert.equal(store.canControl("dead-transferring"), true);
  assert.equal(store.canControl("dead-paused"), true);
});

test("pause on an orphaned transferring task demotes it to interrupted", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("gone-panel", [makeTask("stuck", "transferring")]);

  await store.pause("stuck");

  assert.equal(store.getSnapshot().tasks[0]?.status, "interrupted");
  assert.equal(store.getSnapshot().tasks[0]?.reconnectRequired, true);
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

test("failed reauthentication leaves a paused transfer requiring attention with the failure reason", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent(event: CustomEvent<{ reportFailure?: (error: string) => void }>) {
        event.detail.reportFailure?.("Authentication failed");
        return true;
      },
    },
  });

  const store = createSftpTransferCenterStore();
  // Original panel is gone — resume must open/authenticate a new one.
  // A preparer is present but adoption never becomes ready because auth fails.
  store.registerOwner("visible-preparer", {
    pause: async () => {}, resume: async () => {}, cancel: async () => {}, retry: async () => {}, prioritize: async () => {},
    dismiss: () => {},
    canAdopt: () => false,
    canPrepareAdoption: true,
    adopt: async () => {},
  });
  store.publishOwner("closed-panel", [{
    ...makeTask("paused", "paused"),
    sourceConnectionId: "closed",
    sourceHostId: "host-a",
  }]);

  await store.resume("paused");

  assert.equal(store.getSnapshot().tasks[0]?.status, "attention");
  assert.equal(store.getSnapshot().tasks[0]?.error, "Authentication failed");
});

test("background events do not resurrect a cancelled agent transfer", () => {
  const store = createSftpTransferCenterStore();
  store.ingestBackgroundEvent({
    type: "queued",
    transferId: "agent-1",
    direction: "download",
    sourcePath: "/r/a",
    targetPath: "/l/a",
    startedAt: Date.now(),
  });
  store.ingestBackgroundEvent({ type: "cancelled", transferId: "agent-1", endedAt: Date.now() });
  assert.equal(store.getSnapshot().tasks[0]?.status, "cancelled");

  store.ingestBackgroundEvent({ type: "started", transferId: "agent-1" });
  store.ingestBackgroundEvent({ type: "progress", transferId: "agent-1", transferred: 50, totalBytes: 100, speed: 1 });
  store.ingestBackgroundEvent({ type: "completed", transferId: "agent-1", endedAt: Date.now() });

  assert.equal(store.getSnapshot().tasks[0]?.status, "cancelled");
});

test("orphaned resume prefers a dedicated SFTP session without a panel owner", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("dedicated", "interrupted"),
    direction: "download",
    sourceHostId: "host-a",
    sourceHostLabel: "CI-Build-01",
    targetConnectionId: "local",
    checkpointBytes: 100,
    reconnectRequired: true,
  }]);

  let sawTaskId = "";
  store.setDedicatedResumeHandler(async (task) => {
    sawTaskId = task.id;
    store.patchTask(task.id, {
      status: "transferring",
      transferredBytes: 100,
      speed: 10,
    });
    return { success: true };
  });

  await store.resume("dedicated");

  assert.equal(sawTaskId, "dedicated");
  assert.equal(store.getSnapshot().tasks[0]?.status, "completed");
  assert.equal(store.getSnapshot().tasks[0]?.reconnectRequired, false);
});

test("directory resume uses dedicated handler and rehomes children", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [
    {
      ...makeTask("dir-parent", "interrupted"),
      isDirectory: true,
      progressMode: "files",
      direction: "download",
      sourceHostId: "host-a",
      sourceHostLabel: "CI-Build-01",
      targetConnectionId: "local",
      totalBytes: 2,
      transferredBytes: 1,
      reconnectRequired: true,
    },
    {
      ...makeTask("dir-child-done", "completed"),
      parentTaskId: "dir-parent",
      sourcePath: "/r/a",
      targetPath: "/l/a",
    },
    {
      ...makeTask("dir-child-open", "interrupted"),
      parentTaskId: "dir-parent",
      sourcePath: "/r/b",
      targetPath: "/l/b",
      checkpointBytes: 50,
      reconnectRequired: true,
    },
  ]);

  let sawDirectory = false;
  store.setDedicatedResumeHandler(async (task) => {
    sawDirectory = !!task.isDirectory;
    store.upsertTasks([{
      ...makeTask("dir-child-open", "completed"),
      parentTaskId: "dir-parent",
      ownerId: "dedicated-resume",
      sourcePath: "/r/b",
      targetPath: "/l/b",
    }]);
    return { success: true };
  });

  await store.resume("dir-parent");

  assert.equal(sawDirectory, true);
  const snapshot = store.getSnapshot().tasks;
  const parent = snapshot.find((task) => task.id === "dir-parent");
  const children = snapshot.filter((task) => task.parentTaskId === "dir-parent");
  assert.equal(parent?.status, "completed");
  assert.equal(parent?.ownerId, "dedicated-resume");
  assert.ok(children.every((child) => child.ownerId === "dedicated-resume"));
  assert.equal(children.find((child) => child.id === "dir-child-done")?.status, "completed");
});

test("upsertTasks refuses new children under a cancelled directory parent", () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("dedicated-resume", [{
    ...makeTask("dir", "cancelled"),
    isDirectory: true,
    ownerId: "dedicated-resume",
  }]);
  store.upsertTasks([{
    ...makeTask("late-child", "transferring"),
    parentTaskId: "dir",
    ownerId: "dedicated-resume",
  }]);
  assert.equal(store.getSnapshot().tasks.some((task) => task.id === "late-child"), false);
});

test("pause on dedicated directory parent freezes unfinished children", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("dedicated-resume", [
    {
      ...makeTask("dir", "transferring"),
      isDirectory: true,
      ownerId: "dedicated-resume",
      direction: "download",
      sourceHostId: "host-a",
      targetConnectionId: "local",
      totalBytes: 2,
      transferredBytes: 0,
    },
    {
      ...makeTask("c1", "transferring"),
      parentTaskId: "dir",
      ownerId: "dedicated-resume",
    },
  ]);

  // No live bridge pause — falls through to interrupted demotion for parent+children.
  await store.pause("dir");

  const snapshot = store.getSnapshot().tasks;
  assert.equal(snapshot.find((task) => task.id === "dir")?.status, "interrupted");
  assert.equal(snapshot.find((task) => task.id === "c1")?.status, "interrupted");
});

test("dedicated directory resume after soft-pause winds down then startFresh (no dead transferring)", async (t) => {
  const store = createSftpTransferCenterStore();
  let resumeCalls = 0;
  const cancelCalls: string[] = [];
  // Models bridge cancel when the child is no longer in activeTransfers: the
  // pendingCancel latch sticks until clearPendingTransferCancel runs.
  const pendingCancel = new Set<string>();
  const clearPendingCalls: string[] = [];
  let firstRunStarted: (() => void) | null = null;
  const firstRunBlocked = new Promise<void>((resolve) => { firstRunStarted = resolve; });
  let releaseFirstRun: (() => void) | null = null;
  const firstRunHold = new Promise<void>((resolve) => { releaseFirstRun = resolve; });

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        cancelTransfer: async (id: string) => {
          cancelCalls.push(id);
          // Sticky latch when not active (real bridge behavior for missing handle).
          pendingCancel.add(id);
          return { success: true };
        },
        clearPendingTransferCancel: async (id: string) => {
          clearPendingCalls.push(id);
          pendingCancel.delete(id);
          return { success: true };
        },
        resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
        pauseTransfer: async () => ({ success: true, checkpointBytes: 1 }),
      },
    },
  });

  store.publishOwner("dedicated-resume", [{
    ...makeTask("dir", "interrupted"),
    isDirectory: true,
    ownerId: "dedicated-resume",
    direction: "download",
    sourceHostId: "host-a",
    targetConnectionId: "local",
    totalBytes: 2,
    transferredBytes: 0,
    reconnectRequired: true,
  }, {
    ...makeTask("c1", "interrupted"),
    parentTaskId: "dir",
    ownerId: "dedicated-resume",
    reconnectRequired: true,
  }]);

  store.setDedicatedResumeHandler(async () => {
    resumeCalls += 1;
    if (resumeCalls === 1) {
      // Leave reconnectRequired so pause is not skipped only after live transfer.
      store.patchTask("dir", { status: "transferring", reconnectRequired: false });
      store.upsertTasks([{
        ...makeTask("c1", "transferring"),
        parentTaskId: "dir",
        ownerId: "dedicated-resume",
        reconnectRequired: false,
      }]);
      firstRunStarted?.();
      await firstRunHold;
      return { success: false, error: "Transfer cancelled" };
    }
    // startFresh reuses the same child transfer id — latch must be clear or
    // startStreamTransfer would immediately cancel (production failure mode).
    assert.equal(
      pendingCancel.has("c1"),
      false,
      "child pendingCancel latch must be cleared before startFresh reuses c1",
    );
    assert.ok(clearPendingCalls.includes("c1"), "must call clearPendingTransferCancel for c1");
    return { success: true };
  });

  // Start first dedicated run (held in resumeInvocations).
  const first = store.resume("dir");
  await firstRunBlocked;
  assert.equal(store.getSnapshot().tasks.find((task) => task.id === "dir")?.status, "transferring");

  // Soft-pause paints paused under dedicated-resume.
  await store.pause("dir");
  assert.equal(store.getSnapshot().tasks.find((task) => task.id === "dir")?.status, "paused");

  // Resume must cancel soft-paused children, clear sticky latches, await wind-down, then startFresh.
  const second = store.resume("dir");
  // Allow the held first run to settle after cancel wind-down begins.
  releaseFirstRun?.();
  await second;
  await first.catch(() => {});

  assert.ok(cancelCalls.includes("c1"), "must cancel soft-paused children before startFresh");
  assert.equal(resumeCalls, 2, "must startFresh after wind-down");
  assert.equal(pendingCancel.has("c1"), false, "child latch must stay clear after startFresh");
  assert.equal(store.getSnapshot().tasks.find((task) => task.id === "dir")?.status, "completed");
});

test("orphan directory pause rolls back successful child pauses on hard fail", async (t) => {
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        pauseTransfer: async (id: string) => {
          pauseCalls.push(id);
          if (id === "c-ok") return { success: true, checkpointBytes: 4 };
          return { success: false, reason: "This transfer cannot be paused safely" };
        },
        resumeTransfer: async (id: string) => {
          resumeCalls.push(id);
          return { success: true };
        },
      },
    },
  });

  const store = createSftpTransferCenterStore();
  store.publishOwner("dedicated-resume", [
    {
      ...makeTask("dir", "transferring"),
      isDirectory: true,
      ownerId: "dedicated-resume",
      direction: "download",
      sourceHostId: "host-a",
      targetConnectionId: "local",
      totalBytes: 2,
      transferredBytes: 0,
    },
    {
      ...makeTask("c-ok", "transferring"),
      parentTaskId: "dir",
      ownerId: "dedicated-resume",
    },
    {
      ...makeTask("c-fail", "transferring"),
      parentTaskId: "dir",
      ownerId: "dedicated-resume",
    },
  ]);

  await store.pause("dir");

  assert.deepEqual(pauseCalls.sort(), ["c-fail", "c-ok"]);
  // Successfully paused child must be bridge-resumed so work can continue.
  assert.deepEqual(resumeCalls, ["c-ok"]);
  const dir = store.getSnapshot().tasks.find((task) => task.id === "dir");
  assert.equal(dir?.status, "transferring");
  assert.match(dir?.pauseUnavailableReason ?? "", /cannot be paused/i);
  // Must not demote live children to interrupted when bridge was reachable.
  assert.equal(store.getSnapshot().tasks.find((task) => task.id === "c-ok")?.status, "transferring");
  assert.equal(store.getSnapshot().tasks.find((task) => task.id === "c-fail")?.status, "transferring");
});

test("dedicated resume source-changed marks attention and can reset checkpoint", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("src-changed", "interrupted"),
    direction: "download",
    sourceHostId: "host-a",
    targetConnectionId: "local",
    checkpointBytes: 40,
    transferredBytes: 40,
    totalBytes: 100,
    reconnectRequired: true,
  }]);

  store.setDedicatedResumeHandler(async () => ({
    success: false,
    needsAttention: true,
    resetCheckpoint: true,
    error: "Source was modified while the transfer was paused",
  }));

  await store.resume("src-changed");

  const task = store.getSnapshot().tasks[0];
  assert.equal(task?.status, "attention");
  assert.equal(task?.retryable, true);
  assert.equal(task?.checkpointBytes, 0);
  assert.equal(task?.transferredBytes, 0);
  assert.match(task?.error ?? "", /modified/i);
});

test("reconnectRequired resume skips a retained panel that cannot adopt", async () => {
  const store = createSftpTransferCenterStore();
  const ownerCalls: string[] = [];
  store.registerOwner("stale-panel", {
    pause: async () => {},
    resume: async (id) => { ownerCalls.push(`resume:${id}`); },
    cancel: async () => {},
    retry: async () => {},
    prioritize: async () => {},
    dismiss: () => {},
    canAdopt: () => false,
  });
  store.publishOwner("stale-panel", [{
    ...makeTask("stuck", "attention"),
    direction: "download",
    sourceHostId: "host-a",
    sourceHostLabel: "CI-Build-01",
    targetConnectionId: "local",
    reconnectRequired: true,
    error: "Reconnect the source and target before resuming",
  }]);

  let dedicated = false;
  store.setDedicatedResumeHandler(async () => {
    dedicated = true;
    return { success: true };
  });

  await store.resume("stuck");

  assert.equal(dedicated, true);
  assert.deepEqual(ownerCalls, []);
  assert.equal(store.getSnapshot().tasks[0]?.status, "completed");
});

test("resume marks orphaned tasks pending while reconnecting", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      netcatty: {
        resumeTransfer: async () => ({ success: false }),
      },
    },
  });

  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("reconnect-me", "interrupted"),
    sourceHostId: "host-a",
    reconnectRequired: true,
  }]);

  const resumePromise = store.resume("reconnect-me");
  // Status flips to pending before the long prepare wait finishes.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().tasks[0]?.status, "pending");
  assert.equal(store.getSnapshot().tasks[0]?.reconnectRequired, true);

  // Unblock prepare loop by cancelling.
  await store.cancel("reconnect-me");
  await resumePromise;
  assert.equal(store.getSnapshot().tasks[0]?.status, "cancelled");
});

test("resume waits for a transfer panel that becomes visible after the click", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent: () => true },
  });

  const calls: string[] = [];
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("waiting", "paused"),
    sourceHostId: "host-a",
  }]);

  const resumePromise = store.resume("waiting");
  setTimeout(() => {
    store.registerOwner("visible-panel", {
      pause: async () => {},
      resume: async (id) => { calls.push(`resume:${id}`); },
      cancel: async () => {}, retry: async () => {}, prioritize: async () => {}, dismiss: () => {},
      canAdopt: () => true,
      canPrepareAdoption: true,
      adopt: async (task) => { calls.push(`adopt:${task.id}`); },
    });
  }, 10);

  await resumePromise;

  assert.deepEqual(calls, ["adopt:waiting"]);
  assert.equal(store.getSnapshot().tasks[0]?.ownerId, "visible-panel");
});

test("an interrupted task without its old controller can still be cancelled", async () => {
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [makeTask("interrupted", "interrupted")]);

  await store.cancel("interrupted");

  assert.equal(store.getSnapshot().tasks[0]?.status, "cancelled");
});

test("concurrent resume clicks adopt a task only once", async () => {
  let adoptCount = 0;
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("resume-once", "interrupted"),
    sourceHostId: "host-a",
  }]);
  store.registerOwner("visible-panel", {
    pause: async () => {}, resume: async () => {}, cancel: async () => {}, retry: async () => {}, prioritize: async () => {}, dismiss: () => {},
    canAdopt: () => true,
    adopt: async () => { adoptCount += 1; },
  });

  await Promise.all([store.resume("resume-once"), store.resume("resume-once")]);

  assert.equal(adoptCount, 1);
});

test("cancelling while resume waits prevents later adoption", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent: () => true },
  });

  let adoptCount = 0;
  const store = createSftpTransferCenterStore();
  store.publishOwner("closed-panel", [{
    ...makeTask("cancel-waiting", "paused"),
    sourceHostId: "host-a",
  }]);

  const resumePromise = store.resume("cancel-waiting");
  setTimeout(() => { void store.cancel("cancel-waiting"); }, 10);
  setTimeout(() => {
    store.registerOwner("visible-panel", {
      pause: async () => {}, resume: async () => {}, cancel: async () => {}, retry: async () => {}, prioritize: async () => {}, dismiss: () => {},
      canAdopt: () => true,
      canPrepareAdoption: true,
      adopt: async () => { adoptCount += 1; },
    });
  }, 20);

  await resumePromise;

  assert.equal(adoptCount, 0);
  assert.equal(store.getSnapshot().tasks[0]?.status, "cancelled");
});
