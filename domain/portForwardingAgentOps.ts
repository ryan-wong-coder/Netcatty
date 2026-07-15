import type { Host, PortForwardingRule } from './models';
import { getNextVaultOrder } from './vaultOrder';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type NewRuleValues = { id: string; now: number };

const parsePort = (value: unknown, name: string): Result<number> => {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? { ok: true, value: parsed }
    : { ok: false, error: `${name} must be an integer between 1 and 65535.` };
};

function buildRule(
  source: Record<string, unknown>,
  hosts: Host[],
  existing?: PortForwardingRule,
  newRule?: NewRuleValues,
): Result<PortForwardingRule> {
  const type = source.type === undefined ? existing?.type : String(source.type).trim();
  if (type !== 'local' && type !== 'remote' && type !== 'dynamic') {
    return { ok: false, error: 'type must be local, remote, or dynamic.' };
  }
  const localPort = parsePort(source.localPort ?? existing?.localPort, 'localPort');
  if ('error' in localPort) return { ok: false, error: localPort.error };
  const hostId = source.hostId === undefined ? existing?.hostId : String(source.hostId).trim();
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!hostId || !host) {
    return { ok: false, error: `Host "${hostId || ''}" was not found.` };
  }
  if (host.protocol === 'serial') {
    return { ok: false, error: `Host "${hostId}" does not support port forwarding.` };
  }
  const remoteHost = source.remoteHost === undefined ? existing?.remoteHost : String(source.remoteHost).trim();
  let remotePort: number | undefined;
  if (type !== 'dynamic') {
    if (!remoteHost) return { ok: false, error: 'remoteHost is required for local and remote forwarding.' };
    const parsedRemotePort = parsePort(source.remotePort ?? existing?.remotePort, 'remotePort');
    if ('error' in parsedRemotePort) return { ok: false, error: parsedRemotePort.error };
    remotePort = parsedRemotePort.value;
  }
  if (!existing && !newRule) return { ok: false, error: 'New rule id and timestamp are required.' };
  let autoStart = existing?.autoStart ?? false;
  if (source.autoStart !== undefined) {
    if (typeof source.autoStart === 'boolean') autoStart = source.autoStart;
    else {
      const normalized = String(source.autoStart).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) autoStart = true;
      else if (['false', '0', 'no'].includes(normalized)) autoStart = false;
      else return { ok: false, error: 'autoStart must be true or false.' };
    }
  }
  return {
    ok: true,
    value: {
      id: existing?.id ?? newRule!.id,
      label: String(source.label ?? existing?.label ?? `${type} ${localPort.value}`).trim() || `${type} ${localPort.value}`,
      type,
      localPort: localPort.value,
      bindAddress: String(source.bindAddress ?? existing?.bindAddress ?? '127.0.0.1').trim() || '127.0.0.1',
      ...(type === 'dynamic' ? {} : { remoteHost, remotePort }),
      hostId,
      autoStart,
      status: existing?.status ?? 'inactive',
      createdAt: existing?.createdAt ?? newRule!.now,
      order: existing?.order,
    },
  };
}

export function createPortForwardingRule(
  rules: PortForwardingRule[],
  hosts: Host[],
  source: Record<string, unknown>,
  newRule: NewRuleValues,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const built = buildRule(source, hosts, undefined, newRule);
  if ('error' in built) return { ok: false, error: built.error };
  const rule = { ...built.value, order: getNextVaultOrder(rules) };
  return { ok: true, value: { rules: [...rules, rule], rule } };
}

export function updatePortForwardingRule(
  rules: PortForwardingRule[],
  hosts: Host[],
  ruleId: string,
  source: Record<string, unknown>,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const existing = rules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
  const built = buildRule(source, hosts, existing);
  if ('error' in built) return { ok: false, error: built.error };
  const connectionChanged = (
    existing.type !== built.value.type
    || existing.localPort !== built.value.localPort
    || existing.remoteHost !== built.value.remoteHost
    || existing.remotePort !== built.value.remotePort
    || existing.bindAddress !== built.value.bindAddress
    || existing.hostId !== built.value.hostId
  );
  const updatedRule = connectionChanged
    ? { ...built.value, status: 'inactive' as const, error: undefined }
    : built.value;
  return {
    ok: true,
    value: { rules: rules.map((rule) => rule.id === ruleId ? updatedRule : rule), rule: updatedRule },
  };
}

export function duplicatePortForwardingRule(
  rules: PortForwardingRule[],
  ruleId: string,
  newRule: NewRuleValues,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const existing = rules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
  const rule: PortForwardingRule = {
    ...existing,
    id: newRule.id,
    label: `${existing.label} (Copy)`,
    status: 'inactive',
    error: undefined,
    lastUsedAt: undefined,
    createdAt: newRule.now,
    order: getNextVaultOrder(rules),
  };
  return { ok: true, value: { rules: [...rules, rule], rule } };
}
