import assert from "node:assert/strict";
import test from "node:test";
import type { Identity } from "./models";
import { buildQuickConnectHost } from "./quickConnectHost";

const target = { hostname: "example.com" };

test("buildQuickConnectHost creates an ephemeral ET connection without saving credentials", () => {
  const host = buildQuickConnectHost({
    target,
    protocol: "et",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "secret",
    save: false,
    now: 1,
    randomId: "id",
  });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.etEnabled, true);
  assert.equal(host.etPort, 2022);
  assert.equal(host.ephemeral, true);
  assert.equal(host.password, "secret");
});

test("buildQuickConnectHost references a saved identity without copying its secret", () => {
  const identity: Identity = {
    id: "identity-1",
    label: "Production",
    username: "deploy",
    authMethod: "password",
    password: "secret",
    created: 1,
  };
  const host = buildQuickConnectHost({
    target,
    protocol: "ssh",
    port: 22,
    username: "ignored",
    authMethod: "password",
    password: "ignored",
    selectedIdentity: identity,
    save: true,
    now: 1,
    randomId: "id",
  });

  assert.equal(host.username, "deploy");
  assert.equal(host.identityId, "identity-1");
  assert.equal(host.password, undefined);
  assert.equal(host.ephemeral, false);
});

test("buildQuickConnectHost keeps Mosh on SSH bootstrap settings", () => {
  const host = buildQuickConnectHost({
    target,
    protocol: "mosh",
    port: 2202,
    username: "root",
    authMethod: "key",
    selectedKeyId: "key-1",
    save: true,
    now: 1,
    randomId: "id",
  });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.port, 2202);
  assert.equal(host.moshEnabled, true);
  assert.equal(host.identityFileId, "key-1");
});
