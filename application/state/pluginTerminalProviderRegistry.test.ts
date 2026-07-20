import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginTerminalProviderRegistry } from './pluginTerminalProviderRegistry.ts';

const session: NetcattyTerminalSessionSnapshot = {
  sessionId: 'session-1',
  protocol: 'ssh',
  status: 'connected',
};

test('terminal Provider registry cancels superseded requests and suppresses stale results', async () => {
  const cancellations: string[] = [];
  const resolvers: Array<(value: ReadonlyArray<NetcattyTerminalProviderResult>) => void> = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    providePluginTerminal() {
      return new Promise((resolve) => resolvers.push(resolve));
    },
    async cancelPluginTerminalRequest(requestId) { cancellations.push(requestId); return true; },
    async publishPluginTerminalSessionEvent() { return []; },
  });

  const first = registry.request({
    kind: 'terminal.completion',
    operation: 'provideCompletions',
    session,
    payload: { input: 'g' },
  });
  const second = registry.request({
    kind: 'terminal.completion',
    operation: 'provideCompletions',
    session,
    payload: { input: 'gi' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellations.length, 1);
  resolvers[1]([]);
  const secondResult = await second;
  resolvers[0]([]);
  const firstResult = await first;
  assert.equal(secondResult.stale, false);
  assert.equal(firstResult.stale, true);
  assert.deepEqual(firstResult.results, []);
});

test('terminal Provider registry returns a stale response when a superseded bridge request rejects', async () => {
  const resolvers: Array<{
    resolve: (value: ReadonlyArray<NetcattyTerminalProviderResult>) => void;
    reject: (error: Error) => void;
  }> = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    providePluginTerminal() {
      return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
    },
    async cancelPluginTerminalRequest() { return true; },
    async publishPluginTerminalSessionEvent() { return []; },
  });
  const first = registry.request({
    kind: 'terminal.decoration',
    operation: 'provideDecorations',
    session,
  });
  const second = registry.request({
    kind: 'terminal.decoration',
    operation: 'provideDecorations',
    session,
  });
  resolvers[1].resolve([]);
  assert.equal((await second).stale, false);
  resolvers[0].reject(new Error('cancelled'));
  const firstResult = await first;
  assert.equal(firstResult.stale, true);
  assert.deepEqual(firstResult.results, []);
});

test('terminal Provider registry freezes enumeration and cancels all session requests', async () => {
  const cancellations: string[] = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() {
      return [{
        pluginId: 'com.example',
        pluginVersion: '1.0.0',
        pluginDisplayName: 'Example',
        provider: { id: 'com.example.completion', label: 'Completion', kind: 'terminal.completion' },
      }];
    },
    providePluginTerminal() { return new Promise(() => {}); },
    async cancelPluginTerminalRequest(requestId) { cancellations.push(requestId); return true; },
    async publishPluginTerminalSessionEvent() { return []; },
  });
  const providers = await registry.listProviders({ kind: 'terminal.completion' });
  assert.equal(Object.isFrozen(providers), true);
  assert.equal(Object.isFrozen(providers[0].provider), true);
  void registry.request({ kind: 'terminal.completion', operation: 'provide', session });
  void registry.request({ kind: 'terminal.decoration', operation: 'provide', session });
  registry.cancelSession(session.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellations.length, 2);
});

test('terminal Provider registry publishes metadata-only lifecycle snapshots', async () => {
  const events: NetcattyTerminalSessionEvent[] = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    async providePluginTerminal() { return []; },
    async cancelPluginTerminalRequest() { return false; },
    async publishPluginTerminalSessionEvent(event) { events.push(event); return []; },
  });
  await registry.publishSessionEvent({ type: 'connected', session });
  await registry.publishSessionEvent({
    type: 'cwdChanged',
    session: { sessionId: session.sessionId, protocol: 'ssh', status: 'connected', cwd: '/srv/app' },
  });
  assert.deepEqual(events, [
    { type: 'connected', session },
    { type: 'cwdChanged', session: { ...session, cwd: '/srv/app' } },
  ]);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.equal(Object.isFrozen(events[0].session), true);
});

test('terminal Provider lifecycle clears optional fields instead of retaining stale metadata', async () => {
  const events: NetcattyTerminalSessionEvent[] = [];
  const requests: NetcattyTerminalProviderRequest[] = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    async providePluginTerminal(request) { requests.push(request); return []; },
    async cancelPluginTerminalRequest() { return false; },
    async publishPluginTerminalSessionEvent(event) { events.push(event); return []; },
  });
  await registry.publishSessionEvent({
    type: 'created',
    session: { ...session, cwd: '/srv/app', title: 'Application' },
  });
  await registry.publishSessionEvent({ type: 'cwdChanged', session });
  await registry.publishSessionEvent({ type: 'titleChanged', session });
  await registry.request({
    kind: 'terminal.completion',
    operation: 'provide',
    session,
  });
  assert.equal(Object.hasOwn(events[1].session, 'cwd'), false);
  assert.equal(Object.hasOwn(events[1].session, 'title'), true);
  assert.equal(Object.hasOwn(events[2].session, 'cwd'), false);
  assert.equal(Object.hasOwn(events[2].session, 'title'), false);
  assert.equal(Object.hasOwn(requests[0].session, 'cwd'), false);
  assert.equal(Object.hasOwn(requests[0].session, 'title'), false);
});

test('terminal Provider reconnect lifecycle clears omitted connection-scoped metadata', async () => {
  const events: NetcattyTerminalSessionEvent[] = [];
  const requests: NetcattyTerminalProviderRequest[] = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    async providePluginTerminal(request) { requests.push(request); return []; },
    async cancelPluginTerminalRequest() { return false; },
    async publishPluginTerminalSessionEvent(event) { events.push(event); return []; },
  });
  await registry.publishSessionEvent({
    type: 'connected',
    session: { ...session, cwd: '/srv/app', title: 'Application', alternateScreen: true },
  });
  await registry.publishSessionEvent({ type: 'disconnected', session: { ...session, status: 'disconnected' } });
  await registry.publishSessionEvent({ type: 'reconnected', session });
  await registry.request({ kind: 'terminal.completion', operation: 'provide', session });

  for (const event of events.slice(1)) {
    assert.equal(Object.hasOwn(event.session, 'cwd'), false);
    assert.equal(Object.hasOwn(event.session, 'title'), false);
    assert.equal(Object.hasOwn(event.session, 'alternateScreen'), false);
  }
  assert.equal(Object.hasOwn(requests[0].session, 'cwd'), false);
  assert.equal(Object.hasOwn(requests[0].session, 'title'), false);
  assert.equal(Object.hasOwn(requests[0].session, 'alternateScreen'), false);
});

test('terminal Provider requests merge the latest lifecycle snapshot before invocation', async () => {
  const requests: NetcattyTerminalProviderRequest[] = [];
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    async providePluginTerminal(request) { requests.push(request); return []; },
    async cancelPluginTerminalRequest() { return false; },
    async publishPluginTerminalSessionEvent() { return []; },
  });
  await registry.publishSessionEvent({
    type: 'created',
    session: { ...session, workspaceId: 'workspace-1', title: 'Initial title', cols: 100, rows: 30 },
  });
  await registry.request({
    kind: 'terminal.completion',
    operation: 'provide',
    session: { ...session, cwd: '/srv/app' },
  });
  assert.deepEqual(requests[0].session, {
    ...session,
    workspaceId: 'workspace-1',
    title: 'Initial title',
    cols: 100,
    rows: 30,
    cwd: '/srv/app',
  });
  assert.equal(Object.isFrozen(requests[0].session), true);
});

test('terminal Provider registry forwards contribution lifecycle invalidation', () => {
  let bridgeListener: (() => void) | undefined;
  let disposed = false;
  const registry = new PluginTerminalProviderRegistry({
    async listPluginTerminalProviders() { return []; },
    async providePluginTerminal() { return []; },
    async cancelPluginTerminalRequest() { return false; },
    async publishPluginTerminalSessionEvent() { return []; },
    onPluginContributionsChanged(listener) {
      bridgeListener = listener;
      return () => { disposed = true; };
    },
  });
  let changes = 0;
  const unsubscribe = registry.onDidChangeProviders(() => { changes += 1; });
  bridgeListener?.();
  assert.equal(changes, 1);
  unsubscribe();
  bridgeListener?.();
  assert.equal(changes, 1);
  registry.dispose();
  assert.equal(disposed, true);
});
