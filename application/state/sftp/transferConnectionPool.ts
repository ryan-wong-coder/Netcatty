/**
 * FileZilla-style dedicated transfer connection pool.
 *
 * Browse/list uses the panel SFTP session. Bulk transfers use 1–2 separate
 * sessions per host so interactive navigation is not blocked by multi-file
 * uploads/downloads (same idea as FileZilla's transfer connections).
 */

export const DEFAULT_TRANSFER_CONNECTIONS_PER_HOST = 2;
export const MIN_TRANSFER_CONNECTIONS_PER_HOST = 1;
export const MAX_TRANSFER_CONNECTIONS_PER_HOST = 4;
export const DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS = 30_000;

export type TransferPoolOpenFn = (poolKey: string) => Promise<string>;
export type TransferPoolCloseFn = (sftpId: string) => void | Promise<void>;

export interface TransferConnectionLease {
  sftpId: string;
  poolKey: string;
  /** Drop the holder count; connection stays pooled for reuse. */
  release: () => void;
  /** Drop holder, remove from pool, and close — use when the session is dead. */
  discard: () => void;
}

interface PoolSlot {
  sftpId: string;
  holders: Set<string>;
  lastUsedAt: number;
  /** Session is dead; do not hand out to new transfers. Close when idle. */
  unhealthy?: boolean;
  opening?: Promise<string>;
}

export interface TransferConnectionPoolOptions {
  maxPerHost?: number;
  idleTtlMs?: number;
  closeSession?: TransferPoolCloseFn;
  now?: () => number;
}

export interface TransferConnectionPool {
  acquire(poolKey: string, transferId: string, open: TransferPoolOpenFn): Promise<TransferConnectionLease>;
  release(poolKey: string, sftpId: string, transferId: string): void;
  /** Remove a dead session from the pool and close it (best-effort). */
  discard(sftpId: string): void;
  getStats(poolKey?: string): {
    connections: number;
    busy: number;
    idle: number;
    holders: number;
  };
  closeIdle(now?: number): Promise<number>;
  closeAll(): Promise<void>;
  setMaxPerHost(max: number): void;
}

function normalizeMaxPerHost(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_TRANSFER_CONNECTIONS_PER_HOST;
  return Math.min(
    MAX_TRANSFER_CONNECTIONS_PER_HOST,
    Math.max(MIN_TRANSFER_CONNECTIONS_PER_HOST, value as number),
  );
}

export function createTransferConnectionPool(
  options: TransferConnectionPoolOptions = {},
): TransferConnectionPool {
  let maxPerHost = normalizeMaxPerHost(options.maxPerHost);
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS;
  const closeSession = options.closeSession;
  const now = options.now ?? (() => Date.now());

  /** poolKey -> open slots for that host endpoint */
  const pools = new Map<string, PoolSlot[]>();
  /** Serialize opens per host so we never exceed maxPerHost under concurrency */
  const openLocks = new Map<string, Promise<void>>();

  const getList = (poolKey: string): PoolSlot[] => {
    let list = pools.get(poolKey);
    if (!list) {
      list = [];
      pools.set(poolKey, list);
    }
    return list;
  };

  const withOpenLock = async <T>(poolKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = openLocks.get(poolKey) ?? Promise.resolve();
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
    // Chain waiters so concurrent acquires never exceed maxPerHost.
    openLocks.set(poolKey, previous.catch(() => {}).then(() => gate));
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      releaseLock();
    }
  };

  const removeAndCloseSlot = (poolKey: string, list: PoolSlot[], idx: number) => {
    const [slot] = list.splice(idx, 1);
    if (list.length === 0) pools.delete(poolKey);
    else pools.set(poolKey, list);
    if (slot) {
      void Promise.resolve(closeSession?.(slot.sftpId)).catch(() => {});
    }
  };

  const pickSlot = (list: PoolSlot[]): PoolSlot | null => {
    // Never hand out sessions marked dead by a prior discard.
    const healthy = list.filter((slot) => !slot.unhealthy);
    if (healthy.length === 0) return null;
    // Prefer idle connections, else least-loaded (FileZilla-style multiplexing).
    const sorted = [...healthy].sort((a, b) => {
      if (a.holders.size !== b.holders.size) return a.holders.size - b.holders.size;
      return a.lastUsedAt - b.lastUsedAt;
    });
    return sorted[0] ?? null;
  };

  const release = (poolKey: string, sftpId: string, transferId: string) => {
    const list = pools.get(poolKey);
    if (!list) return;
    const idx = list.findIndex((candidate) => candidate.sftpId === sftpId);
    if (idx < 0) return;
    const slot = list[idx]!;
    slot.holders.delete(transferId);
    slot.lastUsedAt = now();
    // Last holder of an unhealthy session → close now.
    if (slot.unhealthy && slot.holders.size === 0) {
      removeAndCloseSlot(poolKey, list, idx);
    }
  };

  /**
   * Mark a session unusable for new work. Only closes the underlying session
   * when no other holders remain — multiplexed siblings must not be killed.
   */
  const discard = (sftpId: string, options?: { transferId?: string }) => {
    if (!sftpId) return;
    for (const [poolKey, list] of pools.entries()) {
      const idx = list.findIndex((slot) => slot.sftpId === sftpId);
      if (idx < 0) continue;
      const slot = list[idx]!;
      if (options?.transferId) slot.holders.delete(options.transferId);
      slot.unhealthy = true;
      slot.lastUsedAt = now();
      if (slot.holders.size > 0) {
        // Peers still using this socket; close when the last one releases.
        return;
      }
      removeAndCloseSlot(poolKey, list, idx);
      return;
    }
  };

  const makeLease = (poolKey: string, sftpId: string, transferId: string): TransferConnectionLease => ({
    sftpId,
    poolKey,
    release: () => release(poolKey, sftpId, transferId),
    discard: () => discard(sftpId, { transferId }),
  });

  const acquire = async (
    poolKey: string,
    transferId: string,
    open: TransferPoolOpenFn,
  ): Promise<TransferConnectionLease> => {
    if (!poolKey) throw new Error("Transfer pool key is required");
    if (!transferId) throw new Error("Transfer id is required");

    return withOpenLock(poolKey, async () => {
      const list = getList(poolKey);
      // Count only healthy slots toward the open budget; unhealthy ones drain
      // as holders leave and should not block opening a replacement connection.
      const healthyCount = list.filter((slot) => !slot.unhealthy).length;
      const existing = pickSlot(list);
      // Reuse when we already have max healthy connections, or when an idle one exists.
      // FileZilla-style: open a second connection only when the first is busy.
      if (existing && (existing.holders.size === 0 || healthyCount >= maxPerHost)) {
        existing.holders.add(transferId);
        existing.lastUsedAt = now();
        return makeLease(poolKey, existing.sftpId, transferId);
      }

      if (healthyCount < maxPerHost) {
        const sftpId = await open(poolKey);
        const slot: PoolSlot = {
          sftpId,
          holders: new Set([transferId]),
          lastUsedAt: now(),
        };
        list.push(slot);
        return makeLease(poolKey, sftpId, transferId);
      }

      // Should be unreachable when maxPerHost >= 1, but keep safe fallback.
      const fallback = pickSlot(list);
      if (!fallback) {
        const sftpId = await open(poolKey);
        const slot: PoolSlot = {
          sftpId,
          holders: new Set([transferId]),
          lastUsedAt: now(),
        };
        list.push(slot);
        return makeLease(poolKey, sftpId, transferId);
      }
      fallback.holders.add(transferId);
      fallback.lastUsedAt = now();
      return makeLease(poolKey, fallback.sftpId, transferId);
    });
  };

  const closeIdle = async (at = now()): Promise<number> => {
    // Detach idle slots from the pool *before* awaiting close so concurrent
    // acquires cannot re-lease a session that is about to be torn down.
    const toClose: string[] = [];
    for (const [poolKey, list] of pools.entries()) {
      const kept: PoolSlot[] = [];
      for (const slot of list) {
        const idle = !slot.unhealthy
          && slot.holders.size === 0
          && at - slot.lastUsedAt >= idleTtlMs;
        if (!idle) {
          kept.push(slot);
          continue;
        }
        toClose.push(slot.sftpId);
      }
      if (kept.length === 0) pools.delete(poolKey);
      else pools.set(poolKey, kept);
    }
    let closed = 0;
    for (const sftpId of toClose) {
      closed += 1;
      try {
        await closeSession?.(sftpId);
      } catch {
        // best-effort
      }
    }
    return closed;
  };

  const closeAll = async () => {
    for (const list of pools.values()) {
      for (const slot of list) {
        try {
          await closeSession?.(slot.sftpId);
        } catch {
          // best-effort
        }
      }
    }
    pools.clear();
  };

  const getStats = (poolKey?: string) => {
    const lists = poolKey ? [pools.get(poolKey) ?? []] : [...pools.values()];
    let connections = 0;
    let busy = 0;
    let idle = 0;
    let holders = 0;
    for (const list of lists) {
      for (const slot of list) {
        connections += 1;
        holders += slot.holders.size;
        if (slot.holders.size > 0) busy += 1;
        else idle += 1;
      }
    }
    return { connections, busy, idle, holders };
  };

  return {
    acquire,
    release,
    discard,
    getStats,
    closeIdle,
    closeAll,
    setMaxPerHost(max: number) {
      maxPerHost = normalizeMaxPerHost(max);
    },
  };
}

/** Shared process-wide pool used by SFTP bulk transfers in the renderer. */
let sharedPool: TransferConnectionPool | null = null;

/**
 * Process-wide transfer pool (FileZilla-style, max 2 sessions per host).
 * `closeSession` is applied on first creation; later callers share the same pool.
 */
export function getSharedTransferConnectionPool(
  options?: TransferConnectionPoolOptions,
): TransferConnectionPool {
  if (!sharedPool) {
    sharedPool = createTransferConnectionPool({
      maxPerHost: DEFAULT_TRANSFER_CONNECTIONS_PER_HOST,
      idleTtlMs: DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS,
      ...options,
    });
  }
  return sharedPool;
}

/** Test-only: drop the singleton so tests start clean. */
export function resetSharedTransferConnectionPoolForTests(): void {
  sharedPool = null;
}

export function buildTransferPoolKey(input: {
  hostId?: string;
  hostname?: string;
  port?: number;
  username?: string;
  protocol?: string;
  sftpSudo?: boolean;
}): string {
  if (input.hostId) return `host:${input.hostId}`;
  const host = input.hostname || "unknown";
  const port = input.port || 22;
  const user = input.username || "root";
  const protocol = input.protocol || "ssh";
  const sudo = input.sftpSudo ? "sudo" : "nosudo";
  return `ep:${host}:${port}:${user}:${protocol}:${sudo}`;
}
