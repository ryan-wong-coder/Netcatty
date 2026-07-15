import type { Host, HostProtocol, Identity, ManagedSource } from './models';
import { sanitizeHost } from './host';

const DEFAULT_SSH_PORT = 22;
const UNSAFE_SSH_CONFIG_VALUE = /[\r\n\0]/;

const isSafeSshConfigValue = (value: string): boolean =>
  !UNSAFE_SSH_CONFIG_VALUE.test(value);

export type VaultHostDraftProtocol = Exclude<HostProtocol, 'mosh' | 'et' | 'serial'>;

export interface VaultHostDraft {
  label?: unknown;
  name?: unknown;
  hostname?: unknown;
  host?: unknown;
  ip?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  savePassword?: unknown;
  keyPath?: unknown;
  keypath?: unknown;
  group?: unknown;
  tags?: unknown;
  notes?: unknown;
  protocol?: unknown;
}

export type VaultHostUpdatePatch = VaultHostDraft;

export interface VaultHostUpdateOptions {
  resolveEffectiveHost?: (host: Host) => Host;
  managedSources?: ManagedSource[];
  identities?: Identity[];
}

export interface VaultHostCreateIssue {
  index: number;
  error: string;
}

const normalizeGroupPath = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.replace(/\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts.join('/') : undefined;
};

const normalizeProtocol = (raw: unknown): VaultHostDraftProtocol | undefined => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'ssh' || value === 'ssh2') return 'ssh';
  if (value === 'telnet') return 'telnet';
  if (value === 'local') return 'local';
  return undefined;
};

const parsePort = (raw: unknown): number | undefined => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const port = Math.trunc(raw);
    return port >= 1 && port <= 65535 ? port : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const port = parseInt(trimmed, 10);
  return Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined;
};

const parseBoolean = (raw: unknown): boolean | undefined => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
};

const normalizeTags = (values: unknown[]): string[] => Array.from(
  new Set(values.map((entry) => String(entry).trim()).filter(Boolean)),
);

const parseTags = (
  raw: unknown,
): { ok: true; tags: string[] } | { ok: false; error: string } => {
  if (raw === undefined || raw === null || raw === '') return { ok: true, tags: [] };
  if (Array.isArray(raw)) return { ok: true, tags: normalizeTags(raw) };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'tags must be an array or comma-separated string.' };
  }

  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, tags: [] };
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'tags JSON must be an array.' };
      }
      return { ok: true, tags: normalizeTags(parsed) };
    } catch {
      return { ok: false, error: 'tags must be a valid JSON array.' };
    }
  }

  return {
    ok: true,
    tags: normalizeTags(trimmed.split(/[,;，]/g)),
  };
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const firstProvided = (
  value: Record<string, unknown>,
  keys: string[],
): { provided: boolean; value?: unknown } => {
  for (const key of keys) {
    if (hasOwn(value, key)) return { provided: true, value: value[key] };
  }
  return { provided: false };
};

const parseKeyPath = (draft: VaultHostDraft): string | undefined => {
  const raw = draft.keyPath ?? draft.keypath;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
};

export const buildVaultHostMergeKey = (
  host: Pick<Host, 'hostname' | 'port' | 'username' | 'protocol'>,
): string =>
  `${(host.protocol ?? 'ssh').toLowerCase()}|${host.hostname.toLowerCase()}|${host.port}|${(host.username ?? '').toLowerCase()}`;

export function buildVaultHostFromDraft(
  draft: VaultHostDraft,
): { ok: true; host: Host } | { ok: false; error: string } {
  const rawHostname = draft.hostname ?? draft.host ?? draft.ip;
  const hostname = typeof rawHostname === 'string' ? rawHostname.trim() : '';
  if (!hostname) {
    return { ok: false, error: 'hostname is required.' };
  }
  if (!isSafeSshConfigValue(hostname)) {
    return { ok: false, error: 'hostname must not contain line breaks or null bytes.' };
  }

  const protocol = normalizeProtocol(draft.protocol) ?? 'ssh';
  const port = parsePort(draft.port) ?? (protocol === 'telnet' ? 23 : DEFAULT_SSH_PORT);
  const rawLabel = draft.label ?? draft.name;
  const label = typeof rawLabel === 'string' && rawLabel.trim()
    ? rawLabel.trim()
    : hostname;
  const username = typeof draft.username === 'string' ? draft.username.trim() : '';
  if (!isSafeSshConfigValue(label)) {
    return { ok: false, error: 'label must not contain line breaks or null bytes.' };
  }
  if (!isSafeSshConfigValue(username)) {
    return { ok: false, error: 'username must not contain line breaks or null bytes.' };
  }
  const savePasswordInput = firstProvided(draft as Record<string, unknown>, ['savePassword']);
  const savePassword = savePasswordInput.provided
    ? parseBoolean(savePasswordInput.value)
    : undefined;
  if (savePasswordInput.provided && savePassword === undefined) {
    return { ok: false, error: 'savePassword must be true or false.' };
  }
  const password = savePassword !== false && typeof draft.password === 'string' && draft.password
    ? draft.password
    : undefined;
  const keyPath = parseKeyPath(draft);
  if (keyPath && !isSafeSshConfigValue(keyPath)) {
    return { ok: false, error: 'keyPath must not contain line breaks or null bytes.' };
  }
  const tags = parseTags(draft.tags);
  if (!tags.ok) return tags;
  const notes = typeof draft.notes === 'string' && draft.notes.trim() ? draft.notes.trim() : undefined;
  const now = Date.now();

  return {
    ok: true,
    host: {
      id: crypto.randomUUID(),
      label,
      hostname,
      port,
      username,
      password,
      ...(savePassword !== undefined ? { savePassword } : {}),
      group: normalizeGroupPath(draft.group),
      tags: tags.tags,
      os: 'linux',
      protocol,
      createdAt: now,
      ...(keyPath
        ? {
          identityFilePaths: [keyPath],
          authMethod: 'key' as const,
          authPolicyVersion: 1 as const,
          useSshAgent: false,
        }
        : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

export function applyVaultHostUpdate(
  existingHosts: Host[],
  existingGroups: string[],
  hostId: string,
  patch: VaultHostUpdatePatch,
  options: VaultHostUpdateOptions = {},
): {
  ok: true;
  hosts: Host[];
  customGroups: string[];
  updatedHost: Host;
} | { ok: false; error: string } {
  const hostIndex = existingHosts.findIndex((host) => host.id === hostId);
  if (hostIndex < 0) return { ok: false, error: `Host "${hostId}" was not found.` };

  const source = patch as Record<string, unknown>;
  const label = firstProvided(source, ['label', 'name']);
  const hostname = firstProvided(source, ['hostname', 'host', 'ip']);
  const port = firstProvided(source, ['port']);
  const username = firstProvided(source, ['username']);
  const password = firstProvided(source, ['password']);
  const savePassword = firstProvided(source, ['savePassword']);
  const keyPath = firstProvided(source, ['keyPath', 'keypath']);
  const group = firstProvided(source, ['group']);
  const tags = firstProvided(source, ['tags']);
  const notes = firstProvided(source, ['notes']);
  const protocol = firstProvided(source, ['protocol']);
  const provided = [label, hostname, port, username, password, savePassword, keyPath, group, tags, notes, protocol]
    .some((entry) => entry.provided);
  if (!provided) return { ok: false, error: 'At least one host field is required.' };

  const current = existingHosts[hostIndex];
  let updated: Host = { ...current };

  if (label.provided) {
    if (typeof label.value !== 'string' || !label.value.trim()) {
      return { ok: false, error: 'label must not be empty.' };
    }
    if (!isSafeSshConfigValue(label.value)) {
      return { ok: false, error: 'label must not contain line breaks or null bytes.' };
    }
    updated.label = label.value.trim();
  }
  if (hostname.provided) {
    if (typeof hostname.value !== 'string' || !hostname.value.trim()) {
      return { ok: false, error: 'hostname must not be empty.' };
    }
    if (!isSafeSshConfigValue(hostname.value)) {
      return { ok: false, error: 'hostname must not contain line breaks or null bytes.' };
    }
    updated.hostname = hostname.value.trim();
  }
  if (port.provided) {
    const parsedPort = parsePort(port.value);
    if (parsedPort === undefined) {
      return { ok: false, error: 'port must be between 1 and 65535.' };
    }
    updated.port = parsedPort;
  }
  if (group.provided) {
    if (typeof group.value !== 'string') {
      return { ok: false, error: 'group must be a string.' };
    }
    updated.group = normalizeGroupPath(group.value);
  }
  if (protocol.provided) {
    const nextProtocol = normalizeProtocol(protocol.value);
    if (!nextProtocol) {
      return { ok: false, error: 'protocol must be ssh, telnet, or local.' };
    }
    updated.protocol = nextProtocol;
  }

  const effectiveBeforeSavePassword = options.resolveEffectiveHost?.(updated) ?? updated;

  if (savePassword.provided) {
    const nextSavePassword = parseBoolean(savePassword.value);
    if (nextSavePassword === undefined) {
      return { ok: false, error: 'savePassword must be true or false.' };
    }
    updated.savePassword = nextSavePassword;
    if (!nextSavePassword) updated.password = undefined;
  }

  const effectiveCurrent = options.resolveEffectiveHost?.(updated) ?? updated;
  const selectedIdentityId = effectiveCurrent.identityId ?? effectiveBeforeSavePassword.identityId;
  const selectedIdentity = selectedIdentityId
    ? options.identities?.find((identity) => identity.id === selectedIdentityId)
    : undefined;

  if (username.provided) {
    if (typeof username.value !== 'string') {
      return { ok: false, error: 'username must be a string.' };
    }
    if (!isSafeSshConfigValue(username.value)) {
      return { ok: false, error: 'username must not contain line breaks or null bytes.' };
    }
    updated.username = username.value.trim();
    if (selectedIdentityId) {
      updated.identityId = '';
      if (selectedIdentity?.authMethod === 'password') {
        if (updated.savePassword === false) {
          updated.authMethod = 'auto';
        } else {
          updated.password = selectedIdentity.password;
          updated.authMethod = 'password';
        }
        updated.authPolicyVersion = 1;
      } else if (selectedIdentity?.keyId) {
        updated.identityFileId = selectedIdentity.keyId;
        updated.authMethod = selectedIdentity.authMethod;
        updated.authPolicyVersion = 1;
        updated.useSshAgent = false;
      }
    }
  }
  if (savePassword.provided && updated.savePassword === false && !username.provided && selectedIdentity) {
    if (selectedIdentity.authMethod === 'password') {
      updated.identityId = '';
      updated.username = selectedIdentity.username;
      updated.authMethod = 'password';
      updated.authPolicyVersion = 1;
    } else {
      updated.identityId = selectedIdentity.id;
      updated.authMethod = selectedIdentity.authMethod;
      updated.authPolicyVersion = 1;
    }
  }
  if (password.provided) {
    if (typeof password.value !== 'string') {
      return { ok: false, error: 'password must be a string.' };
    }
    if (password.value && effectiveCurrent.savePassword === false) {
      return {
        ok: false,
        error: 'This host is configured not to save passwords. Enable password saving before updating it.',
      };
    }
    updated.password = password.value || undefined;
    if (!password.value) {
      updated.savePassword = false;
    }
    const keyPathIsEmpty = keyPath.provided
      && typeof keyPath.value === 'string'
      && !keyPath.value.trim();
    if (password.value && keyPathIsEmpty) {
      if (selectedIdentity && !username.provided) {
        updated.username = selectedIdentity.username;
      }
      updated.authMethod = 'password';
      updated.authPolicyVersion = 1;
      updated.identityId = '';
      updated.identityFileId = undefined;
      updated.identityFilePaths = undefined;
      updated.useSshAgent = false;
    } else if (selectedIdentityId) {
      if (selectedIdentity?.authMethod === 'password') {
        updated.identityId = '';
        updated.username = username.provided
          ? updated.username
          : selectedIdentity.username;
        updated.authMethod = 'password';
        updated.authPolicyVersion = 1;
      } else if (selectedIdentity && !username.provided) {
        updated.identityId = selectedIdentity.id;
        updated.authMethod = selectedIdentity.authMethod;
        updated.authPolicyVersion = 1;
      }
    }
  }
  if (keyPath.provided) {
    if (typeof keyPath.value !== 'string') {
      return { ok: false, error: 'keyPath must be a string.' };
    }
    const nextKeyPath = keyPath.value.trim();
    if (!isSafeSshConfigValue(nextKeyPath)) {
      return { ok: false, error: 'keyPath must not contain line breaks or null bytes.' };
    }
    updated.identityFilePaths = nextKeyPath ? [nextKeyPath] : [];
    if (nextKeyPath) {
      updated.identityFileId = undefined;
      updated.identityId = '';
      updated.authMethod = 'key';
      updated.authPolicyVersion = 1;
      updated.useSshAgent = false;
    } else if (
      !updated.identityId
      && !updated.identityFileId
      && !effectiveCurrent.identityId
      && !effectiveCurrent.identityFileId
      && updated.authMethod !== 'password'
      && effectiveCurrent.authMethod === 'key'
    ) {
      updated.authMethod = 'auto';
      updated.authPolicyVersion = 1;
      updated.useSshAgent = undefined;
    }
  }
  if (tags.provided) {
    const nextTags = parseTags(tags.value);
    if (!nextTags.ok) return nextTags;
    updated.tags = nextTags.tags;
  }
  if (notes.provided) {
    if (typeof notes.value !== 'string') {
      return { ok: false, error: 'notes must be a string.' };
    }
    updated.notes = notes.value.trim() || undefined;
  }
  if (options.managedSources) {
    const targetManagedSource = options.managedSources
      .filter((sourceInfo) => (
        updated.group === sourceInfo.groupName
        || updated.group?.startsWith(`${sourceInfo.groupName}/`)
      ))
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];
    const canBeManaged = !updated.protocol || updated.protocol === 'ssh';
    if (targetManagedSource && canBeManaged) {
      if (label.provided || current.managedSourceId !== targetManagedSource.id) {
        updated.label = updated.label.replace(/\s/g, '');
      }
      updated.managedSourceId = targetManagedSource.id;
    } else if (options.managedSources.length > 0 || !canBeManaged) {
      updated.managedSourceId = undefined;
    }
  }

  updated = sanitizeHost(updated);
  const hosts = [...existingHosts];
  hosts[hostIndex] = updated;
  const customGroups = updated.group
    ? Array.from(new Set([...existingGroups, updated.group]))
    : [...existingGroups];
  return { ok: true, hosts, customGroups, updatedHost: updated };
}

export function applyVaultHostDelete(
  existingHosts: Host[],
  hostId: string,
): { ok: true; hosts: Host[]; deletedHost: Host } | { ok: false; error: string } {
  const deletedHost = existingHosts.find((host) => host.id === hostId);
  if (!deletedHost) return { ok: false, error: `Host "${hostId}" was not found.` };
  return {
    ok: true,
    hosts: existingHosts.filter((host) => host.id !== hostId),
    deletedHost,
  };
}

export function parseVaultHostDraftsInput(
  value: unknown,
): { ok: true; drafts: VaultHostDraft[] } | { ok: false; error: string } {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: 'hosts is required.' };
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false, error: 'hosts must be a JSON array string.' };
    }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'hosts must be a JSON array of host objects.' };
  }
  if (parsed.length === 0) {
    return { ok: false, error: 'hosts array is empty.' };
  }

  return { ok: true, drafts: parsed as VaultHostDraft[] };
}

export function buildVaultHostsFromDrafts(
  drafts: VaultHostDraft[],
): { hosts: Host[]; issues: VaultHostCreateIssue[] } {
  const hosts: Host[] = [];
  const issues: VaultHostCreateIssue[] = [];

  drafts.forEach((draft, index) => {
    const built = buildVaultHostFromDraft(draft);
    if (!built.ok) {
      issues.push({ index, error: built.error });
      return;
    }
    hosts.push(built.host);
  });

  return { hosts, issues };
}

export function applyVaultHostCreates(
  existingHosts: Host[],
  existingGroups: string[],
  createdHosts: Host[],
  options?: { skipDuplicates?: boolean },
): {
  hosts: Host[];
  customGroups: string[];
  addedCount: number;
  skippedExistingCount: number;
  addedHosts: Host[];
} {
  const skipDuplicates = options?.skipDuplicates !== false;
  const existingKeys = new Set(existingHosts.map(buildVaultHostMergeKey));
  let newHosts = createdHosts;
  let skippedExistingCount = 0;

  if (skipDuplicates) {
    newHosts = createdHosts.filter((host) => {
      const duplicate = existingKeys.has(buildVaultHostMergeKey(host));
      if (duplicate) skippedExistingCount++;
      return !duplicate;
    });
  }

  const customGroups = Array.from(
    new Set([
      ...existingGroups,
      ...newHosts.map((host) => host.group).filter(Boolean),
    ]),
  ) as string[];

  return {
    hosts: [...existingHosts, ...newHosts].map(sanitizeHost),
    customGroups,
    addedCount: newHosts.length,
    skippedExistingCount,
    addedHosts: newHosts,
  };
}
