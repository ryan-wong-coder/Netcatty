export interface HostedPluginViewState {
  id: string;
  viewId: string;
  scopeId: string;
  retainContextWhenHidden: boolean;
  tabId?: string;
}

export function reconcileClosedPluginView<T extends HostedPluginViewState>({
  current,
  retained,
  instanceId,
}: {
  current: T | null;
  retained: ReadonlyMap<string, T>;
  instanceId: string;
}): {
  current: T | null;
  retained: Map<string, T>;
  matchedCurrent: boolean;
  matchedRetained: boolean;
  closedTabId?: string;
} {
  const matchedCurrent = current?.id === instanceId;
  let matchedRetained = false;
  let retainedTabId: string | undefined;
  const nextRetained = new Map<string, T>();
  for (const [key, view] of retained) {
    if (view.id === instanceId) {
      matchedRetained = true;
      retainedTabId = view.tabId;
    }
    else nextRetained.set(key, view);
  }
  return {
    current: matchedCurrent ? null : current,
    retained: nextRetained,
    matchedCurrent,
    matchedRetained,
    ...((matchedCurrent ? current?.tabId : retainedTabId)
      ? { closedTabId: matchedCurrent ? current?.tabId : retainedTabId }
      : {}),
  };
}

export function withdrawPluginViewTab<T extends HostedPluginViewState>({
  current,
  retained,
  tabId,
}: {
  current: T | null;
  retained: ReadonlyMap<string, T>;
  tabId: string;
}): {
  current: T | null;
  retained: Map<string, T>;
  instanceIds: string[];
  matchedCurrent: boolean;
  matchedRetained: boolean;
} {
  const matchedCurrent = current?.tabId === tabId;
  let matchedRetained = false;
  const instanceIds: string[] = [];
  if (matchedCurrent && current) instanceIds.push(current.id);
  const nextRetained = new Map<string, T>();
  for (const [key, view] of retained) {
    if (view.tabId === tabId) {
      matchedRetained = true;
      instanceIds.push(view.id);
    } else {
      nextRetained.set(key, view);
    }
  }
  return {
    current: matchedCurrent ? null : current,
    retained: nextRetained,
    instanceIds,
    matchedCurrent,
    matchedRetained,
  };
}

export function rememberClosedPluginViewInstance(
  tombstones: Set<string>,
  instanceId: string,
  limit = 256,
): void {
  if (tombstones.size >= limit) {
    const oldest = tombstones.values().next().value;
    if (typeof oldest === 'string') tombstones.delete(oldest);
  }
  tombstones.add(instanceId);
}

export function consumeClosedPluginViewInstance(tombstones: Set<string>, instanceId: string): boolean {
  return tombstones.delete(instanceId);
}

export function markPluginViewOpenTokensClosed(
  openingTokens: ReadonlyMap<string, ReadonlySet<symbol>>,
  explicitlyClosedTokens: Set<symbol>,
  ownerKey: string | null | undefined,
): number {
  if (!ownerKey) return 0;
  const tokens = openingTokens.get(ownerKey);
  if (!tokens) return 0;
  for (const token of tokens) explicitlyClosedTokens.add(token);
  return tokens.size;
}
