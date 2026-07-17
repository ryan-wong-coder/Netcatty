import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_OUTPUT_READ_MAX_CHARS,
  type PersistedToolOutputRecord,
  type ToolOutputPersistence,
  ToolOutputStore,
} from './toolOutputStore';
import { ToolResultDedup } from './toolResultDedup';

test('ToolOutputStore stores and reads truncated output by handle', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    sessionId: 'sess-1',
    content: 'A'.repeat(50_000),
  });

  assert.ok(handle.id.startsWith('tool-output-'));
  assert.equal(handle.totalChars, 50_000);

  const head = store.read({ handleId: handle.id, mode: 'head', maxChars: 100 }, 'chat-1');
  assert.equal(head?.length, 100);

  const tail = store.read({ handleId: handle.id, mode: 'tail', maxChars: 50 }, 'chat-1');
  assert.equal(tail?.length, 50);
  assert.equal(tail, 'A'.repeat(50));

  store.prune('chat-1');
  assert.equal(store.read({ handleId: handle.id }, 'chat-1'), null);
});

test('ToolOutputStore pages large output with a hard per-read cap', () => {
  const store = new ToolOutputStore();
  const content = `${'0123456789'.repeat(3_000)}END`;
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content,
  });

  const first = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    maxChars: content.length,
  }, 'chat-1');
  assert.equal(first?.content.length, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(first?.nextOffset, TOOL_OUTPUT_READ_MAX_CHARS);
  assert.equal(first?.hasMore, true);

  const second = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    offset: first?.nextOffset,
  }, 'chat-1');
  assert.equal(second?.startOffset, first?.nextOffset);
});

test('ToolOutputStore searches stored output without returning the whole body', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: `${'noise\n'.repeat(10_000)}Unique Failure Marker\n${'more noise\n'.repeat(10_000)}`,
  });

  const result = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'unique failure marker',
  }, 'chat-1');
  assert.deepEqual(result?.matchOffsets.length, 1);
  assert.match(result?.content ?? '', /Unique Failure Marker/);
  assert.ok((result?.content.length ?? Infinity) < TOOL_OUTPUT_READ_MAX_CHARS);
});

test('ToolOutputStore search advances only past matches included in the response', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: 'match middle match tail',
  });

  const first = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'match',
    maxChars: 1,
  }, 'chat-1');
  assert.doesNotMatch(first?.content ?? '', /No matches found/);
  assert.deepEqual(first?.matchOffsets, [0]);
  assert.equal(first?.nextOffset, 5);
  assert.equal(first?.hasMore, true);

  const second = store.readChunk({
    handleId: handle.id,
    mode: 'search',
    query: 'match',
    offset: first?.nextOffset,
    maxChars: 30,
  }, 'chat-1');
  assert.deepEqual(second?.matchOffsets, [13]);
});

test('ToolOutputStore never splits a Unicode surrogate pair at page boundaries', () => {
  const store = new ToolOutputStore();
  const content = `${'a'.repeat(11_999)}😀中文结尾`;
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content,
  });

  const first = store.readChunk({ handleId: handle.id, mode: 'range' }, 'chat-1');
  assert.equal(first?.content.endsWith('\ud83d'), false);
  const second = store.readChunk({
    handleId: handle.id,
    mode: 'range',
    offset: first?.nextOffset,
  }, 'chat-1');
  assert.equal(`${first?.content}${second?.content}`, content);
});

test('ToolOutputStore enforces per-handle, session count, and TTL limits', () => {
  let now = 1_000;
  const store = new ToolOutputStore({
    maxHandleChars: 20,
    maxHandlesPerSession: 2,
    maxCharsPerSession: 30,
    ttlMs: 100,
    now: () => now,
  });
  const first = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'a'.repeat(15) });
  const second = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'b'.repeat(15) });
  const third = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'c'.repeat(100) });

  assert.equal(store.get(first.id, 'chat-1'), undefined);
  assert.equal(store.get(second.id, 'chat-1'), undefined);
  assert.equal(store.get(third.id, 'chat-1')?.storedChars, 20);
  assert.equal(store.get(third.id, 'chat-1')?.sourceTruncated, true);

  now += 101;
  assert.equal(store.get(third.id, 'chat-1'), undefined);
});

test('ToolOutputStore spills retained output through its persistence adapter', async () => {
  const files = new Map<string, string>();
  const deleted: string[] = [];
  const store = new ToolOutputStore({
    spillThresholdChars: 10,
    persistence: {
      write: async (_record, content) => {
        files.set('/netcatty/tool-output.log', content);
        return '/netcatty/tool-output.log';
      },
      read: async (path, input) => {
        const content = files.get(path);
        if (content == null) return null;
        const startOffset = input.mode === 'tail'
          ? Math.max(0, content.length - (input.maxChars ?? 12_000))
          : Math.max(0, input.offset ?? 0);
        const selected = content.slice(startOffset, startOffset + (input.maxChars ?? 12_000));
        const endOffset = startOffset + selected.length;
        return {
          mode: input.mode ?? 'head',
          content: selected,
          totalChars: content.length,
          startOffset,
          endOffset,
          nextOffset: endOffset,
          hasMore: endOffset < content.length,
        };
      },
      delete: async path => {
        deleted.push(path);
        files.delete(path);
      },
    },
  });
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    content: 'persist this terminal output',
  });

  const result = await store.readChunkAsync({ handleId: handle.id, mode: 'full' }, 'chat-1');
  assert.equal(result?.content, 'persist this terminal output');
  assert.equal(store.get(handle.id, 'chat-1')?.fullContent, undefined);
  store.prune('chat-1');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deleted, ['/netcatty/tool-output.log']);
});

test('ToolOutputStore restores a durable handle after a runtime restart', async () => {
  const files = new Map<string, { record: PersistedToolOutputRecord; content: string }>();
  const persistence: ToolOutputPersistence = {
    write: async (record, content) => {
      const path = `/netcatty/${record.handleId}.log`;
      files.set(path, { record, content });
      return path;
    },
    restore: async (handleId, chatSessionId) => {
      for (const [path, entry] of files) {
        if (entry.record.handleId !== handleId || entry.record.chatSessionId !== chatSessionId) continue;
        return { path, record: entry.record };
      }
      return null;
    },
    read: async (path, input) => {
      const content = files.get(path)?.content;
      if (content == null) return null;
      const startOffset = input.mode === 'tail'
        ? Math.max(0, content.length - (input.maxChars ?? 12_000))
        : Math.max(0, input.offset ?? 0);
      const selected = content.slice(startOffset, startOffset + (input.maxChars ?? 12_000));
      const endOffset = startOffset + selected.length;
      return {
        mode: input.mode ?? 'head',
        content: selected,
        totalChars: content.length,
        startOffset,
        endOffset,
        nextOffset: endOffset,
        hasMore: endOffset < content.length,
      };
    },
    delete: async path => {
      files.delete(path);
    },
  };

  const beforeRestart = new ToolOutputStore({ spillThresholdChars: 0, persistence });
  const saved = beforeRestart.store({
    chatSessionId: 'chat-restart',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-1',
    content: 'restart evidence in the middle',
  });
  await saved.spillPromise;

  const afterRestart = new ToolOutputStore({ spillThresholdChars: 0, persistence });
  const restored = await afterRestart.readChunkAsync({
    handleId: saved.id,
    mode: 'search',
    query: 'evidence',
  }, 'chat-restart');

  assert.match(restored?.content ?? '', /restart evidence/);
  assert.equal(afterRestart.get(saved.id, 'chat-restart')?.sessionId, 'terminal-1');
  assert.equal(await afterRestart.readChunkAsync({ handleId: saved.id }, 'chat-other'), null);
});

test('ToolOutputStore drops a restored handle when its durable file is missing', async () => {
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-missing',
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    totalChars: 100,
    storedChars: 100,
    sourceTruncated: false,
    preview: 'preview',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => ({ path: '/missing.log', record }),
      read: async () => null,
      delete: async () => {},
    },
  });

  assert.equal(await store.readChunkAsync({ handleId: record.handleId }, 'chat-1'), null);
  assert.equal(store.listPendingHandles('chat-1').length, 0);
});

test('ToolOutputStore can delete durable handles for a chat that was never restored', async () => {
  const deletedSessions: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
      deleteSession: async chatSessionId => {
        deletedSessions.push(chatSessionId);
      },
    },
  });

  store.prune('chat-after-restart');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedSessions, ['chat-after-restart']);
});

test('ToolOutputStore can delete durable terminal handles that were never restored', async () => {
  const deletedTerminalSessions: Array<[string, string]> = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
      deleteTerminalSession: async (chatSessionId, terminalSessionId) => {
        deletedTerminalSessions.push([chatSessionId, terminalSessionId]);
      },
    },
  });

  store.pruneTerminalSession('chat-after-restart', 'terminal-closed');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedTerminalSessions, [['chat-after-restart', 'terminal-closed']]);
});

test('ToolOutputStore deletes unopened durable handles when a terminal closes', async () => {
  const deletedTerminals: string[] = [];
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/tmp/unused',
      read: async () => null,
      delete: async () => {},
      deleteTerminalEverywhere: async terminalSessionId => {
        deletedTerminals.push(terminalSessionId);
      },
    },
  });

  store.pruneTerminalSessionEverywhere('terminal-unopened-after-restart');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(deletedTerminals, ['terminal-unopened-after-restart']);
});

test('ToolOutputStore does not persist output that arrives after its terminal closed', async () => {
  let writes = 0;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => {
        writes += 1;
        return '/late.log';
      },
      read: async () => null,
      delete: async () => {},
      deleteTerminalSession: async () => {},
    },
  });

  store.pruneTerminalSessionEverywhere('terminal-closed-before-output');
  const lateHandle = store.store({
    chatSessionId: 'chat-late-output',
    capabilityId: 'terminal.execute',
    sessionId: 'terminal-closed-before-output',
    content: 'late output',
  });
  await store.flush('chat-late-output');

  assert.equal(writes, 0);
  assert.equal(store.listPendingHandles('chat-late-output').length, 0);
  assert.equal(await store.readChunkAsync({ handleId: lateHandle.id }, 'chat-late-output'), null);
});

test('ToolOutputStore does not resurrect a handle when its chat is deleted during restore', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const deletedPaths: string[] = [];
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-racing-restore',
    chatSessionId: 'chat-racing-restore',
    capabilityId: 'terminal.execute',
    totalChars: 7,
    storedChars: 7,
    sourceTruncated: false,
    preview: 'private',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => restoreFinished,
      read: async () => ({
        mode: 'head', content: 'private', totalChars: 7, startOffset: 0, endOffset: 7, nextOffset: 7, hasMore: false,
      }),
      delete: async path => {
        deletedPaths.push(path);
      },
      deleteSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.prune(record.chatSessionId);
  finishRestore({ path: '/netcatty/racing.log', record });

  assert.equal(await reading, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(deletedPaths, ['/netcatty/racing.log']);
  assert.equal(store.listPendingHandles(record.chatSessionId).length, 0);
});

test('ToolOutputStore waits for chat deletion before starting a later restore', async () => {
  let finishDeletion!: () => void;
  const deletionFinished = new Promise<void>(resolve => {
    finishDeletion = resolve;
  });
  let restoreCalls = 0;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => {
        restoreCalls += 1;
        return null;
      },
      read: async () => null,
      delete: async () => {},
      deleteSession: async () => deletionFinished,
    },
  });

  store.prune('chat-delete-window');
  const reading = store.readChunkAsync({ handleId: 'old-handle' }, 'chat-delete-window');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(restoreCalls, 0);

  finishDeletion();
  assert.equal(await reading, null);
  assert.equal(restoreCalls, 1);
});

test('ToolOutputStore does not resurrect an old handle when its terminal is deleted during restore', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const deletedPaths: string[] = [];
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-terminal-race',
    chatSessionId: 'chat-terminal-race',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-race',
    totalChars: 7,
    storedChars: 7,
    sourceTruncated: false,
    preview: 'private',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/new-output.log',
      restore: async () => restoreFinished,
      read: async () => null,
      delete: async path => {
        deletedPaths.push(path);
      },
      deleteTerminalSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.pruneTerminalSessionEverywhere(record.terminalSessionId!);
  store.store({
    chatSessionId: record.chatSessionId,
    capabilityId: 'terminal.execute',
    sessionId: record.terminalSessionId,
    content: 'new output',
  });
  finishRestore({ path: '/netcatty/old-output.log', record });

  assert.equal(await reading, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(deletedPaths.includes('/netcatty/old-output.log'));
  assert.equal(store.get(record.handleId, record.chatSessionId), undefined);
});

test('ToolOutputStore keeps restoring one terminal when a different terminal is deleted', async () => {
  let finishRestore!: (value: { path: string; record: PersistedToolOutputRecord }) => void;
  const restoreFinished = new Promise<{ path: string; record: PersistedToolOutputRecord }>(resolve => {
    finishRestore = resolve;
  });
  const record: PersistedToolOutputRecord = {
    schemaVersion: 1,
    handleId: 'tool-output-terminal-b',
    chatSessionId: 'chat-two-terminals',
    capabilityId: 'terminal.execute',
    terminalSessionId: 'terminal-b',
    totalChars: 8,
    storedChars: 8,
    sourceTruncated: false,
    preview: 'terminal',
    storedAt: 1,
    accessedAt: 1,
  };
  const store = new ToolOutputStore({
    persistence: {
      write: async () => '/unused',
      restore: async () => restoreFinished,
      read: async () => ({
        mode: 'head', content: 'terminal', totalChars: 8, startOffset: 0, endOffset: 8, nextOffset: 8, hasMore: false,
      }),
      delete: async () => {},
      deleteTerminalSession: async () => {},
    },
  });

  const reading = store.readChunkAsync({ handleId: record.handleId }, record.chatSessionId);
  store.pruneTerminalSession(record.chatSessionId, 'terminal-a');
  finishRestore({ path: '/netcatty/terminal-b.log', record });

  assert.equal((await reading)?.content, 'terminal');
});

test('ToolOutputStore can restore a durable handle after its in-memory cache expires', async () => {
  let now = 1_000;
  const files = new Map<string, { record: PersistedToolOutputRecord; content: string }>();
  const persistence: ToolOutputPersistence = {
    write: async (record, content) => {
      const path = `/netcatty/${record.handleId}.log`;
      files.set(path, { record, content });
      return path;
    },
    restore: async (handleId, chatSessionId) => {
      for (const [path, entry] of files) {
        if (entry.record.handleId === handleId && entry.record.chatSessionId === chatSessionId) {
          return { path, record: entry.record };
        }
      }
      return null;
    },
    read: async (path, input) => {
      const content = files.get(path)?.content;
      if (content == null) return null;
      return {
        mode: input.mode ?? 'head',
        content,
        totalChars: content.length,
        startOffset: 0,
        endOffset: content.length,
        nextOffset: content.length,
        hasMore: false,
      };
    },
    delete: async path => {
      files.delete(path);
    },
  };
  const store = new ToolOutputStore({ ttlMs: 100, now: () => now, persistence });
  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'durable' });
  await handle.spillPromise;
  now += 101;

  const restored = await store.readChunkAsync({ handleId: handle.id }, 'chat-1');
  assert.equal(restored?.content, 'durable');
});

test('ToolOutputStore flush waits until a handle is durable before a tool can return it', async () => {
  let finishWrite!: (path: string) => void;
  const writeFinished = new Promise<string>(resolve => {
    finishWrite = resolve;
  });
  const store = new ToolOutputStore({
    persistence: {
      write: async () => writeFinished,
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
    },
  });
  const handle = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'persist me' });
  let flushed = false;
  const flushing = store.flush('chat-1').then(() => {
    flushed = true;
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(flushed, false);
  finishWrite('/netcatty/durable.log');
  await flushing;
  assert.equal(handle.filePath, '/netcatty/durable.log');
});

test('ToolOutputStore reports restart persistence only after the individual spill succeeds', async () => {
  let failWrite = true;
  const store = new ToolOutputStore({
    persistence: {
      write: async () => {
        if (failWrite) throw new Error('disk full');
        return '/netcatty/durable.log';
      },
      restore: async () => null,
      read: async () => null,
      delete: async () => {},
    },
  });
  const failed = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'memory only' });
  const failedNotice = `[output handle: handleId=${failed.id} restartPersistence=unavailable (read before closing the app)]`;
  await store.flush('chat-1');
  assert.equal(store.resolveRestartPersistenceNotices(failedNotice, 'chat-1'), failedNotice);

  failWrite = false;
  const durable = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'saved' });
  const durableNotice = `[output handle: handleId=${durable.id} restartPersistence=unavailable (read before closing the app)]`;
  await store.flush('chat-1');
  assert.equal(
    store.resolveRestartPersistenceNotices(durableNotice, 'chat-1'),
    `[output handle: handleId=${durable.id}]`,
  );
});

test('ToolOutputStore enforces a shared quota across chat sessions', () => {
  const store = new ToolOutputStore({
    maxCharsGlobal: 25,
    maxHandlesGlobal: 2,
  });
  const first = store.store({ chatSessionId: 'chat-1', capabilityId: 'test', content: 'a'.repeat(15) });
  const second = store.store({ chatSessionId: 'chat-2', capabilityId: 'test', content: 'b'.repeat(15) });

  assert.equal(store.get(first.id, 'chat-1'), undefined);
  assert.ok(store.get(second.id, 'chat-2'));
});

test('ToolOutputStore rejects cross-chat handle reads', async () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-owner',
    capabilityId: 'terminal.execute',
    content: 'private output',
  });

  assert.equal(await store.readChunkAsync({ handleId: handle.id }, 'chat-other'), null);
});

test('saved-output read budgets reset at the start of each turn', () => {
  const dedup = new ToolResultDedup();
  dedup.beginTurn();
  assert.equal(dedup.takeBudget('read', 24_000, 24_000), 24_000);
  assert.equal(dedup.takeBudget('read', 1, 24_000), 0);
  dedup.beginTurn();
  assert.equal(dedup.takeBudget('read', 24_000, 24_000), 24_000);
});
