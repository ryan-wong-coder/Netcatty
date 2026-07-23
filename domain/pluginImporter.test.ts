import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPluginImporterSafePreview,
  mergePluginImporterDrafts,
  normalizePluginImporterRecords,
} from './pluginImporter.ts';

test('plugin importer drafts receive host-owned identities and reject malformed records', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'host', value: { id: 'plugin-id', label: 'Prod', hostname: 'prod.test', username: 'root', tags: [], os: 'linux' } } },
    { type: 'draft', draft: { kind: 'identity', value: { id: 'plugin-id', label: 'Deploy', username: 'deploy', authMethod: 'password', password: 'secret' } } },
    { type: 'draft', draft: { kind: 'group', value: { path: 'Imported/Prod' } } },
    { type: 'draft', draft: { kind: 'snippet', value: { label: 'Broken' } } },
    { type: 'warning', message: 'Provider warning' },
  ]);
  assert.equal(result.hosts.length, 1);
  assert.notEqual(result.hosts[0].id, 'plugin-id');
  assert.equal(result.identities.length, 1);
  assert.notEqual(result.identities[0].id, 'plugin-id');
  assert.deepEqual(result.groups, ['Imported/Prod']);
  assert.deepEqual(result.warnings, ['Provider warning']);
  assert.deepEqual(result.errors, ['Importer returned an invalid snippet draft.']);
});

test('plugin importer host drafts preserve unavailable namespaced configuration', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Custom transport',
      hostname: 'opaque-target',
      username: '',
      tags: [],
      os: 'linux',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { endpoint: 'opaque-target' },
      },
    },
  } }]);
  assert.equal(result.hosts[0].protocol, 'plugin:com.example.transport.connection');
  assert.deepEqual(result.hosts[0].pluginConnection?.configuration, { endpoint: 'opaque-target' });
});

test('plugin importer host drafts can use opaque provider configuration without an SSH hostname', () => {
  const result = normalizePluginImporterRecords([{ type: 'draft', draft: {
    kind: 'host',
    value: {
      label: 'Opaque service',
      protocol: 'plugin:com.example.transport.connection',
      pluginConnection: {
        providerId: 'com.example.transport.connection',
        configuration: { account: 'production' },
      },
    },
  } }]);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.hosts[0].hostname, 'com.example.transport.connection');
  assert.deepEqual(result.hosts[0].pluginConnection?.configuration, { account: 'production' });
});

test('plugin importer remaps provider-local key and identity references into host-owned IDs', () => {
  const result = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'provider-key', label: 'Key', type: 'ED25519', privateKey: 'private',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'provider-identity', label: 'Identity', username: 'root', authMethod: 'key', keyId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Host', hostname: 'host.test', identityId: 'provider-identity', identityFileId: 'provider-key',
    } } },
  ]);
  assert.equal(result.identities[0].keyId, result.keys[0].id);
  assert.equal(result.hosts[0].identityId, result.identities[0].id);
  assert.equal(result.hosts[0].identityFileId, result.keys[0].id);
});

test('plugin importer merge skips duplicates and remaps relationships to retained Vault records', () => {
  const records = [
    { type: 'draft', draft: { kind: 'key', value: {
      id: 'provider-key', label: 'Key', type: 'ED25519', privateKey: 'private',
    } } },
    { type: 'draft', draft: { kind: 'identity', value: {
      id: 'provider-identity', label: 'Identity', username: 'root', authMethod: 'key', keyId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'host', value: {
      label: 'Host', hostname: 'host.test', username: 'root', identityId: 'provider-identity', identityFileId: 'provider-key',
    } } },
    { type: 'draft', draft: { kind: 'snippet', value: {
      label: 'Check', command: 'uptime',
    } } },
  ] as const;
  const existingDrafts = normalizePluginImporterRecords(records);
  const duplicateDrafts = normalizePluginImporterRecords(records);
  const merged = mergePluginImporterDrafts({
    hosts: existingDrafts.hosts,
    identities: existingDrafts.identities,
    keys: existingDrafts.keys,
    snippets: existingDrafts.snippets,
    customGroups: [],
  }, duplicateDrafts);
  assert.equal(merged.duplicateCount, 4);
  assert.equal(merged.addedCount, 0);
  assert.equal(merged.keys.length, 1);
  assert.equal(merged.identities.length, 1);
  assert.equal(merged.hosts.length, 1);
  assert.equal(merged.snippets.length, 1);
});

test('plugin importer preview is bounded and never exposes secret or command payloads', () => {
  const drafts = normalizePluginImporterRecords([
    { type: 'draft', draft: { kind: 'identity', value: {
      label: 'Deploy\nidentity', username: 'root', authMethod: 'password', password: 'do-not-render',
    } } },
    { type: 'draft', draft: { kind: 'key', value: {
      label: 'Production key', type: 'ED25519', privateKey: 'private-key-material', passphrase: 'secret',
    } } },
    { type: 'draft', draft: { kind: 'snippet', value: {
      label: 'Restart service', command: 'contains-sensitive-command',
    } } },
    { type: 'warning', message: 'Check\nsource' },
    { type: 'error', message: 'Invalid\tentry' },
  ]);
  const preview = buildPluginImporterSafePreview(drafts, 2, 1);
  assert.deepEqual(preview.items, [
    { kind: 'identity', label: 'Deploy identity', detail: 'root · password' },
    { kind: 'key', label: 'Production key', detail: 'ED25519 · imported' },
  ]);
  assert.deepEqual(preview.warnings, ['Check source']);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.omittedItemCount, 1);
  assert.equal(preview.omittedDiagnosticCount, 1);
  assert.equal(JSON.stringify(preview).includes('do-not-render'), false);
  assert.equal(JSON.stringify(preview).includes('private-key-material'), false);
  assert.equal(JSON.stringify(preview).includes('contains-sensitive-command'), false);
});
