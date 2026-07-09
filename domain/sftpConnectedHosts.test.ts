import assert from "node:assert/strict";
import test from "node:test";

import type { Host, TerminalSession } from "./models";
import { listSftpConnectedHosts, sftpPickerSessionsEqual } from "./sftpConnectedHosts";

const host = (overrides: Partial<Host> & Pick<Host, "id" | "label">): Host => ({
  hostname: `${overrides.id}.example.test`,
  username: "alice",
  port: 22,
  protocol: "ssh",
  tags: [],
  os: "linux",
  ...overrides,
});

const session = (
  overrides: Partial<TerminalSession> & Pick<TerminalSession, "id" | "hostId" | "status">,
): TerminalSession => ({
  hostLabel: overrides.hostId,
  username: "alice",
  hostname: `${overrides.hostId}.example.test`,
  protocol: "ssh",
  ...overrides,
});

test("listSftpConnectedHosts returns connected SSH hosts sorted by label", () => {
  const hosts = [
    host({ id: "b", label: "Bravo" }),
    host({ id: "a", label: "Alpha" }),
  ];
  const hostsById = new Map(hosts.map((h) => [h.id, h]));
  const sessions = [
    session({ id: "s-b", hostId: "b", status: "connected" }),
    session({ id: "s-a", hostId: "a", status: "connected" }),
  ];

  const result = listSftpConnectedHosts(sessions, hostsById);
  assert.deepEqual(
    result.map((entry) => [entry.host.id, entry.sessionId, entry.status]),
    [
      ["a", "s-a", "connected"],
      ["b", "s-b", "connected"],
    ],
  );
});

test("listSftpConnectedHosts prefers connected over connecting for the same host", () => {
  const hostsById = new Map([["a", host({ id: "a", label: "Alpha" })]]);
  const sessions = [
    session({ id: "s-connecting", hostId: "a", status: "connecting" }),
    session({ id: "s-connected", hostId: "a", status: "connected" }),
  ];

  const result = listSftpConnectedHosts(sessions, hostsById);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sessionId, "s-connected");
  assert.equal(result[0]?.status, "connected");
});

test("listSftpConnectedHosts skips serial, local, telnet, and disconnected sessions", () => {
  const hosts = [
    host({ id: "ssh", label: "SSH" }),
    host({ id: "serial", label: "Serial", protocol: "serial" }),
    host({ id: "telnet", label: "Telnet", protocol: "telnet" }),
  ];
  const hostsById = new Map(hosts.map((h) => [h.id, h]));
  const sessions = [
    session({ id: "s-ssh", hostId: "ssh", status: "connected" }),
    session({ id: "s-serial", hostId: "serial", status: "connected", protocol: "serial" }),
    session({ id: "s-local", hostId: "ssh", status: "connected", protocol: "local" }),
    session({ id: "s-telnet", hostId: "telnet", status: "connected", protocol: "telnet" }),
    session({ id: "s-dead", hostId: "ssh", status: "disconnected" }),
  ];

  const result = listSftpConnectedHosts(sessions, hostsById);
  assert.deepEqual(
    result.map((entry) => entry.sessionId),
    ["s-ssh"],
  );
});

test("listSftpConnectedHosts includes ephemeral hosts present in hostsById", () => {
  const ephemeral = host({ id: "ephemeral-1", label: "Deep Link", ephemeral: true });
  const hostsById = new Map([[ephemeral.id, ephemeral]]);
  const sessions = [
    session({
      id: "s-ephemeral",
      hostId: ephemeral.id,
      status: "connected",
      ephemeralHost: true,
    }),
  ];

  const result = listSftpConnectedHosts(sessions, hostsById);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.host.ephemeral, true);
  assert.equal(result[0]?.sessionId, "s-ephemeral");
});

test("listSftpConnectedHosts skips sessions whose host is missing from the map", () => {
  const result = listSftpConnectedHosts(
    [session({ id: "orphan", hostId: "missing", status: "connected" })],
    new Map(),
  );
  assert.deepEqual(result, []);
});

test("sftpPickerSessionsEqual ignores title-only changes", () => {
  const prev = [session({ id: "s1", hostId: "a", status: "connected", dynamicTitle: "old" })];
  const next = [session({ id: "s1", hostId: "a", status: "connected", dynamicTitle: "new" })];
  assert.equal(sftpPickerSessionsEqual(prev, next), true);
});

test("sftpPickerSessionsEqual detects status and hostId changes", () => {
  const base = session({ id: "s1", hostId: "a", status: "connecting" });
  assert.equal(
    sftpPickerSessionsEqual([base], [session({ id: "s1", hostId: "a", status: "connected" })]),
    false,
  );
  assert.equal(
    sftpPickerSessionsEqual([base], [session({ id: "s1", hostId: "b", status: "connecting" })]),
    false,
  );
});
