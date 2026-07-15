import test from 'node:test';
import assert from 'node:assert/strict';

import type { Host, Identity, ManagedSource } from './models.ts';
import { applyGroupDefaults } from './groupConfig.ts';
import {
  applyVaultHostDelete,
  applyVaultHostCreates,
  applyVaultHostUpdate,
  buildVaultHostFromDraft,
  buildVaultHostsFromDrafts,
  parseVaultHostDraftsInput,
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
