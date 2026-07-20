export interface PluginTerminalProviderBridge {
  listPluginTerminalProviders(options: NetcattyTerminalProviderQuery): Promise<ReadonlyArray<NetcattyTerminalProviderContribution>>;
  providePluginTerminal(request: NetcattyTerminalProviderRequest): Promise<ReadonlyArray<NetcattyTerminalProviderResult>>;
  cancelPluginTerminalRequest(requestId: string): Promise<boolean>;
  publishPluginTerminalSessionEvent(event: NetcattyTerminalSessionEvent): Promise<ReadonlyArray<{ pluginId: string; delivered: boolean }>>;
  onPluginContributionsChanged?(callback: () => void): () => void;
}

export interface PluginTerminalProviderResponse {
  readonly requestId: string;
  readonly stale: boolean;
  readonly results: ReadonlyArray<NetcattyTerminalProviderResult>;
}

function freezeValue<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone as Readonly<T>;
}

function requestKey(sessionId: string, kind: NetcattyTerminalProviderKind): string {
  return `${sessionId}\0${kind}`;
}

function createRequestId(): string {
  return `terminal-${crypto.randomUUID()}`;
}

function mergeLifecycleSessionSnapshot(
  previous: NetcattyTerminalSessionSnapshot | undefined,
  event: NetcattyTerminalSessionEvent,
): Readonly<NetcattyTerminalSessionSnapshot> {
  const session: NetcattyTerminalSessionSnapshot = { ...(previous ?? {}), ...event.session };
  if (event.type === 'cwdChanged' && !Object.hasOwn(event.session, 'cwd')) delete session.cwd;
  if (event.type === 'titleChanged' && !Object.hasOwn(event.session, 'title')) delete session.title;
  return freezeValue(session);
}

export class PluginTerminalProviderRegistry {
  readonly #bridge: PluginTerminalProviderBridge;
  readonly #activeRequests = new Map<string, string>();
  readonly #sessionSnapshots = new Map<string, NetcattyTerminalSessionSnapshot>();
  readonly #providerListeners = new Set<() => void>();
  readonly #disposeContributionListener: (() => void) | undefined;
  #disposed = false;

  constructor(bridge: PluginTerminalProviderBridge) {
    this.#bridge = bridge;
    this.#disposeContributionListener = bridge.onPluginContributionsChanged?.(() => {
      for (const listener of [...this.#providerListeners]) {
        try { listener(); } catch { /* isolate application listeners */ }
      }
    });
  }

  onDidChangeProviders(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#providerListeners.add(listener);
    return () => this.#providerListeners.delete(listener);
  }

  async listProviders(query: NetcattyTerminalProviderQuery): Promise<ReadonlyArray<NetcattyTerminalProviderContribution>> {
    if (this.#disposed) return Object.freeze([]);
    return freezeValue(await this.#bridge.listPluginTerminalProviders(query));
  }

  async request(
    request: Omit<NetcattyTerminalProviderRequest, 'requestId'>,
  ): Promise<PluginTerminalProviderResponse> {
    if (this.#disposed) return Object.freeze({ requestId: '', stale: true, results: Object.freeze([]) });
    const previousSession = this.#sessionSnapshots.get(request.session.sessionId);
    const session = freezeValue({ ...(previousSession ?? {}), ...request.session });
    this.#sessionSnapshots.set(session.sessionId, session);
    const key = requestKey(session.sessionId, request.kind);
    const previousRequestId = this.#activeRequests.get(key);
    if (previousRequestId) void this.#bridge.cancelPluginTerminalRequest(previousRequestId).catch(() => false);
    const requestId = createRequestId();
    this.#activeRequests.set(key, requestId);
    try {
      const results = freezeValue(await this.#bridge.providePluginTerminal({ ...request, session, requestId }));
      const stale = this.#disposed || this.#activeRequests.get(key) !== requestId;
      return Object.freeze({
        requestId,
        stale,
        results: stale ? Object.freeze([]) : results,
      });
    } catch (error) {
      const stale = this.#disposed || this.#activeRequests.get(key) !== requestId;
      if (stale) return Object.freeze({ requestId, stale: true, results: Object.freeze([]) });
      throw error;
    } finally {
      if (this.#activeRequests.get(key) === requestId) this.#activeRequests.delete(key);
    }
  }

  async publishSessionEvent(event: NetcattyTerminalSessionEvent): Promise<void> {
    if (this.#disposed) return;
    const previous = this.#sessionSnapshots.get(event.session.sessionId);
    const session = mergeLifecycleSessionSnapshot(previous, event);
    if (event.type === 'disposed') this.#sessionSnapshots.delete(session.sessionId);
    else this.#sessionSnapshots.set(session.sessionId, session);
    await this.#bridge.publishPluginTerminalSessionEvent(freezeValue({ ...event, session }));
  }

  cancelSession(sessionId: string): void {
    this.#sessionSnapshots.delete(sessionId);
    for (const [key, requestId] of [...this.#activeRequests]) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      this.#activeRequests.delete(key);
      void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const requestId of this.#activeRequests.values()) {
      void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
    }
    this.#activeRequests.clear();
    this.#sessionSnapshots.clear();
    this.#providerListeners.clear();
    this.#disposeContributionListener?.();
  }
}

export function createWindowPluginTerminalProviderRegistry(
  bridge: NetcattyBridge | undefined = typeof window === 'undefined' ? undefined : netcattyBridge.get(),
): PluginTerminalProviderRegistry | null {
  if (!bridge?.listPluginTerminalProviders
    || !bridge.providePluginTerminal
    || !bridge.cancelPluginTerminalRequest
    || !bridge.publishPluginTerminalSessionEvent) return null;
  return new PluginTerminalProviderRegistry({
    listPluginTerminalProviders: (options) => bridge.listPluginTerminalProviders!(options),
    providePluginTerminal: (request) => bridge.providePluginTerminal!(request),
    cancelPluginTerminalRequest: (requestId) => bridge.cancelPluginTerminalRequest!(requestId),
    publishPluginTerminalSessionEvent: (event) => bridge.publishPluginTerminalSessionEvent!(event),
    onPluginContributionsChanged: bridge.onPluginContributionsChanged
      ? (callback) => bridge.onPluginContributionsChanged!(callback)
      : undefined,
  });
}

let windowRegistry: PluginTerminalProviderRegistry | null | undefined;

export function getWindowPluginTerminalProviderRegistry(): PluginTerminalProviderRegistry | null {
  if (windowRegistry !== undefined) return windowRegistry;
  if (typeof window === 'undefined') return null;
  windowRegistry = createWindowPluginTerminalProviderRegistry(netcattyBridge.get());
  return windowRegistry;
}
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
