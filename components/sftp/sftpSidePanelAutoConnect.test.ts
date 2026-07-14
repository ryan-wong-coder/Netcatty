import test from "node:test";
import assert from "node:assert/strict";
import type { SftpPane } from "../../application/state/sftp/types";
import {
  connectionKeyMatchesHost,
  findReusableSftpSidePanelTab,
  isRemoteSftpTabHealthy,
  shouldResetSftpSidePanelSourceSession,
  shouldSkipSftpSidePanelAutoConnect,
} from "./sftpSidePanelAutoConnect";

const remoteConnectedTab = (overrides: Partial<SftpPane> = {}): SftpPane => ({
  id: "tab-1",
  connection: {
    id: "conn-1",
    hostId: "host-1",
    hostLabel: "server",
    isLocal: false,
    status: "connected",
    currentPath: "/var/www",
  },
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  connectionLogs: [],
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles: false,
  transferMutationToken: 0,
  ...overrides,
});

test("isRemoteSftpTabHealthy rejects loading tabs", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("isRemoteSftpTabHealthy rejects tabs without a backend SFTP session", () => {
  const tab = remoteConnectedTab();
  assert.equal(isRemoteSftpTabHealthy(tab, false), false);
});

test("isRemoteSftpTabHealthy rejects connecting tabs", () => {
  const tab = remoteConnectedTab({
    connection: {
      ...remoteConnectedTab().connection!,
      status: "connecting",
    },
  });
  assert.equal(isRemoteSftpTabHealthy(tab, true), false);
});

test("shouldSkipSftpSidePanelAutoConnect returns false for stale connected keys", () => {
  const tab = remoteConnectedTab({ loading: true });
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true, "host-key"),
    false,
  );
});

test("shouldSkipSftpSidePanelAutoConnect rejects a healthy tab mapped to another endpoint", () => {
  const tab = remoteConnectedTab();
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-a-key", "host-a-key", tab, true, "host-b-key"),
    false,
  );
});

test("shouldSkipSftpSidePanelAutoConnect rejects when the active tab has no endpoint map", () => {
  const tab = remoteConnectedTab();
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-a-key", "host-a-key", tab, true, null),
    false,
  );
});

test("connectionKeyMatchesHost accepts host-id prefix keys", () => {
  assert.equal(connectionKeyMatchesHost("host-1:server:22:ssh::root", "host-1"), true);
  assert.equal(connectionKeyMatchesHost("host-2:server:22:ssh::root", "host-1"), false);
  assert.equal(connectionKeyMatchesHost(null, "host-1"), false);
});

test("findReusableSftpSidePanelTab ignores tabs stuck in loading after SSH disconnect", () => {
  const tab = remoteConnectedTab({ loading: true });
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    null,
  );
});

test("findReusableSftpSidePanelTab returns healthy tabs", () => {
  const tab = remoteConnectedTab();
  const map = new Map([[tab.id, "host-key"]]);
  assert.equal(
    findReusableSftpSidePanelTab([tab], "host-1", "host-key", map, () => true),
    tab,
  );
});

test("shouldResetSftpSidePanelSourceSession detects terminal session changes", () => {
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"), true);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession(null, "sess-a"), false);
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", null), false);
});

test("session change still requires rebind even when the endpoint key matches", () => {
  const tab = remoteConnectedTab();
  // Callers must not skip auto-connect solely because the tab is healthy —
  // a new focused terminal may share host/port/user while proxy/jump differs.
  // Path stickiness is handled by remembered initialPath on reconnect.
  assert.equal(shouldResetSftpSidePanelSourceSession("sess-a", "sess-b"), true);
  assert.equal(
    shouldSkipSftpSidePanelAutoConnect("host-key", "host-key", tab, true, "host-key"),
    true,
  );
  // Reuse lookup still finds the tab, but callers pass sessionChanged and skip
  // it so connect rebinds with the new sourceSessionId.
  assert.equal(
    findReusableSftpSidePanelTab(
      [tab],
      "host-1",
      "host-key",
      new Map([[tab.id, "host-key"]]),
      () => true,
    ),
    tab,
  );
});
