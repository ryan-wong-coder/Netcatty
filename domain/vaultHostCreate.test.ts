import test from 'node:test';
import assert from 'node:assert/strict';

import type { Host, Identity, ManagedSource, ProxyProfile } from './models.ts';
import { applyGroupDefaults } from './groupConfig.ts';
import {
  applyVaultHostDelete,
  applyVaultHostCreates,
  applyVaultHostUpdate,
  buildVaultHostFromDraft,
  buildVaultHostsFromDrafts,
  parseVaultHostDraftsInput,
  type VaultHostDraft,
  type VaultHostUpdatePatch,
} from './vaultHostCreate.ts';

test('buildVaultHostFromDraft maps minimal unstructured fields to a vault host', () => {
  const built = buildVaultHostFromDraft({
    hostname: '192.168.1.10',
    username: 'ubuntu',
    label: 'prod web',
    group: 'infra/prod',
    tags: 'web, nginx',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.hostname, '192.168.1.10');
  assert.equal(built.host.username, 'ubuntu');
  assert.equal(built.host.group, 'infra/prod');
  assert.deepEqual(built.host.tags, ['web', 'nginx']);
});

test('buildVaultHostFromDraft accepts host aliases and a referenced key path', () => {
  const built = buildVaultHostFromDraft({
    name: 'prod api',
    ip: '10.0.0.10',
    username: 'deploy',
    keyPath: '~/.ssh/id_ed25519',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.label, 'prod api');
  assert.equal(built.host.hostname, '10.0.0.10');
  assert.equal(built.host.authMethod, 'key');
  assert.deepEqual(built.host.identityFilePaths, ['~/.ssh/id_ed25519']);
  assert.equal(built.host.password, undefined);
});

test('buildVaultHostFromDraft does not retain a password when saving is disabled', () => {
  const built = buildVaultHostFromDraft({
    hostname: '10.0.0.20',
    username: 'deploy',
    password: 'do-not-save',
    savePassword: 'false',
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.host.password, undefined);
  assert.equal(built.host.savePassword, false);
});

test('buildVaultHostFromDraft rejects an invalid password-saving option', () => {
  const built = buildVaultHostFromDraft({
    hostname: '10.0.0.20',
    savePassword: 'sometimes',
  });

  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /true or false/i);
});

test('buildVaultHostFromDraft rejects non-integer ports instead of changing them', () => {
  for (const port of [22.9, '22.9', '22oops']) {
    const built = buildVaultHostFromDraft({ hostname: '10.0.0.20', port });

    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /integer between 1 and 65535/i);
  }
});

test('buildVaultHostFromDraft rejects an unsupported protocol instead of using SSH', () => {
  const built = buildVaultHostFromDraft({ hostname: '10.0.0.20', protocol: 'ftp' });

  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.error, /ssh, telnet, or local/i);
});

test('buildVaultHostFromDraft rejects hostnames containing internal whitespace', () => {
  for (const hostname of ['db prod.example.com', 'db\tprod.example.com']) {
    const built = buildVaultHostFromDraft({ hostname });

    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /must not contain whitespace/i);
  }
});

test('buildVaultHostFromDraft rejects invalid host objects and optional field types', () => {
  const invalidDraft = buildVaultHostFromDraft(null as unknown as VaultHostDraft);
  const invalidKeyPath = buildVaultHostFromDraft({ hostname: 'host.example.com', keyPath: 123 });

  assert.equal(invalidDraft.ok, false);
  assert.equal(invalidKeyPath.ok, false);
  if (!invalidDraft.ok) assert.match(invalidDraft.error, /must be an object/i);
  if (!invalidKeyPath.ok) assert.match(invalidKeyPath.error, /keyPath must be a string/i);
});

test('buildVaultHostFromDraft rejects SSH config line injection', () => {
  for (const draft of [
    { hostname: 'host.example.com', username: 'root\nProxyCommand /tmp/run' },
    { hostname: 'host.example.com', keyPath: '~/.ssh/id\rProxyCommand /tmp/run' },
    { hostname: 'host.example.com\0ProxyCommand /tmp/run' },
  ]) {
    const built = buildVaultHostFromDraft(draft);
    assert.equal(built.ok, false);
    if (built.ok) continue;
    assert.match(built.error, /line breaks or null bytes/i);
  }
});

test('buildVaultHostFromDraft allows direct and Telnet usernames containing at signs', () => {
  const direct = buildVaultHostFromDraft({
    hostname: 'host.example.com',
    username: 'alice@example.com',
  });
  const telnet = buildVaultHostFromDraft({
    hostname: 'telnet.example.com',
    username: 'alice@example.com',
    protocol: 'telnet',
  });

  assert.equal(direct.ok, true);
  assert.equal(telnet.ok, true);
});

test('parseVaultHostDraftsInput accepts JSON array strings', () => {
  const parsed = parseVaultHostDraftsInput(JSON.stringify([
    { hostname: '10.0.0.1', username: 'root' },
    { hostname: '10.0.0.2', username: 'deploy', port: 2222 },
  ]));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.drafts.length, 2);
});

test('applyVaultHostCreates writes sanitized hosts into the vault list', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'db',
    hostname: '10.0.0.99',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };
  const { hosts: built } = buildVaultHostsFromDrafts([
    { hostname: '10.0.0.10', username: 'deploy', group: 'prod' },
  ]);
  const merged = applyVaultHostCreates([existing], ['legacy'], built);

  assert.equal(merged.addedCount, 1);
  assert.equal(merged.hosts.length, 2);
  assert.ok(merged.customGroups.includes('prod'));
});

test('applyVaultHostUpdate changes only provided fields and adds a new group', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'old label',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: ['keep'],
    os: 'linux',
    notes: 'old notes',
  };

  const result = applyVaultHostUpdate([existing], ['legacy'], 'host-1', {
    name: 'new label',
    host: 'server.example.com',
    port: 2222,
    group: 'prod/api',
    notes: '',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.label, 'new label');
  assert.equal(result.updatedHost.hostname, 'server.example.com');
  assert.equal(result.updatedHost.port, 2222);
  assert.equal(result.updatedHost.username, 'root');
  assert.deepEqual(result.updatedHost.tags, ['keep']);
  assert.equal(result.updatedHost.notes, undefined);
  assert.ok(result.customGroups.includes('prod/api'));
});

test('applyVaultHostUpdate rejects non-integer ports instead of changing them', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };

  for (const port of [22.9, '22.9', '22oops']) {
    const result = applyVaultHostUpdate([existing], [], existing.id, { port });

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /integer between 1 and 65535/i);
  }
});

test('applyVaultHostUpdate rejects hostnames containing internal whitespace', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'old.example.com',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
  };

  for (const hostname of ['db prod.example.com', 'db\tprod.example.com']) {
    const result = applyVaultHostUpdate([existing], [], existing.id, { hostname });

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /must not contain whitespace/i);
  }
});

test('applyVaultHostUpdate changes default ports when switching protocols', () => {
  const ssh: Host = {
    id: 'ssh',
    label: 'ssh',
    hostname: 'ssh.example.com',
    username: 'root',
    port: 22,
    protocol: 'ssh',
    tags: [],
    os: 'linux',
  };
  const telnet: Host = {
    ...ssh,
    id: 'telnet',
    label: 'telnet',
    port: 23,
    protocol: 'telnet',
  };
  const custom: Host = { ...ssh, id: 'custom', label: 'custom', port: 2222 };

  const toTelnet = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'telnet' });
  const toSsh = applyVaultHostUpdate([telnet], [], telnet.id, { protocol: 'ssh' });
  const keepCustom = applyVaultHostUpdate([custom], [], custom.id, { protocol: 'telnet' });
  const explicitPort = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'telnet', port: 2323 });

  assert.equal(toTelnet.ok, true);
  assert.equal(toSsh.ok, true);
  assert.equal(keepCustom.ok, true);
  assert.equal(explicitPort.ok, true);
  if (!toTelnet.ok || !toSsh.ok || !keepCustom.ok || !explicitPort.ok) return;
  assert.equal(toTelnet.updatedHost.port, 23);
  assert.equal(toSsh.updatedHost.port, 22);
  assert.equal(keepCustom.updatedHost.port, 2222);
  assert.equal(explicitPort.updatedHost.port, 2323);
});

test('applyVaultHostUpdate requires serial settings when switching to serial', () => {
  const ssh: Host = {
    id: 'ssh', label: 'ssh', hostname: 'ssh.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };

  const missingConfig = applyVaultHostUpdate([ssh], [], ssh.id, { protocol: 'serial' });
  assert.equal(missingConfig.ok, false);
  if (!missingConfig.ok) assert.match(missingConfig.error, /serialConfig is required/i);

  const configured = applyVaultHostUpdate([ssh], [], ssh.id, {
    protocol: 'serial',
    serialConfig: { path: '/dev/ttyUSB0', baudRate: 115200 },
  });
  assert.equal(configured.ok, true);
  if (configured.ok) {
    assert.equal(configured.updatedHost.protocol, 'serial');
    assert.equal(configured.updatedHost.serialConfig?.baudRate, 115200);
  }
});

test('applyVaultHostUpdate applies and clears advanced connection settings', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root',
    port: 22, protocol: 'ssh', tags: [], os: 'linux',
  };
  const jump: Host = {
    id: 'jump-1', label: 'jump', hostname: 'jump.example.com', username: 'root', tags: [], os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1', label: 'deploy', username: 'deploy', authMethod: 'key', keyId: 'key-1', created: 1,
  };
  const proxyProfile: ProxyProfile = {
    id: 'proxy-1', label: 'proxy', config: { type: 'socks5', host: '127.0.0.1', port: 1080 }, createdAt: 1,
  };
  const patch: VaultHostUpdatePatch = {
    protocol: 'serial',
    identityId: identity.id,
    jumpHostIds: [jump.id],
    proxyProfileId: proxyProfile.id,
    startupCommand: 'tmux attach || tmux',
    startupCommandRunMode: 'lineDelay',
    environmentVariables: [{ name: 'APP_ENV', value: 'production' }],
    moshEnabled: true,
    moshServerPath: '/usr/local/bin/mosh-server',
    etEnabled: true,
    etPort: 2022,
    serialConfig: {
      path: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'rts/cts', localEcho: true, lineMode: false,
    },
  };

  const result = applyVaultHostUpdate(
    [host, jump], [], host.id, patch,
    { identities: [identity], proxyProfiles: [proxyProfile] },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.protocol, 'serial');
  assert.equal(result.updatedHost.identityId, identity.id);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.deepEqual(result.updatedHost.hostChain, { hostIds: [jump.id] });
  assert.equal(result.updatedHost.proxyProfileId, proxyProfile.id);
  assert.equal(result.updatedHost.startupCommand, 'tmux attach || tmux');
  assert.equal(result.updatedHost.startupCommandRunMode, 'lineDelay');
  assert.deepEqual(result.updatedHost.environmentVariables, [{ name: 'APP_ENV', value: 'production' }]);
  assert.equal(result.updatedHost.moshEnabled, true);
  assert.equal(result.updatedHost.moshServerPath, '/usr/local/bin/mosh-server');
  assert.equal(result.updatedHost.etEnabled, true);
  assert.equal(result.updatedHost.etPort, 2022);
  assert.deepEqual(result.updatedHost.serialConfig, {
    path: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, stopBits: 1,
    parity: 'none', flowControl: 'rts/cts', localEcho: true, lineMode: false,
  });

  const cleared = applyVaultHostUpdate([result.updatedHost, jump], [], host.id, {
    jumpHostIds: [],
    proxyProfileId: '',
    startupCommand: '',
    startupCommandRunMode: '',
    environmentVariables: {},
    moshEnabled: false,
    moshServerPath: '',
    etEnabled: false,
  }, { identities: [identity], proxyProfiles: [proxyProfile] });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.deepEqual(cleared.updatedHost.hostChain, { hostIds: [] });
  assert.equal(cleared.updatedHost.proxyProfileId, '');
  assert.equal(cleared.updatedHost.startupCommand, '');
  assert.equal(cleared.updatedHost.startupCommandRunMode, undefined);
  assert.deepEqual(cleared.updatedHost.environmentVariables, []);
  assert.equal(cleared.updatedHost.moshEnabled, false);
  assert.equal(cleared.updatedHost.moshServerPath, undefined);
  assert.equal(cleared.updatedHost.etEnabled, false);
});

test('applyVaultHostUpdate rejects malformed advanced connection settings', () => {
  const host: Host = {
    id: 'host-1', label: 'host', hostname: 'host.example.com', username: 'root', tags: [], os: 'linux',
  };
  const jump: Host = {
    id: 'jump-1', label: 'jump', hostname: 'jump.example.com', username: 'root', tags: [], os: 'linux',
  };
  const cases: Array<{ patch: VaultHostUpdatePatch; error: RegExp }> = [
    { patch: { protocol: 'unknown' }, error: /protocol/i },
    { patch: { identityId: 42 }, error: /identityId must be a string/i },
    { patch: { identityId: 'missing' }, error: /Identity .* was not found/i },
    { patch: { jumpHostIds: '["jump-1"' }, error: /valid JSON array/i },
    { patch: { jumpHostIds: [host.id] }, error: /cannot use itself/i },
    { patch: { jumpHostIds: [jump.id, jump.id] }, error: /duplicates/i },
    { patch: { jumpHostIds: ['missing'] }, error: /Jump host .* was not found/i },
    { patch: { proxyProfileId: 'missing' }, error: /Proxy profile .* was not found/i },
    { patch: { startupCommand: 42 }, error: /startupCommand must be a string/i },
    { patch: { startupCommandRunMode: 'fast' }, error: /paste or lineDelay/i },
    { patch: { environmentVariables: '{' }, error: /valid JSON/i },
    { patch: { environmentVariables: [{ value: 'missing-name' }] }, error: /require name and value/i },
    { patch: { moshEnabled: 'maybe' }, error: /moshEnabled must be true or false/i },
    { patch: { etEnabled: 'maybe' }, error: /etEnabled must be true or false/i },
    { patch: { etPort: 0 }, error: /between 1 and 65535/i },
    { patch: { serialConfig: '{' }, error: /valid JSON/i },
    { patch: { serialConfig: {} }, error: /requires path and a positive baudRate/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, dataBits: 9 } }, error: /dataBits/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, stopBits: 3 } }, error: /stopBits/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, parity: 'bad' } }, error: /parity/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, flowControl: 'bad' } }, error: /flowControl/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, localEcho: 'maybe' } }, error: /localEcho/i },
    { patch: { serialConfig: { path: '/dev/ttyUSB0', baudRate: 9600, lineMode: 'maybe' } }, error: /lineMode/i },
  ];

  for (const entry of cases) {
    const result = applyVaultHostUpdate([host, jump], [], host.id, entry.patch, {
      identities: [], proxyProfiles: [],
    });
    assert.equal(result.ok, false, JSON.stringify(entry.patch));
    if (!result.ok) assert.match(result.error, entry.error);
  }
});

test('applyVaultHostUpdate can switch a host to a referenced key path', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    port: 22,
    tags: [],
    os: 'linux',
    password: 'secret',
    authMethod: 'password',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    keyPath: '/Users/alice/.ssh/id_ed25519',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.authMethod, 'key');
  assert.deepEqual(result.updatedHost.identityFilePaths, ['/Users/alice/.ssh/id_ed25519']);
  assert.equal(result.updatedHost.identityId, '');
});

test('applyVaultHostUpdate parses JSON array tag strings', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    tags: '["prod", "api", "prod"]',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.updatedHost.tags, ['prod', 'api']);
});

test('applyVaultHostUpdate rejects malformed JSON tag strings', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: ['keep'],
    os: 'linux',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    tags: '["prod"',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /valid JSON array/i);
});

test('applyVaultHostUpdate rejects SSH config line injection', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  for (const patch of [
    { username: 'root\nProxyCommand /tmp/run' },
    { keyPath: '~/.ssh/id\rProxyCommand /tmp/run' },
    { hostname: 'host.example.com\0ProxyCommand /tmp/run' },
    { label: 'host\nProxyCommand /tmp/run' },
  ]) {
    const result = applyVaultHostUpdate([existing], [], existing.id, patch);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.match(result.error, /line breaks or null bytes/i);
  }
});

test('applyVaultHostUpdate limits SSH syntax checks to managed aliases and active jump hosts', () => {
  const managedSource: ManagedSource = {
    id: 'source-1',
    type: 'ssh_config',
    filePath: '~/.ssh/config',
    groupName: 'managed',
    lastSyncedAt: 1,
  };
  const jump: Host = {
    id: 'jump',
    label: 'jump',
    hostname: 'jump.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
  };
  const managedTarget: Host = {
    id: 'target',
    label: 'target',
    hostname: 'target.example.com',
    username: 'root',
    group: 'managed',
    managedSourceId: managedSource.id,
    hostChain: { hostIds: [jump.id] },
    tags: [],
    os: 'linux',
  };
  const options = { managedSources: [managedSource] };

  const directUsername = applyVaultHostUpdate(
    [jump],
    [],
    jump.id,
    { username: 'alice@example.com' },
  );
  const encodedAlias = applyVaultHostUpdate(
    [managedTarget],
    [],
    managedTarget.id,
    { label: '*' },
    options,
  );
  const badJumpHostname = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { hostname: 'first.example.com,second.example.com' },
    options,
  );
  const badJumpUsername = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { username: 'user,attacker' },
    options,
  );
  const emailJumpUsername = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { username: 'alice@example.com' },
    options,
  );
  const optionLikeJumpHostname = applyVaultHostUpdate(
    [jump, managedTarget],
    [],
    jump.id,
    { hostname: '-oProxyCommand=run' },
    options,
  );
  const unsafeJump: Host = {
    ...jump,
    id: 'unsafe-jump',
    hostname: 'first.example.com,second.example.com',
  };
  const plainTarget: Host = {
    ...managedTarget,
    id: 'plain-target',
    group: undefined,
    managedSourceId: undefined,
    hostChain: { hostIds: [unsafeJump.id] },
  };
  const movedInWithUnsafeJump = applyVaultHostUpdate(
    [unsafeJump, plainTarget],
    [],
    plainTarget.id,
    { group: 'managed' },
    options,
  );

  assert.equal(directUsername.ok, true);
  assert.equal(encodedAlias.ok, true);
  assert.equal(badJumpHostname.ok, false);
  assert.equal(badJumpUsername.ok, false);
  assert.equal(emailJumpUsername.ok, true);
  assert.equal(optionLikeJumpHostname.ok, false);
  assert.equal(movedInWithUnsafeJump.ok, false);
  if (!directUsername.ok) return;
  assert.equal(directUsername.updatedHost.username, 'alice@example.com');
  if (!encodedAlias.ok) return;
  assert.equal(encodedAlias.updatedHost.label, '*');
});

test('applyVaultHostUpdate clears only the local key path when another identity is selected', () => {
  const identityHost: Host = {
    id: 'identity-host',
    label: 'identity host',
    hostname: 'identity.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };
  const keychainHost: Host = {
    id: 'keychain-host',
    label: 'keychain host',
    hostname: 'keychain.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };

  const identityResult = applyVaultHostUpdate([identityHost], [], identityHost.id, { keyPath: '' });
  const keychainResult = applyVaultHostUpdate([keychainHost], [], keychainHost.id, { keyPath: '' });

  assert.equal(identityResult.ok, true);
  assert.equal(keychainResult.ok, true);
  if (!identityResult.ok || !keychainResult.ok) return;
  assert.equal(identityResult.updatedHost.identityId, 'identity-1');
  assert.equal(identityResult.updatedHost.authMethod, 'key');
  assert.deepEqual(identityResult.updatedHost.identityFilePaths, []);
  assert.equal(keychainResult.updatedHost.identityFileId, 'key-1');
  assert.equal(keychainResult.updatedHost.authMethod, 'key');
  assert.deepEqual(keychainResult.updatedHost.identityFilePaths, []);
});

test('applyVaultHostUpdate rejects saved password changes when password saving is disabled', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    savePassword: false,
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    password: 'do-not-persist',
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not to save passwords/i);
});

test('applyVaultHostUpdate respects inherited password saving opt-out', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    'host-1',
    { password: 'do-not-persist' },
    { resolveEffectiveHost: (host) => ({ ...host, savePassword: false }) },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not to save passwords/i);
});

test('applyVaultHostUpdate switches to password auth when clearing a key path', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/old'],
    authMethod: 'key',
  };

  const result = applyVaultHostUpdate([existing], [], 'host-1', {
    password: 'new-secret',
    keyPath: '',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.authMethod, 'password');
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.identityFileId, undefined);
  assert.deepEqual(result.updatedHost.identityFilePaths, []);
});

test('applyVaultHostUpdate keeps an inherited identity username when switching to password auth', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    identityFileId: identity.keyId,
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret', savePassword: true, keyPath: '' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate preserves key login when only the password changes', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
    identityFileId: 'key-1',
    identityFilePaths: ['~/.ssh/key'],
    authMethod: 'key',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'root',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.authMethod, 'key');
  assert.equal(result.updatedHost.identityId, 'identity-1');
  assert.equal(result.updatedHost.identityFileId, 'key-1');
  assert.deepEqual(result.updatedHost.identityFilePaths, ['~/.ssh/key']);
});

test('applyVaultHostUpdate preserves an inherited key identity when the password changes', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: 'key',
    identityFileId: identity.keyId,
  });

  const updated = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'fallback' },
    { identities: [identity], resolveEffectiveHost },
  );
  const cleared = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { identities: [identity], resolveEffectiveHost },
  );
  const disabled = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { savePassword: 'false' },
    { identities: [identity], resolveEffectiveHost },
  );
  const changedUsername = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops', password: 'fallback' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(updated.ok, true);
  assert.equal(cleared.ok, true);
  assert.equal(disabled.ok, true);
  assert.equal(changedUsername.ok, true);
  if (!updated.ok || !cleared.ok || !disabled.ok || !changedUsername.ok) return;
  assert.equal(updated.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(updated.updatedHost).authMethod, 'key');
  assert.equal(cleared.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(cleared.updatedHost).authMethod, 'key');
  assert.equal(disabled.updatedHost.identityId, identity.id);
  assert.equal(resolveEffectiveHost(disabled.updatedHost).authMethod, 'key');
  assert.equal(changedUsername.updatedHost.username, 'ops');
  assert.equal(changedUsername.updatedHost.identityId, '');
});

test('applyVaultHostUpdate detaches a password identity so the new password takes effect', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'new-secret' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, 'new-secret');
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate detaches a password identity when clearing the password', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate detaches a password identity when disabling saved passwords', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'old-secret',
    created: 1,
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { savePassword: 'false' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.username, 'deploy');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate can re-enable saved passwords after clearing one', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    tags: [],
    os: 'linux',
    password: 'old-secret',
  };

  const cleared = applyVaultHostUpdate([existing], [], existing.id, { password: '' });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  const restored = applyVaultHostUpdate([cleared.updatedHost], [], existing.id, {
    password: 'new-secret',
    savePassword: 'true',
  });

  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.updatedHost.password, 'new-secret');
  assert.equal(restored.updatedHost.savePassword, true);
});

test('applyVaultHostUpdate detaches direct and inherited identities when changing username', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'old-user',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const directIdentityHost: Host = {
    id: 'direct-host',
    label: 'direct host',
    hostname: 'direct.example.com',
    username: 'old-user',
    tags: [],
    os: 'linux',
    identityId: 'identity-1',
  };
  const inheritedIdentityHost: Host = {
    id: 'inherited-host',
    label: 'inherited host',
    hostname: 'inherited.example.com',
    username: 'old-user',
    tags: [],
    os: 'linux',
  };

  const directResult = applyVaultHostUpdate(
    [directIdentityHost],
    [],
    directIdentityHost.id,
    { username: 'new-user' },
    { identities: [identity] },
  );
  const inheritedResult = applyVaultHostUpdate(
    [inheritedIdentityHost],
    [],
    inheritedIdentityHost.id,
    { username: 'new-user' },
    {
      identities: [identity],
      resolveEffectiveHost: (host) => ({ ...host, identityId: identity.id }),
    },
  );

  assert.equal(directResult.ok, true);
  assert.equal(inheritedResult.ok, true);
  if (!directResult.ok || !inheritedResult.ok) return;
  assert.equal(directResult.updatedHost.username, 'new-user');
  assert.equal(directResult.updatedHost.identityId, '');
  assert.equal(directResult.updatedHost.identityFileId, identity.keyId);
  assert.equal(directResult.updatedHost.authMethod, 'key');
  assert.equal(inheritedResult.updatedHost.username, 'new-user');
  assert.equal(inheritedResult.updatedHost.identityId, '');
  assert.equal(inheritedResult.updatedHost.identityFileId, identity.keyId);
  assert.equal(inheritedResult.updatedHost.authMethod, 'key');
});

test('applyVaultHostUpdate keeps inherited key auth across sequential password and username updates', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared key',
    username: 'deploy',
    authMethod: 'key',
    keyId: 'key-1',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: '',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    identityFileId: identity.keyId,
  });

  const first = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: 'fallback-one' },
    { identities: [identity], resolveEffectiveHost },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = applyVaultHostUpdate(
    [first.updatedHost],
    [],
    existing.id,
    { username: 'ops', password: 'fallback-two' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.updatedHost.username, 'ops');
  assert.equal(second.updatedHost.identityId, '');
  assert.equal(second.updatedHost.identityFileId, identity.keyId);
  assert.equal(second.updatedHost.authMethod, 'key');
});

test('applyVaultHostUpdate preserves a password identity credential when changing username', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'deploy',
    identityId: identity.id,
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops' },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, identity.password);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate keeps password prompts when changing username without saving the password', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: 'deploy',
    identityId: identity.id,
    tags: [],
    os: 'linux',
  };

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops', savePassword: false },
    { identities: [identity] },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate does not copy an inherited identity password when saving is disabled', () => {
  const identity: Identity = {
    id: 'identity-1',
    label: 'shared password',
    username: 'deploy',
    authMethod: 'password',
    password: 'shared-secret',
    created: 1,
  };
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: 'host.example.com',
    username: '',
    group: 'locked',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityId: identity.id,
    username: identity.username,
    authMethod: identity.authMethod,
    savePassword: false,
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { username: 'ops' },
    { identities: [identity], resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updatedHost.username, 'ops');
  assert.equal(result.updatedHost.identityId, '');
  assert.equal(result.updatedHost.password, undefined);
  assert.equal(result.updatedHost.authMethod, 'password');
});

test('applyVaultHostUpdate validates passwords against the destination group', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'open',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(
    host,
    host.group === 'locked' ? { savePassword: false } : { savePassword: true },
  );

  const blocked = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { group: 'locked', password: 'must-not-save' },
    { resolveEffectiveHost },
  );
  const allowed = applyVaultHostUpdate(
    [{ ...existing, group: 'locked' }],
    [],
    existing.id,
    { group: 'open', password: 'allowed' },
    { resolveEffectiveHost },
  );

  assert.equal(blocked.ok, false);
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  assert.equal(allowed.updatedHost.group, 'open');
  assert.equal(allowed.updatedHost.password, 'allowed');
});

test('applyVaultHostUpdate explicitly blocks an inherited password after clearing it', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    password: 'group-secret',
    savePassword: true,
    authMethod: 'password',
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { password: '' },
    { resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const effectiveAfter = resolveEffectiveHost(result.updatedHost);
  assert.equal(result.updatedHost.savePassword, false);
  assert.equal(effectiveAfter.password, undefined);
  assert.equal(effectiveAfter.savePassword, false);
});

test('applyVaultHostUpdate explicitly blocks an inherited key path after clearing it', () => {
  const existing: Host = {
    id: 'host-1',
    label: 'host',
    hostname: '10.0.0.1',
    username: 'root',
    group: 'prod',
    tags: [],
    os: 'linux',
  };
  const resolveEffectiveHost = (host: Host): Host => applyGroupDefaults(host, {
    identityFilePaths: ['~/.ssh/group-key'],
    authMethod: 'key',
  });

  const result = applyVaultHostUpdate(
    [existing],
    [],
    existing.id,
    { keyPath: '' },
    { resolveEffectiveHost },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const effectiveAfter = resolveEffectiveHost(result.updatedHost);
  assert.deepEqual(result.updatedHost.identityFilePaths, []);
  assert.deepEqual(effectiveAfter.identityFilePaths, []);
  assert.equal(effectiveAfter.authMethod, 'auto');
});

test('applyVaultHostUpdate keeps managed-source ownership aligned with group and protocol', () => {
  const managedSource: ManagedSource = {
    id: 'source-1',
    type: 'ssh_config',
    filePath: '~/.ssh/config',
    groupName: 'managed',
    lastSyncedAt: 1,
  };
  const managedHost: Host = {
    id: 'managed-host',
    label: 'managed host',
    hostname: 'managed.example.com',
    username: 'root',
    group: 'managed',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
    managedSourceId: managedSource.id,
  };
  const regularHost: Host = {
    id: 'regular-host',
    label: 'regular host',
    hostname: 'regular.example.com',
    username: 'root',
    tags: [],
    os: 'linux',
    protocol: 'ssh',
  };
  const options = { managedSources: [managedSource] };

  const movedOut = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { group: '' },
    options,
  );
  const movedIn = applyVaultHostUpdate(
    [regularHost],
    [],
    regularHost.id,
    { group: 'managed/child' },
    options,
  );
  const changedProtocol = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { protocol: 'telnet' },
    options,
  );
  const changedNotes = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { notes: 'keep the display name' },
    options,
  );
  const renamed = applyVaultHostUpdate(
    [managedHost],
    [],
    managedHost.id,
    { label: 'new managed name' },
    options,
  );

  assert.equal(movedOut.ok, true);
  assert.equal(movedIn.ok, true);
  assert.equal(changedProtocol.ok, true);
  assert.equal(changedNotes.ok, true);
  assert.equal(renamed.ok, true);
  if (!movedOut.ok || !movedIn.ok || !changedProtocol.ok || !changedNotes.ok || !renamed.ok) return;
  assert.equal(movedOut.updatedHost.managedSourceId, undefined);
  assert.equal(movedIn.updatedHost.managedSourceId, managedSource.id);
  assert.equal(movedIn.updatedHost.label, 'regularhost');
  assert.equal(changedProtocol.updatedHost.managedSourceId, undefined);
  assert.equal(changedNotes.updatedHost.label, 'managed host');
  assert.equal(renamed.updatedHost.label, 'newmanagedname');
});

test('applyVaultHostDelete removes only the requested host', () => {
  const hosts: Host[] = [
    { id: 'host-1', label: 'one', hostname: 'one', username: 'root', tags: [], os: 'linux' },
    { id: 'host-2', label: 'two', hostname: 'two', username: 'root', tags: [], os: 'linux' },
  ];

  const result = applyVaultHostDelete(hosts, 'host-1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.deletedHost.id, 'host-1');
  assert.deepEqual(result.hosts.map((host) => host.id), ['host-2']);
});
