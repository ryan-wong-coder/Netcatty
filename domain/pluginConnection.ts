import type { HostProtocol, PluginConfigurationValue, PluginConnectionConfig } from './models';

const CONTRIBUTION_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-])*$/u;
const MAX_CONFIGURATION_BYTES = 128 * 1024;
const MAX_CONFIGURATION_DEPTH = 32;
const MAX_CONFIGURATION_ENTRIES = 4096;

export const pluginProtocolForProvider = (providerId: string): HostProtocol => `plugin:${providerId}`;

export const isPluginHostProtocol = (protocol?: string): protocol is `plugin:${string}` => (
  typeof protocol === 'string' && protocol.startsWith('plugin:') && CONTRIBUTION_ID.test(protocol.slice(7))
);

export const isSafePluginAuthenticationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
};

function validateConfiguration(value: unknown, depth: number, budget: { entries: number }): value is PluginConfigurationValue {
  if (depth > MAX_CONFIGURATION_DEPTH || ++budget.entries > MAX_CONFIGURATION_ENTRIES) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => validateConfiguration(item, depth + 1, budget));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, item]) => (
    key.length > 0
    && key.length <= 256
    && key !== '__proto__'
    && key !== 'prototype'
    && key !== 'constructor'
    && validateConfiguration(item, depth + 1, budget)
  ));
}

export function sanitizePluginConnection(
  value: unknown,
  protocol?: string,
): PluginConnectionConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PluginConnectionConfig>;
  if (typeof candidate.providerId !== 'string' || !CONTRIBUTION_ID.test(candidate.providerId)
    || candidate.providerId.length > 192
    || protocol !== pluginProtocolForProvider(candidate.providerId)
    || !validateConfiguration(candidate.configuration, 0, { entries: 0 })) {
    return undefined;
  }
  const serialized = JSON.stringify(candidate.configuration);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIGURATION_BYTES) return undefined;
  const authenticationProviderId = typeof candidate.authenticationProviderId === 'string'
    && CONTRIBUTION_ID.test(candidate.authenticationProviderId)
    && candidate.authenticationProviderId.length <= 192
    ? candidate.authenticationProviderId
    : undefined;
  const credentialId = typeof candidate.credentialId === 'string'
    && candidate.credentialId.length >= 16
    && candidate.credentialId.length <= 256
    && !candidate.credentialId.includes('\0')
    ? candidate.credentialId
    : undefined;
  return {
    providerId: candidate.providerId,
    configuration: structuredClone(candidate.configuration),
    ...(authenticationProviderId ? { authenticationProviderId } : {}),
    ...(credentialId ? { credentialId } : {}),
  };
}
