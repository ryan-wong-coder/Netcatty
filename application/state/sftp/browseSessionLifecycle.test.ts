import assert from "node:assert/strict";
import test from "node:test";

import {
  listRemoteConnectionIdsForRestore,
  shouldParkBrowseSessions,
  shouldRestoreBrowseSessions,
  takeBrowseSessionsForClose,
} from "./browseSessionLifecycle.ts";

test("parks browse only when the interactive surface hides and not already parked", () => {
  assert.equal(shouldParkBrowseSessions({ interactive: false, browseParked: false }), true);
  assert.equal(shouldParkBrowseSessions({ interactive: false, browseParked: true }), false);
  assert.equal(shouldParkBrowseSessions({ interactive: true, browseParked: false }), false);
  assert.equal(shouldParkBrowseSessions({
    interactive: false,
    browseParked: false,
    activeTransfersCount: 2,
  }), false);
});

test("restores browse when the surface becomes interactive again after park", () => {
  assert.equal(shouldRestoreBrowseSessions({ interactive: true, browseParked: true }), true);
  assert.equal(shouldRestoreBrowseSessions({ interactive: true, browseParked: false }), false);
  assert.equal(shouldRestoreBrowseSessions({ interactive: false, browseParked: true }), false);
});

test("takeBrowseSessionsForClose snapshots and clears the map", () => {
  const sessions = new Map([
    ["conn-a", "sftp-1"],
    ["conn-b", "sftp-2"],
  ]);
  assert.deepEqual(takeBrowseSessionsForClose(sessions), [
    { connectionId: "conn-a", sftpId: "sftp-1" },
    { connectionId: "conn-b", sftpId: "sftp-2" },
  ]);
  assert.equal(sessions.size, 0);
});

test("listRemoteConnectionIdsForRestore skips local and already-live remotes", () => {
  const ids = listRemoteConnectionIdsForRestore({
    leftTabs: [
      { connection: { id: "local", isLocal: true } },
      { connection: { id: "remote-a", isLocal: false } },
      { connection: null },
    ],
    rightTabs: [
      { connection: { id: "remote-b", isLocal: false } },
      { connection: { id: "remote-a", isLocal: false } },
    ],
    liveSessionConnectionIds: new Set(["remote-b"]),
  });
  assert.deepEqual(ids, ["remote-a"]);
});
