import test from "node:test";
import assert from "node:assert/strict";

import type { Host, PortForwardingRule, SSHKey } from "../../domain/models.ts";
import {
  getActiveConnection,
  startPortForward,
  stopAndCleanupRule,
  stopAndCleanupRuleAndWait,
} from "./portForwardingService.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const rule = (overrides: Partial<PortForwardingRule> = {}): PortForwardingRule => ({
  id: "rule-1",
  name: "Rule",
  type: "local",
  localPort: 18080,
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  enabled: true,
  status: "inactive",
  ...overrides,
});

const installBridgeStub = () => {
  let started = false;
  let capturedOptions: Record<string, unknown> | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: Record<string, unknown>) => {
          started = true;
          capturedOptions = options;
          return { success: true };
        },
        onPortForwardStatus: () => undefined,
      },
    },
  });
  return {
    wasStarted: () => started,
    getOptions: () => capturedOptions,
  };
};

test("stopAndCleanupRuleAndWait stops backend tunnels without a renderer connection", async () => {
  let stoppedRuleId: string | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async (ruleId: string) => {
          stoppedRuleId = ruleId;
          return { stopped: 1 };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("backend-only-rule");

  assert.equal(result.success, true);
  assert.equal(stoppedRuleId, "backend-only-rule");
});

test("stopAndCleanupRuleAndWait reports backend stop failures", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("backend stop failed");
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("failing-rule");

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /backend stop failed/);
});

test("stopAndCleanupRuleAndWait reports partial backend stop failures", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({
          stopped: 1,
          failed: 1,
          errors: ["tunnel close failed"],
        }),
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("partial-failure-rule");

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /tunnel close failed/);
});

test("stopAndCleanupRuleAndWait preserves a pending reconnect after stop failure", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "retrying-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection("retrying-rule");
  assert.ok(connection);
  let reconnectAttempts = 0;
  const reconnectTimerCallback = () => {
    reconnectAttempts++;
  };
  const reconnectTimeoutId = setTimeout(reconnectTimerCallback, 10);
  connection.reconnectTimeoutId = reconnectTimeoutId;
  connection.reconnectDueAt = Date.now() + 10;
  connection.reconnectTimerCallback = reconnectTimerCallback;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return {
            stopped: 0,
            failed: 1,
            errors: ["backend stop failed"],
          };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("retrying-rule");

  assert.equal(result.success, false);
  assert.equal(reconnectAttempts, 0);
  assert.ok(getActiveConnection("retrying-rule")?.reconnectTimeoutId);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(reconnectAttempts, 1);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("cleanup failure");
        },
      },
    },
  });
  stopAndCleanupRule("retrying-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getActiveConnection("retrying-rule"), undefined);
});

test("stopAndCleanupRuleAndWait blocks a pending reconnect while stop succeeds", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "stopping-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection("stopping-rule");
  assert.ok(connection);
  let reconnectAttempts = 0;
  const reconnectTimerCallback = () => {
    reconnectAttempts++;
  };
  connection.reconnectTimeoutId = setTimeout(reconnectTimerCallback, 10);
  connection.reconnectDueAt = Date.now() + 10;
  connection.reconnectTimerCallback = reconnectTimerCallback;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { stopped: 1, failed: 0, errors: [] };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("stopping-rule");

  assert.equal(result.success, true);
  assert.equal(reconnectAttempts, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(reconnectAttempts, 0);
  assert.equal(getActiveConnection("stopping-rule"), undefined);
});

test("stopAndCleanupRule still clears local reconnect state after backend stop failures", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "background-cleanup-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  assert.ok(getActiveConnection("background-cleanup-rule"));

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("backend stop failed");
        },
      },
    },
  });

  stopAndCleanupRule("background-cleanup-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getActiveConnection("background-cleanup-rule"), undefined);
});

test("startPortForward forwards system agent settings", async () => {
  const bridge = installBridgeStub();

  const result = await startPortForward(
    rule({ id: "rule-agent" }),
    host({
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    }),
    [],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    bridge.getOptions() && {
      useSshAgent: bridge.getOptions()?.useSshAgent,
      identityAgent: bridge.getOptions()?.identityAgent,
      identityFilePaths: bridge.getOptions()?.identityFilePaths,
      identitiesOnly: bridge.getOptions()?.identitiesOnly,
      addKeysToAgent: bridge.getOptions()?.addKeysToAgent,
      useKeychain: bridge.getOptions()?.useKeychain,
    },
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("startPortForward drops stale identity paths for password-only auth", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    authMethod: "password",
    password: "jump-secret",
    useSshAgent: true,
    identityFilePaths: ["~/.ssh/stale-jump-key"],
  });

  const result = await startPortForward(
    rule({ id: "rule-password-only" }),
    host({
      authMethod: "password",
      password: "secret",
      useSshAgent: true,
      identityFilePaths: ["~/.ssh/stale-key"],
      hostChain: { hostIds: ["jump-1"] },
    }),
    [jumpHost],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.identityFilePaths, undefined);
  assert.equal(bridge.getOptions()?.useSshAgent, false);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.identityFilePaths, undefined);
  assert.equal(jumpHosts[0]?.useSshAgent, false);
});

test("startPortForward uses the system agent when a synced key cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const key: SSHKey = {
    id: "key-1",
    label: "Synced key",
    type: "ED25519",
    publicKey: "ssh-ed25519 AAAASELECTED",
    privateKey: "enc:v1:djEwAAAA",
    source: "imported",
    category: "key",
    created: 1,
  };

  const result = await startPortForward(
    rule({ id: "rule-agent-synced-key" }),
    host({
      authMethod: "key",
      identityFileId: "key-1",
      useSshAgent: true,
    }),
    [],
    [key],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.useSshAgent, true);
  assert.deepEqual(bridge.getOptions()?.agentPublicKeys, ["ssh-ed25519 AAAASELECTED"]);
  assert.equal(bridge.getOptions()?.privateKey, undefined);
});

test("startPortForward keeps automatic target discovery available with an unreadable saved password", async () => {
  const bridge = installBridgeStub();
  const result = await startPortForward(
    rule({ id: "rule-auto-unreadable" }),
    host({ authMethod: "auto", password: "enc:v1:djEwAAAA" }),
    [],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.authMethod, "auto");
  assert.equal(bridge.getOptions()?.password, undefined);
});

test("startPortForward keeps automatic jump discovery available with an unreadable saved password", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    authMethod: "auto",
    password: "enc:v1:djEwAAAA",
  });
  const result = await startPortForward(
    rule({ id: "rule-auto-jump-unreadable" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  const jumpOptions = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>> | undefined;
  assert.equal(jumpOptions?.[0]?.authMethod, "auto");
  assert.equal(jumpOptions?.[0]?.password, undefined);
});

test("startPortForward forwards target and jump-host timeouts", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    sshTcpConnectTimeoutSeconds: 75,
    sshAuthReadyTimeoutSeconds: 360,
  });

  const result = await startPortForward(
    rule({ id: "rule-timeouts" }),
    host({
      hostChain: { hostIds: ["jump-1"] },
      sshTcpConnectTimeoutSeconds: 45,
      sshAuthReadyTimeoutSeconds: 300,
    }),
    [jumpHost],
    [],
    [],
    () => {},
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.sshTcpConnectTimeoutMs, 45_000);
  assert.equal(bridge.getOptions()?.sshAuthReadyTimeoutMs, 300_000);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.sshTcpConnectTimeoutMs, 75_000);
  assert.equal(jumpHosts[0]?.sshAuthReadyTimeoutMs, 360_000);
});

test("startPortForward rejects missing proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule(),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "missing-identity",
      },
    }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-missing-profile" }),
    host({ proxyProfileId: "missing-proxy" }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for host "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-incomplete" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects proxy identities with blank usernames even when passwords are encrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-blank-username" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves target proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-resolved-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  assert.deepEqual(bridge.getOptions()?.proxy, {
    type: "http",
    host: "proxy.example.com",
    port: 3128,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects target proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-unreadable-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});

test("startPortForward rejects missing jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "missing-identity",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-2" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles on jump hosts before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyProfileId: "missing-proxy",
  });

  const result = await startPortForward(
    rule({ id: "rule-missing-jump-profile" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for jump host "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-jump-incomplete" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves jump host proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "socks5",
      host: "jump-proxy.example.com",
      port: 1080,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-resolved-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.deepEqual(jumpHosts[0]?.proxy, {
    type: "socks5",
    host: "jump-proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects jump host proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-unreadable-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials for jump host "Jump" cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});
