export interface ToolOutputHandle {
  id: string;
  chatSessionId: string;
  capabilityId: string;
  sessionId?: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  preview: string;
  storedAt: number;
  accessedAt: number;
  fullContent?: string;
  filePath?: string;
  spillPromise?: Promise<void>;
  evicted?: boolean;
}

export interface PersistedToolOutputRecord {
  schemaVersion: 1;
  handleId: string;
  chatSessionId: string;
  capabilityId: string;
  terminalSessionId?: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  preview: string;
  storedAt: number;
  accessedAt: number;
}

export interface StoreToolOutputInput {
  chatSessionId: string;
  capabilityId: string;
  content: string;
  sessionId?: string;
  previewChars?: number;
}

export interface ReadToolOutputInput {
  handleId: string;
  mode?: 'head' | 'tail' | 'full' | 'range' | 'search';
  maxChars?: number;
  offset?: number;
  query?: string;
}

export interface ToolOutputReadResult {
  handleId: string;
  mode: NonNullable<ReadToolOutputInput['mode']>;
  content: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  hasMore: boolean;
  matchOffsets?: number[];
}

export const TOOL_OUTPUT_READ_MAX_CHARS = 12_000;
export const TOOL_OUTPUT_MAX_HANDLE_CHARS = 4_000_000;
export const TOOL_OUTPUT_MAX_HANDLES_PER_SESSION = 64;
export const TOOL_OUTPUT_MAX_CHARS_PER_SESSION = 8_000_000;
export const TOOL_OUTPUT_MAX_HANDLES_GLOBAL = 256;
export const TOOL_OUTPUT_MAX_CHARS_GLOBAL = 32_000_000;
export const TOOL_OUTPUT_TTL_MS = 30 * 60 * 1_000;
export const TOOL_OUTPUT_SPILL_THRESHOLD_CHARS = 0;
const TOOL_OUTPUT_SEARCH_CONTEXT_CHARS = 320;
const TOOL_OUTPUT_SEARCH_MAX_MATCHES = 20;

export interface ToolOutputPersistence {
  write(record: PersistedToolOutputRecord, content: string): Promise<string>;
  restore?(
    handleId: string,
    chatSessionId: string,
  ): Promise<{ path: string; record: PersistedToolOutputRecord } | null>;
  read(path: string, input: ReadToolOutputInput): Promise<Omit<ToolOutputReadResult, 'handleId' | 'storedChars' | 'sourceTruncated'> | null>;
  delete(path: string): Promise<void>;
  deleteSession?(chatSessionId: string): Promise<void>;
  deleteTerminalSession?(chatSessionId: string, terminalSessionId: string): Promise<void>;
  deleteTerminalEverywhere?(terminalSessionId: string): Promise<void>;
}

export interface ToolOutputStoreOptions {
  maxHandleChars?: number;
  maxHandlesPerSession?: number;
  maxCharsPerSession?: number;
  maxHandlesGlobal?: number;
  maxCharsGlobal?: number;
  ttlMs?: number;
  spillThresholdChars?: number;
  now?: () => number;
  persistence?: ToolOutputPersistence;
}

function nextHandleId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `tool-output-${randomId}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function safeSliceBounds(content: string, requestedStart: number, requestedEnd: number): [number, number] {
  let start = Math.min(content.length, Math.max(0, requestedStart));
  let end = Math.min(content.length, Math.max(start, requestedEnd));
  if (start > 0 && start < content.length && isLowSurrogate(content.charCodeAt(start))) {
    start -= 1;
  }
  if (end > start && end < content.length && isHighSurrogate(content.charCodeAt(end - 1))) {
    end -= 1;
  }
  return [start, end];
}

export class ToolOutputStore {
  private readonly bySession = new Map<string, Map<string, ToolOutputHandle>>();
  private readonly maxHandleChars: number;
  private readonly maxHandlesPerSession: number;
  private readonly maxCharsPerSession: number;
  private readonly maxHandlesGlobal: number;
  private readonly maxCharsGlobal: number;
  private readonly ttlMs: number;
  private readonly spillThresholdChars: number;
  private readonly now: () => number;
  private readonly restorePromises = new Map<string, Promise<ToolOutputHandle | undefined>>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly sessionDeletionPromises = new Map<string, Promise<void>>();
  private readonly terminalMutationGenerations = new Map<string, number>();
  private readonly deletedTerminalSessions = new Set<string>();
  private readonly closedTerminalSessions = new Set<string>();
  private persistence?: ToolOutputPersistence;

  constructor(options: ToolOutputStoreOptions = {}) {
    this.maxHandleChars = options.maxHandleChars ?? TOOL_OUTPUT_MAX_HANDLE_CHARS;
    this.maxHandlesPerSession = options.maxHandlesPerSession ?? TOOL_OUTPUT_MAX_HANDLES_PER_SESSION;
    this.maxCharsPerSession = options.maxCharsPerSession ?? TOOL_OUTPUT_MAX_CHARS_PER_SESSION;
    this.maxHandlesGlobal = options.maxHandlesGlobal ?? TOOL_OUTPUT_MAX_HANDLES_GLOBAL;
    this.maxCharsGlobal = options.maxCharsGlobal ?? TOOL_OUTPUT_MAX_CHARS_GLOBAL;
    this.ttlMs = options.ttlMs ?? TOOL_OUTPUT_TTL_MS;
    this.spillThresholdChars = options.spillThresholdChars ?? TOOL_OUTPUT_SPILL_THRESHOLD_CHARS;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
  }

  setPersistence(persistence: ToolOutputPersistence | undefined): void {
    this.persistence = persistence;
  }

  resolveRestartPersistenceNotices<T>(value: T, chatSessionId: string): T {
    return this.resolveRestartPersistenceNoticesValue(value, chatSessionId) as T;
  }

  store(input: StoreToolOutputInput): ToolOutputHandle {
    const previewChars = input.previewChars ?? 240;
    const retainedContent = retainBoundedContent(input.content, this.maxHandleChars);
    const now = this.now();
    const handle: ToolOutputHandle = {
      id: nextHandleId(),
      chatSessionId: input.chatSessionId,
      capabilityId: input.capabilityId,
      sessionId: input.sessionId,
      totalChars: input.content.length,
      storedChars: retainedContent.length,
      sourceTruncated: retainedContent.length < input.content.length,
      preview: retainedContent.slice(0, previewChars),
      storedAt: now,
      accessedAt: now,
      fullContent: retainedContent,
    };
    if (input.sessionId && this.closedTerminalSessions.has(input.sessionId)) {
      handle.evicted = true;
      handle.fullContent = undefined;
      return handle;
    }
    const sessionMap = this.bySession.get(input.chatSessionId) ?? new Map<string, ToolOutputHandle>();
    sessionMap.set(handle.id, handle);
    this.bySession.set(input.chatSessionId, sessionMap);
    this.enforceSessionLimits(input.chatSessionId, sessionMap);
    this.enforceGlobalLimits();
    if (sessionMap.has(handle.id)) this.startSpill(handle);
    return handle;
  }

  get(handleId: string, chatSessionId?: string): ToolOutputHandle | undefined {
    this.pruneExpired();
    if (chatSessionId) {
      const handle = this.bySession.get(chatSessionId)?.get(handleId);
      if (handle) handle.accessedAt = this.now();
      return handle;
    }
    for (const sessionMap of this.bySession.values()) {
      const handle = sessionMap.get(handleId);
      if (handle) {
        handle.accessedAt = this.now();
        return handle;
      }
    }
    return undefined;
  }

  listPendingHandles(chatSessionId: string): ToolOutputHandle[] {
    this.pruneExpired();
    return [...(this.bySession.get(chatSessionId)?.values() ?? [])];
  }

  async flush(chatSessionId: string): Promise<void> {
    const handles = [...(this.bySession.get(chatSessionId)?.values() ?? [])];
    await Promise.allSettled(handles.map(handle => handle.spillPromise));
  }

  read(input: ReadToolOutputInput, chatSessionId?: string): string | null {
    return this.readChunk(input, chatSessionId)?.content ?? null;
  }

  readChunk(input: ReadToolOutputInput, chatSessionId?: string): ToolOutputReadResult | null {
    const handle = this.get(input.handleId, chatSessionId);
    if (!handle) return null;
    if (handle.fullContent == null) return null;
    return buildReadResult(handle, handle.fullContent, input);
  }

  async readChunkAsync(input: ReadToolOutputInput, chatSessionId?: string): Promise<ToolOutputReadResult | null> {
    let handle = this.get(input.handleId, chatSessionId);
    if (!handle && chatSessionId) {
      handle = await this.restoreHandle(input.handleId, chatSessionId);
    }
    if (!handle) return null;
    await handle.spillPromise;
    if (handle.fullContent != null) return buildReadResult(handle, handle.fullContent, input);
    if (!handle.filePath || !this.persistence) return null;
    const persisted = await this.persistence.read(handle.filePath, input);
    if (!persisted) {
      this.removeHandle(handle);
      return null;
    }
    return {
      ...persisted,
      handleId: handle.id,
      totalChars: handle.totalChars,
      storedChars: handle.storedChars,
      sourceTruncated: handle.sourceTruncated,
    };
  }

  prune(chatSessionId: string): void {
    this.sessionGenerations.set(chatSessionId, (this.sessionGenerations.get(chatSessionId) ?? 0) + 1);
    for (const key of this.deletedTerminalSessions) {
      if (key.startsWith(`${chatSessionId}:`)) this.deletedTerminalSessions.delete(key);
    }
    const sessionMap = this.bySession.get(chatSessionId);
    if (sessionMap) {
      for (const handle of sessionMap.values()) this.evictHandle(handle);
    }
    this.bySession.delete(chatSessionId);
    const deletion = this.persistence?.deleteSession?.(chatSessionId)
      .catch(() => {})
      .then(() => {});
    if (deletion) {
      this.sessionDeletionPromises.set(chatSessionId, deletion);
      void deletion.finally(() => {
        if (this.sessionDeletionPromises.get(chatSessionId) === deletion) {
          this.sessionDeletionPromises.delete(chatSessionId);
        }
      });
    }
  }

  pruneTerminalSession(chatSessionId: string, terminalSessionId: string): void {
    const terminalKey = `${chatSessionId}:${terminalSessionId}`;
    this.deletedTerminalSessions.add(terminalKey);
    this.terminalMutationGenerations.set(
      terminalKey,
      (this.terminalMutationGenerations.get(terminalKey) ?? 0) + 1,
    );
    const sessionMap = this.bySession.get(chatSessionId);
    if (sessionMap) {
      for (const [handleId, handle] of sessionMap) {
        if (handle.sessionId !== terminalSessionId) continue;
        sessionMap.delete(handleId);
        this.evictHandle(handle);
      }
      if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
    }
    void this.persistence?.deleteTerminalSession?.(chatSessionId, terminalSessionId).catch(() => {});
  }

  pruneTerminalSessionEverywhere(terminalSessionId: string): void {
    this.closedTerminalSessions.add(terminalSessionId);
    const chatSessionIds = [...this.bySession.keys()];
    for (const chatSessionId of chatSessionIds) {
      this.pruneTerminalSession(chatSessionId, terminalSessionId);
    }
    void this.persistence?.deleteTerminalEverywhere?.(terminalSessionId).catch(() => {});
  }

  private startSpill(handle: ToolOutputHandle): void {
    if (!this.persistence || (handle.fullContent?.length ?? 0) < this.spillThresholdChars) return;
    const persistence = this.persistence;
    const content = handle.fullContent!;
    handle.spillPromise = persistence.write(toPersistedRecord(handle), content).then(async path => {
      if (handle.evicted) {
        await persistence.delete(path);
        return;
      }
      handle.filePath = path;
      handle.fullContent = undefined;
    }).catch(() => {
      // Keep the in-memory copy if persistence is temporarily unavailable.
    });
  }

  private resolveRestartPersistenceNoticesValue(value: unknown, chatSessionId: string): unknown {
    if (typeof value === 'string') {
      return this.resolveRestartPersistenceNoticeString(value, chatSessionId);
    }
    if (Array.isArray(value)) {
      return value.map(entry => this.resolveRestartPersistenceNoticesValue(entry, chatSessionId));
    }
    if (!value || typeof value !== 'object') return value;

    const record = value as Record<string, unknown>;
    const handleId = typeof record.handleId === 'string' ? record.handleId : undefined;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
      if (typeof entry === 'string' && handleId && this.isHandleRestartPersistent(handleId, chatSessionId)) {
        return [key, removeRestartPersistenceWarning(entry)];
      }
      return [key, this.resolveRestartPersistenceNoticesValue(entry, chatSessionId)];
    }));
  }

  private resolveRestartPersistenceNoticeString(value: string, chatSessionId: string): string {
    const handleIds = [...value.matchAll(/handleId=(tool-output-[A-Za-z0-9-]+)/g)]
      .map(match => match[1]);
    if (!handleIds.length) return value;
    return handleIds.every(handleId => this.isHandleRestartPersistent(handleId, chatSessionId))
      ? removeRestartPersistenceWarning(value)
      : value;
  }

  private isHandleRestartPersistent(handleId: string, chatSessionId: string): boolean {
    return Boolean(this.bySession.get(chatSessionId)?.get(handleId)?.filePath);
  }

  private enforceSessionLimits(chatSessionId: string, sessionMap: Map<string, ToolOutputHandle>): void {
    const totalChars = () => [...sessionMap.values()].reduce((sum, item) => sum + item.storedChars, 0);
    while (
      sessionMap.size > this.maxHandlesPerSession
      || totalChars() > this.maxCharsPerSession
    ) {
      const oldest = [...sessionMap.values()].sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (!oldest) break;
      sessionMap.delete(oldest.id);
      this.evictHandle(oldest);
    }
    if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [chatSessionId, sessionMap] of this.bySession) {
      for (const [handleId, handle] of sessionMap) {
        if (handle.accessedAt > cutoff) continue;
        sessionMap.delete(handleId);
        if (!handle.filePath) this.evictHandle(handle);
      }
      if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
    }
  }

  private enforceGlobalLimits(): void {
    const allHandles = () => [...this.bySession.entries()].flatMap(([chatSessionId, sessionMap]) => (
      [...sessionMap.values()].map(handle => ({ chatSessionId, sessionMap, handle }))
    ));
    while (true) {
      const entries = allHandles();
      const totalChars = entries.reduce((sum, entry) => sum + entry.handle.storedChars, 0);
      if (entries.length <= this.maxHandlesGlobal && totalChars <= this.maxCharsGlobal) break;
      const oldest = entries.sort((a, b) => a.handle.accessedAt - b.handle.accessedAt)[0];
      if (!oldest) break;
      oldest.sessionMap.delete(oldest.handle.id);
      this.evictHandle(oldest.handle);
      if (oldest.sessionMap.size === 0) this.bySession.delete(oldest.chatSessionId);
    }
  }

  private evictHandle(handle: ToolOutputHandle): void {
    handle.evicted = true;
    if (handle.filePath && this.persistence) {
      void this.persistence.delete(handle.filePath).catch(() => {});
    }
  }

  private async restoreHandle(handleId: string, chatSessionId: string): Promise<ToolOutputHandle | undefined> {
    if (!this.persistence?.restore) return undefined;
    const pendingDeletion = this.sessionDeletionPromises.get(chatSessionId);
    if (pendingDeletion) await pendingDeletion;
    const key = `${chatSessionId}:${handleId}`;
    const pending = this.restorePromises.get(key);
    if (pending) return pending;

    const generation = this.sessionGenerations.get(chatSessionId) ?? 0;
    const terminalMutationGenerations = new Map(this.terminalMutationGenerations);
    const restorePromise = this.restoreHandleImpl(
      handleId,
      chatSessionId,
      generation,
      terminalMutationGenerations,
    ).finally(() => {
      this.restorePromises.delete(key);
    });
    this.restorePromises.set(key, restorePromise);
    return restorePromise;
  }

  private async restoreHandleImpl(
    handleId: string,
    chatSessionId: string,
    generation: number,
    terminalMutationGenerations: Map<string, number>,
  ): Promise<ToolOutputHandle | undefined> {
    const restored = await this.persistence?.restore?.(handleId, chatSessionId);
    if (!restored || !isValidPersistedRecord(restored.record, handleId, chatSessionId)) return undefined;
    const restoredTerminalKey = restored.record.terminalSessionId
      ? `${chatSessionId}:${restored.record.terminalSessionId}`
      : undefined;
    if (
      (this.sessionGenerations.get(chatSessionId) ?? 0) !== generation
      || (
        restoredTerminalKey
        && (this.terminalMutationGenerations.get(restoredTerminalKey) ?? 0)
          !== (terminalMutationGenerations.get(restoredTerminalKey) ?? 0)
      )
      || (
        restoredTerminalKey
        && this.deletedTerminalSessions.has(restoredTerminalKey)
      )
      || (
        restored.record.terminalSessionId
        && this.closedTerminalSessions.has(restored.record.terminalSessionId)
      )
    ) {
      void this.persistence?.delete(restored.path).catch(() => {});
      return undefined;
    }

    const record = restored.record;
    const handle: ToolOutputHandle = {
      id: record.handleId,
      chatSessionId: record.chatSessionId,
      capabilityId: record.capabilityId,
      sessionId: record.terminalSessionId,
      totalChars: record.totalChars,
      storedChars: record.storedChars,
      sourceTruncated: record.sourceTruncated,
      preview: record.preview,
      storedAt: record.storedAt,
      accessedAt: this.now(),
      filePath: restored.path,
    };
    const sessionMap = this.bySession.get(chatSessionId) ?? new Map<string, ToolOutputHandle>();
    const existing = sessionMap.get(handleId);
    if (existing) return existing;
    sessionMap.set(handleId, handle);
    this.bySession.set(chatSessionId, sessionMap);
    this.enforceSessionLimits(chatSessionId, sessionMap);
    this.enforceGlobalLimits();
    return sessionMap.get(handleId);
  }

  private removeHandle(handle: ToolOutputHandle): void {
    const sessionMap = this.bySession.get(handle.chatSessionId);
    sessionMap?.delete(handle.id);
    if (sessionMap?.size === 0) this.bySession.delete(handle.chatSessionId);
    this.evictHandle(handle);
  }
}

function removeRestartPersistenceWarning(value: string): string {
  return value
    .replace(' restartPersistence=unavailable (read before closing the app)', '')
    .replace('This saved output is available only until the app closes. Read this handle before closing the app.', '')
    .replace(
      'Full file content is available only until the app closes. Use tool_output_read now.',
      'Full file content stored. Use tool_output_read with this handleId to read more.',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function toPersistedRecord(handle: ToolOutputHandle): PersistedToolOutputRecord {
  return {
    schemaVersion: 1,
    handleId: handle.id,
    chatSessionId: handle.chatSessionId,
    capabilityId: handle.capabilityId,
    terminalSessionId: handle.sessionId,
    totalChars: handle.totalChars,
    storedChars: handle.storedChars,
    sourceTruncated: handle.sourceTruncated,
    preview: handle.preview,
    storedAt: handle.storedAt,
    accessedAt: handle.accessedAt,
  };
}

function isValidPersistedRecord(
  record: PersistedToolOutputRecord,
  handleId: string,
  chatSessionId: string,
): boolean {
  return record?.schemaVersion === 1
    && record.handleId === handleId
    && record.chatSessionId === chatSessionId
    && typeof record.capabilityId === 'string'
    && record.capabilityId.length > 0
    && Number.isFinite(record.totalChars)
    && record.totalChars >= 0
    && Number.isFinite(record.storedChars)
    && record.storedChars >= 0
    && record.storedChars <= TOOL_OUTPUT_MAX_HANDLE_CHARS
    && typeof record.sourceTruncated === 'boolean'
    && typeof record.preview === 'string'
    && Number.isFinite(record.storedAt)
    && Number.isFinite(record.accessedAt);
}

function retainBoundedContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = `\n\n[... source output exceeded local handle limit; ${content.length - maxChars} chars omitted ...]\n\n`;
  if (marker.length >= maxChars) return content.slice(0, maxChars);
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${content.slice(0, head)}${marker}${content.slice(-tail)}`;
}

function buildReadResult(
  handle: ToolOutputHandle,
  content: string,
  input: ReadToolOutputInput,
): ToolOutputReadResult {
    const requestedMax = Number.isFinite(input.maxChars)
      ? Math.floor(input.maxChars!)
      : TOOL_OUTPUT_READ_MAX_CHARS;
    const maxChars = Math.min(TOOL_OUTPUT_READ_MAX_CHARS, Math.max(1, requestedMax));
    const mode = input.mode ?? 'head';

    if (mode === 'search') {
      const query = input.query ?? '';
      if (!query) {
        return {
          handleId: handle.id,
          mode,
          content: 'Search query is required.',
          totalChars: handle.totalChars,
          storedChars: handle.storedChars,
          sourceTruncated: handle.sourceTruncated,
          startOffset: 0,
          endOffset: 0,
          nextOffset: 0,
          hasMore: false,
          matchOffsets: [],
        };
      }
      const haystack = content.toLocaleLowerCase();
      const needle = query.toLocaleLowerCase();
      const offsets: number[] = [];
      let cursor = Math.max(0, Math.floor(input.offset ?? 0));
      while (offsets.length < TOOL_OUTPUT_SEARCH_MAX_MATCHES) {
        const match = haystack.indexOf(needle, cursor);
        if (match < 0) break;
        offsets.push(match);
        cursor = match + Math.max(1, needle.length);
      }
      const excerpts: string[] = [];
      const renderedOffsets: number[] = [];
      let renderedChars = 0;
      for (const match of offsets) {
        const [start, end] = safeSliceBounds(
          content,
          match - TOOL_OUTPUT_SEARCH_CONTEXT_CHARS,
          match + query.length + TOOL_OUTPUT_SEARCH_CONTEXT_CHARS,
        );
        const excerpt = `[match offset=${match}]\n${content.slice(start, end)}`;
        const separator = excerpts.length > 0 ? '\n\n' : '';
        const available = maxChars - renderedChars - separator.length;
        if (available <= 0) break;
        if (excerpt.length > available) {
          if (excerpts.length > 0) break;
          const [, safeEnd] = safeSliceBounds(excerpt, 0, available);
          excerpts.push(excerpt.slice(0, safeEnd));
          renderedOffsets.push(match);
          renderedChars += safeEnd;
          break;
        }
        excerpts.push(excerpt);
        renderedOffsets.push(match);
        renderedChars += separator.length + excerpt.length;
      }
      const rendered = excerpts.join('\n\n');
      const nextOffset = renderedOffsets.length > 0
        ? renderedOffsets[renderedOffsets.length - 1] + Math.max(1, query.length)
        : content.length;
      return {
        handleId: handle.id,
        mode,
        content: rendered || `No matches found for "${query}".`,
        totalChars: handle.totalChars,
        storedChars: handle.storedChars,
        sourceTruncated: handle.sourceTruncated,
        startOffset: Math.max(0, Math.floor(input.offset ?? 0)),
        endOffset: nextOffset,
        nextOffset,
        hasMore: haystack.indexOf(needle, nextOffset) >= 0,
        matchOffsets: renderedOffsets,
      };
    }

    let startOffset = 0;
    if (mode === 'tail') {
      startOffset = Math.max(0, content.length - maxChars);
    } else if (mode === 'range') {
      startOffset = Math.min(content.length, Math.max(0, Math.floor(input.offset ?? 0)));
    }
    const [safeStartOffset, safeEndOffset] = safeSliceBounds(
      content,
      startOffset,
      startOffset + maxChars,
    );
    startOffset = safeStartOffset;
    const selected = content.slice(startOffset, safeEndOffset);
    const endOffset = safeEndOffset;
    return {
      handleId: handle.id,
      mode,
      content: selected,
      totalChars: handle.totalChars,
      storedChars: handle.storedChars,
      sourceTruncated: handle.sourceTruncated,
      startOffset,
      endOffset,
      nextOffset: endOffset,
      hasMore: endOffset < content.length,
    };
}

export const globalToolOutputStore = new ToolOutputStore();
