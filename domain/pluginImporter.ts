import type { ImporterRecord, JsonValue } from '@netcatty/plugin-contract';
import { sanitizeHost } from './host';
import { isBuiltInHostProtocol, isPluginHostProtocol } from './pluginConnection';
import type { Host, Identity, Snippet, SSHKey } from './models';
import { buildVaultHostMergeKey } from './vaultHostCreate';

export interface PluginImporterDrafts {
  hosts: Host[];
  identities: Identity[];
  keys: SSHKey[];
  snippets: Snippet[];
  groups: string[];
  warnings: string[];
  errors: string[];
}

export interface PluginImporterPreviewItem {
  kind: 'host' | 'identity' | 'key' | 'snippet' | 'group';
  label: string;
  detail?: string;
}

export interface PluginImporterSafePreview {
  items: PluginImporterPreviewItem[];
  warnings: string[];
  errors: string[];
  omittedItemCount: number;
  omittedDiagnosticCount: number;
}

const visiblePreviewText = (value: string, maximum = 512): string => (
  [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
);

export function buildPluginImporterSafePreview(
  drafts: PluginImporterDrafts,
  maximumItems = 50,
  maximumDiagnostics = 20,
): PluginImporterSafePreview {
  const items: PluginImporterPreviewItem[] = [
    ...drafts.hosts.map((host): PluginImporterPreviewItem => ({
      kind: 'host',
      label: visiblePreviewText(host.label),
      detail: visiblePreviewText(host.pluginConnection?.providerId ?? host.hostname, 1024),
    })),
    ...drafts.identities.map((identity): PluginImporterPreviewItem => ({
      kind: 'identity',
      label: visiblePreviewText(identity.label),
      detail: visiblePreviewText(`${identity.username} · ${identity.authMethod}`),
    })),
    ...drafts.keys.map((key): PluginImporterPreviewItem => ({
      kind: 'key',
      label: visiblePreviewText(key.label),
      detail: visiblePreviewText(`${key.type} · ${key.source}`),
    })),
    ...drafts.snippets.map((snippet): PluginImporterPreviewItem => ({
      kind: 'snippet',
      label: visiblePreviewText(snippet.label),
      detail: visiblePreviewText(snippet.kind),
    })),
    ...drafts.groups.map((group): PluginImporterPreviewItem => ({
      kind: 'group',
      label: visiblePreviewText(group),
    })),
  ];
  const diagnostics = [
    ...drafts.warnings.map((message) => ({ kind: 'warning' as const, message: visiblePreviewText(message, 2048) })),
    ...drafts.errors.map((message) => ({ kind: 'error' as const, message: visiblePreviewText(message, 2048) })),
  ];
  const boundedDiagnostics = diagnostics.slice(0, Math.max(0, maximumDiagnostics));
  return {
    items: items.slice(0, Math.max(0, maximumItems)),
    warnings: boundedDiagnostics.filter(({ kind }) => kind === 'warning').map(({ message }) => message),
    errors: boundedDiagnostics.filter(({ kind }) => kind === 'error').map(({ message }) => message),
    omittedItemCount: Math.max(0, items.length - maximumItems),
    omittedDiagnosticCount: Math.max(0, diagnostics.length - maximumDiagnostics),
  };
}

const asObject = (value: JsonValue): Record<string, JsonValue> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
);

const stringValue = (value: JsonValue | undefined, maximum: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result && result.length <= maximum && !result.includes('\0') ? result : undefined;
};

const stringArray = (value: JsonValue | undefined, maximumItems = 128): string[] => (
  Array.isArray(value)
    ? [...new Set(value.slice(0, maximumItems).flatMap((item) => {
      const normalized = stringValue(item, 256);
      return normalized ? [normalized] : [];
    }))]
    : []
);

const normalizeHost = (value: JsonValue): Host | null => {
  const object = asObject(value);
  if (!object) return null;
  const protocolValue = stringValue(object.protocol, 192);
  if (protocolValue && !isBuiltInHostProtocol(protocolValue) && !isPluginHostProtocol(protocolValue)) return null;
  const protocol = protocolValue as Host['protocol'] | undefined;
  const pluginProtocol = isPluginHostProtocol(protocol);
  const providerId = asObject(object.pluginConnection)
    ? stringValue(asObject(object.pluginConnection)?.providerId, 192)
    : undefined;
  const hostname = stringValue(object.hostname, 1024) ?? (pluginProtocol ? providerId : undefined);
  const label = stringValue(object.label, 512) ?? hostname;
  if (!hostname || !label) return null;
  const draft = {
    ...structuredClone(object),
    id: crypto.randomUUID(),
    label,
    hostname,
    username: stringValue(object.username, 512) ?? '',
    tags: stringArray(object.tags),
    os: ['linux', 'windows', 'macos'].includes(String(object.os)) ? object.os : 'linux',
    createdAt: Date.now(),
    ephemeral: false,
    managedSourceId: undefined,
    ...(protocol ? { protocol } : {}),
  } as unknown as Host;
  const sanitized = sanitizeHost(draft);
  return sanitized.hostname && (!pluginProtocol || sanitized.pluginConnection) ? sanitized : null;
};

const normalizeIdentity = (value: JsonValue): Identity | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const username = stringValue(object.username, 512);
  const authMethod = stringValue(object.authMethod, 32);
  if (!label || !username || !['password', 'key', 'certificate'].includes(authMethod ?? '')) return null;
  return {
    id: crypto.randomUUID(),
    label,
    username,
    authMethod: authMethod as Identity['authMethod'],
    ...(typeof object.password === 'string' ? { password: object.password.slice(0, 65_536) } : {}),
    ...(stringValue(object.keyId, 256) ? { keyId: stringValue(object.keyId, 256) } : {}),
    created: Date.now(),
  };
};

const normalizeKey = (value: JsonValue): SSHKey | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const type = stringValue(object.type, 32);
  const privateKey = typeof object.privateKey === 'string' ? object.privateKey : '';
  const filePath = stringValue(object.filePath, 8192);
  if (!label || !['RSA', 'ECDSA', 'ED25519'].includes(type ?? '') || (!privateKey && !filePath)) return null;
  return {
    id: crypto.randomUUID(),
    label,
    type: type as SSHKey['type'],
    privateKey: privateKey.slice(0, 2 * 1024 * 1024),
    ...(typeof object.publicKey === 'string' ? { publicKey: object.publicKey.slice(0, 1024 * 1024) } : {}),
    ...(typeof object.certificate === 'string' ? { certificate: object.certificate.slice(0, 1024 * 1024) } : {}),
    ...(typeof object.passphrase === 'string' ? { passphrase: object.passphrase.slice(0, 65_536) } : {}),
    ...(filePath ? { filePath } : {}),
    source: filePath && !privateKey ? 'reference' : 'imported',
    category: ['key', 'certificate', 'identity'].includes(String(object.category))
      ? object.category as SSHKey['category']
      : 'key',
    created: Date.now(),
  };
};

const normalizeSnippet = (value: JsonValue): Snippet | null => {
  const object = asObject(value);
  if (!object) return null;
  const label = stringValue(object.label, 512);
  const command = typeof object.command === 'string' ? object.command : undefined;
  if (!label || !command || command.length > 1024 * 1024 || command.includes('\0')) return null;
  return {
    id: crypto.randomUUID(),
    label,
    command,
    tags: stringArray(object.tags),
    kind: object.kind === 'script' ? 'script' : 'snippet',
    ...(stringValue(object.description, 4096) ? { description: stringValue(object.description, 4096) } : {}),
  };
};

export function normalizePluginImporterRecords(records: ReadonlyArray<ImporterRecord>): PluginImporterDrafts {
  const result: PluginImporterDrafts = {
    hosts: [], identities: [], keys: [], snippets: [], groups: [], warnings: [], errors: [],
  };
  const keyIds = new Map<string, string>();
  const identityIds = new Map<string, string>();
  const sourceIds = (value: JsonValue): string | undefined => {
    const object = asObject(value);
    return object ? stringValue(object.id, 256) : undefined;
  };
  for (const record of records) {
    if (record.type === 'warning') {
      result.warnings.push(record.message);
      continue;
    }
    if (record.type === 'error') {
      result.errors.push(record.message);
      continue;
    }
    if (record.type !== 'draft') continue;
    const { kind, value } = record.draft;
    if (kind === 'group') {
      const object = asObject(value);
      const group = typeof value === 'string'
        ? stringValue(value, 512)
        : object ? stringValue(object.path ?? object.label, 512) : undefined;
      if (group) result.groups.push(group);
      else result.errors.push('Importer returned an invalid group draft.');
      continue;
    }
    const normalized = kind === 'host'
      ? normalizeHost(value)
      : kind === 'identity'
        ? normalizeIdentity(value)
        : kind === 'key'
          ? normalizeKey(value)
          : normalizeSnippet(value);
    if (!normalized) {
      result.errors.push(`Importer returned an invalid ${kind} draft.`);
      continue;
    }
    if (kind === 'host') result.hosts.push(normalized as Host);
    else if (kind === 'identity') {
      const identity = normalized as Identity;
      result.identities.push(identity);
      const sourceId = sourceIds(value);
      if (sourceId) identityIds.set(sourceId, identity.id);
    } else if (kind === 'key') {
      const key = normalized as SSHKey;
      result.keys.push(key);
      const sourceId = sourceIds(value);
      if (sourceId) keyIds.set(sourceId, key.id);
    }
    else result.snippets.push(normalized as Snippet);
  }
  result.identities = result.identities.map((identity) => ({
    ...identity,
    ...(identity.keyId && keyIds.has(identity.keyId) ? { keyId: keyIds.get(identity.keyId) } : { keyId: undefined }),
  }));
  result.hosts = result.hosts.map((host) => ({
    ...host,
    ...(host.identityId && identityIds.has(host.identityId)
      ? { identityId: identityIds.get(host.identityId) }
      : { identityId: undefined }),
    ...(host.telnetIdentityId && identityIds.has(host.telnetIdentityId)
      ? { telnetIdentityId: identityIds.get(host.telnetIdentityId) }
      : { telnetIdentityId: undefined }),
    ...(host.identityFileId && keyIds.has(host.identityFileId)
      ? { identityFileId: keyIds.get(host.identityFileId) }
      : { identityFileId: undefined }),
    ...(host.pluginConnection
      ? { pluginConnection: { ...host.pluginConnection, credentialId: undefined } }
      : {}),
  }));
  result.groups = [...new Set(result.groups)];
  return result;
}

export interface PluginImporterMergeResult {
  hosts: Host[];
  identities: Identity[];
  keys: SSHKey[];
  snippets: Snippet[];
  customGroups: string[];
  duplicateCount: number;
  addedCount: number;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

const keyFingerprint = (key: SSHKey): string => stableJson({
  type: key.type,
  privateKey: key.privateKey,
  publicKey: key.publicKey,
  certificate: key.certificate,
  filePath: key.filePath,
});

const identityFingerprint = (identity: Identity): string => stableJson({
  username: identity.username.trim().toLowerCase(),
  authMethod: identity.authMethod,
  keyId: identity.keyId,
  password: identity.password,
});

const hostFingerprint = (host: Host): string => host.pluginConnection
  ? stableJson({
    protocol: host.protocol,
    providerId: host.pluginConnection.providerId,
    authenticationProviderId: host.pluginConnection.authenticationProviderId,
    configuration: host.pluginConnection.configuration,
    username: host.username.trim().toLowerCase(),
  })
  : buildVaultHostMergeKey(host);

const snippetFingerprint = (snippet: Snippet): string => stableJson({
  label: snippet.label.trim().toLowerCase(),
  kind: snippet.kind,
  command: snippet.command,
});

export function mergePluginImporterDrafts(
  existing: Pick<PluginImporterMergeResult, 'hosts' | 'identities' | 'keys' | 'snippets' | 'customGroups'>,
  drafts: PluginImporterDrafts,
): PluginImporterMergeResult {
  let duplicateCount = 0;
  const keyByFingerprint = new Map(existing.keys.map((key) => [keyFingerprint(key), key]));
  const keyIdRemap = new Map<string, string>();
  const addedKeys: SSHKey[] = [];
  for (const key of drafts.keys) {
    const fingerprint = keyFingerprint(key);
    const duplicate = keyByFingerprint.get(fingerprint);
    if (duplicate) {
      duplicateCount += 1;
      keyIdRemap.set(key.id, duplicate.id);
      continue;
    }
    keyByFingerprint.set(fingerprint, key);
    addedKeys.push(key);
  }

  const identityByFingerprint = new Map(existing.identities.map((identity) => [identityFingerprint(identity), identity]));
  const identityIdRemap = new Map<string, string>();
  const addedIdentities: Identity[] = [];
  for (const source of drafts.identities) {
    const identity = source.keyId && keyIdRemap.has(source.keyId)
      ? { ...source, keyId: keyIdRemap.get(source.keyId) }
      : source;
    const fingerprint = identityFingerprint(identity);
    const duplicate = identityByFingerprint.get(fingerprint);
    if (duplicate) {
      duplicateCount += 1;
      identityIdRemap.set(source.id, duplicate.id);
      continue;
    }
    identityByFingerprint.set(fingerprint, identity);
    addedIdentities.push(identity);
  }

  const hostFingerprints = new Set(existing.hosts.map(hostFingerprint));
  const addedHosts: Host[] = [];
  for (const source of drafts.hosts) {
    const host = sanitizeHost({
      ...source,
      ...(source.identityId && identityIdRemap.has(source.identityId)
        ? { identityId: identityIdRemap.get(source.identityId) }
        : {}),
      ...(source.telnetIdentityId && identityIdRemap.has(source.telnetIdentityId)
        ? { telnetIdentityId: identityIdRemap.get(source.telnetIdentityId) }
        : {}),
      ...(source.identityFileId && keyIdRemap.has(source.identityFileId)
        ? { identityFileId: keyIdRemap.get(source.identityFileId) }
        : {}),
    });
    const fingerprint = hostFingerprint(host);
    if (hostFingerprints.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    hostFingerprints.add(fingerprint);
    addedHosts.push(host);
  }

  const snippetFingerprints = new Set(existing.snippets.map(snippetFingerprint));
  const addedSnippets = drafts.snippets.filter((snippet) => {
    const fingerprint = snippetFingerprint(snippet);
    if (snippetFingerprints.has(fingerprint)) {
      duplicateCount += 1;
      return false;
    }
    snippetFingerprints.add(fingerprint);
    return true;
  });
  const customGroups = [...new Set([
    ...existing.customGroups,
    ...drafts.groups,
    ...addedHosts.flatMap((host) => host.group ? [host.group] : []),
  ])];
  const addedCount = addedKeys.length + addedIdentities.length + addedHosts.length + addedSnippets.length
    + Math.max(0, customGroups.length - existing.customGroups.length);
  return {
    keys: [...existing.keys, ...addedKeys],
    identities: [...existing.identities, ...addedIdentities],
    hosts: [...existing.hosts, ...addedHosts],
    snippets: [...existing.snippets, ...addedSnippets],
    customGroups,
    duplicateCount,
    addedCount,
  };
}
