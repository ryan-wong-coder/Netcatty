import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TransferTask } from "../../domain/models";
import {
  SFTP_TRANSFER_HISTORY_RETENTION_MS,
  countTransfersRetainingSftpOwner,
  isTransferRetainingSftpOwner,
  listInvalidSftpPanelTabIds,
  listTerminalTabIdsWithRetainingTransfers,
  resolveSftpActiveTransfersCount,
  shouldClearSftpPanelAfterTransferChange,
  shouldKeepSftpMountedAfterClose,
  shouldScheduleSftpRetainedPanelCleanup,
  terminalSftpTransferOwnerId,
} from "./sftpPanelLifecycle.ts";

function task(
  partial: Partial<TransferTask> & Pick<TransferTask, "id" | "status">,
): Pick<TransferTask, "id" | "status" | "parentTaskId" | "ownerId"> {
  return {
    id: partial.id,
    status: partial.status,
    parentTaskId: partial.parentTaskId,
    ownerId: partial.ownerId,
  };
}

test("closing the panel keeps SFTP mounted while a transfer is active", () => {
  assert.equal(shouldKeepSftpMountedAfterClose(1), true);
  assert.equal(shouldKeepSftpMountedAfterClose(3), true);
});

test("closing an idle panel still releases its SFTP state", () => {
  assert.equal(shouldKeepSftpMountedAfterClose(0), false);
});

test("a transfer retained by close keeps its history after completion", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    panelOpen: false,
    retainedAfterClose: true,
  }), false);
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    retainedAfterClose: true,
  }), true);
  assert.ok(SFTP_TRANSFER_HISTORY_RETENTION_MS > 0);
});

test("retained cleanup is scheduled even if close state has not committed yet", () => {
  assert.equal(shouldScheduleSftpRetainedPanelCleanup({
    activeTransfersCount: 0,
    retainedAfterClose: true,
  }), true);
});

test("closing a terminal tab finds every retained SFTP resource for cleanup", () => {
  assert.deepEqual(listInvalidSftpPanelTabIds({
    mountedTabIds: ["closed-tab", "open-tab"],
    activeTransferTabIds: [],
    retainedTabIds: ["closed-tab"],
    openingTabIds: [],
    cleanupTimerTabIds: ["closed-tab"],
    validTabIds: new Set(["open-tab"]),
  }), ["closed-tab"]);
});

test("closing a terminal tab keeps its hidden SFTP owner mounted until active transfers finish", () => {
  assert.deepEqual(listInvalidSftpPanelTabIds({
    mountedTabIds: ["closed-tab"],
    activeTransferTabIds: ["closed-tab"],
    retainedTabIds: [],
    openingTabIds: [],
    cleanupTimerTabIds: [],
    validTabIds: new Set(),
  }), []);
});

test("a reopening panel is not cleared before its open state commits", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    panelOpen: true,
    retainedAfterClose: false,
  }), false);
});

test("an unretained hidden idle panel can be released", () => {
  assert.equal(shouldClearSftpPanelAfterTransferChange({
    activeTransfersCount: 0,
    panelOpen: false,
    retainedAfterClose: false,
  }), true);
});

test("terminal owner id is stable for retain lookups", () => {
  assert.equal(terminalSftpTransferOwnerId("tab-1"), "terminal:tab-1");
});

test("store unfinished tasks retain the owner even when the panel report is still zero", () => {
  const ownerId = terminalSftpTransferOwnerId("tab-a");
  const storeTasks = [
    task({ id: "t1", status: "transferring", ownerId }),
    task({ id: "t2", status: "completed", ownerId }),
    task({ id: "child", status: "transferring", ownerId, parentTaskId: "t1" }),
  ];
  assert.equal(isTransferRetainingSftpOwner(storeTasks[0]!), true);
  assert.equal(isTransferRetainingSftpOwner(storeTasks[1]!), false);
  assert.equal(isTransferRetainingSftpOwner(storeTasks[2]!), false);
  assert.equal(countTransfersRetainingSftpOwner(storeTasks, ownerId), 1);
  assert.equal(resolveSftpActiveTransfersCount({
    reportedCount: 0,
    storeTasks,
    ownerId,
  }), 1);
  assert.equal(shouldKeepSftpMountedAfterClose(
    resolveSftpActiveTransfersCount({ reportedCount: 0, storeTasks, ownerId }),
  ), true);
});

test("paused and failed top-level tasks still retain the hidden SFTP owner", () => {
  const ownerId = terminalSftpTransferOwnerId("tab-b");
  const storeTasks = [
    task({ id: "paused", status: "paused", ownerId }),
    task({ id: "failed", status: "failed", ownerId }),
  ];
  assert.equal(countTransfersRetainingSftpOwner(storeTasks, ownerId), 2);
});

test("listTerminalTabIdsWithRetainingTransfers only returns terminal owners with unfinished work", () => {
  assert.deepEqual(listTerminalTabIdsWithRetainingTransfers([
    task({ id: "a", status: "transferring", ownerId: "terminal:tab-1" }),
    task({ id: "b", status: "completed", ownerId: "terminal:tab-2" }),
    task({ id: "c", status: "queued", ownerId: "main-sftp-view" }),
    task({ id: "d", status: "paused", ownerId: "terminal:tab-3" }),
  ]).sort(), ["tab-1", "tab-3"]);
});

test("terminal side panel reports transfer activity and uses store-backed retain on close", () => {
  const layerSource = readFileSync(new URL("../TerminalLayer.tsx", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");
  const slotsSource = readFileSync(new URL("./terminalLayerSidePanelSlots.tsx", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../../application/state/useSftpState.ts", import.meta.url), "utf8");

  assert.match(panelSource, /onActiveTransfersChangeRef\.current\?\.\(sftp\.activeTransfersCount\)/);
  // Cleanup must not re-subscribe to callback identity (race that zeros mid-transfer).
  assert.match(panelSource, /onActiveTransfersChangeRef\.current\?\.\(0\)/);
  assert.doesNotMatch(panelSource, /useEffect\(\(\) => \(\) => \{\s*onActiveTransfersChange\?\.\(0\);\s*\}, \[onActiveTransfersChange\]\)/);
  assert.match(panelSource, /interactive:\s*isVisible/);
  assert.match(slotsSource, /onActiveTransfersChange=\{handleActiveTransfersChange\}/);
  assert.match(layerSource, /resolveTabActiveTransfersCount/);
  assert.match(layerSource, /terminalSftpTransferOwnerId/);
  assert.match(layerSource, /listTerminalTabIdsWithRetainingTransfers/);
  assert.match(layerSource, /shouldKeepSftpMountedAfterClose\(activeTransfersCount\)/);
  assert.match(layerSource, /sftpRetainedAfterCloseTabIdsRef/);
  assert.match(layerSource, /sftpRetainedCleanupTimersRef/);
  // Hidden UI parks browse channels; transfers keep pool / leased sessions.
  assert.match(stateSource, /shouldParkBrowseSessions/);
  assert.match(stateSource, /takeBrowseSessionsForClose/);
  assert.match(stateSource, /shouldRestoreBrowseSessions/);
});
