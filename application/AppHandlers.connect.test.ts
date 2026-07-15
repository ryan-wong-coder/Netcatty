import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flushQueuedTrayPanelConnectHostsImpl,
  handleConnectToHostImpl,
  handleKeyboardInteractiveSubmitImpl,
  handleTrayPanelConnectRequestImpl,
} from './app/AppHandlers.ts';
import type { Host } from '../types';

const baseHost: Host = {
  id: 'host-1',
  label: '10.2.0.32',
  hostname: '10.2.0.32',
  username: 'root',
  tags: [],
  os: 'linux',
  protocol: 'ssh',
};

test('connect host handler returns the created terminal tab id', () => {
  const logs: unknown[] = [];
  const connectedHosts: Host[] = [];
  const result = handleConnectToHostImpl(
    () => ({
      addConnectionLog: (entry: unknown) => logs.push(entry),
      connectToHost: (host: Host) => {
        connectedHosts.push(host);
        return 'session-from-connect';
      },
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: 'root' }),
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
    }),
    baseHost,
  );

  assert.equal(result, 'session-from-connect');
  assert.equal(connectedHosts.length, 1);
  assert.equal(logs.length, 1);
});

test('connect serial host handler returns the created terminal tab id', () => {
  const serialHost: Host = {
    ...baseHost,
    id: 'serial-1',
    label: '',
    hostname: '/dev/tty.usbserial',
    protocol: 'serial',
  };

  const result = handleConnectToHostImpl(
    () => ({
      addConnectionLog: () => {},
      connectToHost: () => 'serial-session',
      identities: [],
      keys: [],
      resolveEffectiveHost: (host: Host) => host,
      resolveHostAuth: () => ({ username: 'root' }),
      systemInfoRef: { current: { username: 'local-user', hostname: 'local-host' } },
    }),
    serialHost,
  );

  assert.equal(result, 'serial-session');
});

test('tray panel connect request queues until the vault is initialized', () => {
  const queuedHostIds: string[] = [];
  const connectedHostIds: string[] = [];

  handleTrayPanelConnectRequestImpl(
    () => ({
      connectNow: (hostId: string) => connectedHostIds.push(hostId),
      isVaultInitialized: false,
      queueConnect: (hostId: string) => queuedHostIds.push(hostId),
    }),
    'host-1',
  );

  assert.deepEqual(queuedHostIds, ['host-1']);
  assert.deepEqual(connectedHostIds, []);
});

test('tray panel connect request runs immediately after the vault is initialized', () => {
  const queuedHostIds: string[] = [];
  const connectedHostIds: string[] = [];

  handleTrayPanelConnectRequestImpl(
    () => ({
      connectNow: (hostId: string) => connectedHostIds.push(hostId),
      isVaultInitialized: true,
      queueConnect: (hostId: string) => queuedHostIds.push(hostId),
    }),
    'host-1',
  );

  assert.deepEqual(queuedHostIds, []);
  assert.deepEqual(connectedHostIds, ['host-1']);
});

test('queued tray panel connects flush in order', () => {
  const connectedHostIds: string[] = [];
  let pendingHostIds = ['host-1', 'host-2'];

  flushQueuedTrayPanelConnectHostsImpl(() => ({
    connectNow: (hostId: string) => connectedHostIds.push(hostId),
    pendingHostIds,
    setPendingHostIds: (nextHostIds: string[]) => {
      pendingHostIds = nextHostIds;
    },
  }));

  assert.deepEqual(connectedHostIds, ['host-1', 'host-2']);
  assert.deepEqual(pendingHostIds, []);
});

test('keyboard-interactive submit preserves saved password when enabling MFA', () => {
  let hosts: Host[] = [{
    ...baseHost,
    password: 'old-password',
    savePassword: false,
    requiresMfa: false,
  }];
  let queue = [{
    requestId: 'ki-1',
    sessionId: 'session-1',
    hostname: baseHost.hostname,
    allowSavePassword: true,
  }];
  const bridgeResponses: unknown[] = [];
  const hostUpdates: Host[][] = [];
  const toasts: string[] = [];

  handleKeyboardInteractiveSubmitImpl(
    () => ({
      hosts,
      keyboardInteractiveQueue: queue,
      netcattyBridge: {
        get: () => ({
          respondKeyboardInteractive: (...args: unknown[]) => {
            bridgeResponses.push(args);
          },
        }),
      },
      sessions: [{
        id: 'session-1',
        hostId: baseHost.id,
        hostname: baseHost.hostname,
      }],
      setKeyboardInteractiveQueue: (updater: (items: typeof queue) => typeof queue) => {
        queue = updater(queue);
      },
      t: (key: string) => key,
      toast: { info: (message: string) => toasts.push(message) },
      updateHosts: (nextHosts: Host[]) => {
        hostUpdates.push(nextHosts);
        hosts = nextHosts;
      },
    }),
    'ki-1',
    ['login-password', 'otp-code'],
    'new-login-password',
    true,
  );

  assert.equal(hostUpdates.length, 1);
  assert.deepEqual(hosts[0], {
    ...baseHost,
    password: 'new-login-password',
    savePassword: true,
    requiresMfa: true,
  });
  assert.deepEqual(queue, []);
  assert.deepEqual(toasts, ['keyboard.interactive.mfaEnabled']);
  assert.equal(bridgeResponses.length, 1);
});
