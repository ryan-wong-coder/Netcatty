type LimitReader = () => number | null | undefined;

interface ScheduledJob<T> {
  ownerId: string;
  taskId: string;
  resourceKeys: string[];
  priority: number;
  readLimit: LimitReader;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface GlobalSftpTransferScheduler {
  run<T>(ownerId: string, taskId: string, resourceKeys: readonly string[], readLimit: LimitReader, work: () => Promise<T>): Promise<T>;
  prioritize(taskId: string): void;
  pause(taskId: string): boolean;
  resume(taskId: string): boolean;
  cancel(taskId: string): boolean;
}

function normalizeLimit(value: number | null | undefined): number {
  return Number.isInteger(value) && value !== undefined && value !== null && value >= 1 && value <= 16
    ? value
    : 2;
}

export function getSftpTransferResourceKeys(input: {
  sourceHostId?: string;
  targetHostId?: string;
  sourceSftpId?: string;
  targetSftpId?: string;
}): string[] {
  const keys = [
    input.sourceHostId ? `host:${input.sourceHostId}` : input.sourceSftpId ? `session:${input.sourceSftpId}` : null,
    input.targetHostId ? `host:${input.targetHostId}` : input.targetSftpId ? `session:${input.targetSftpId}` : null,
  ].filter((key): key is string => Boolean(key));
  return [...new Set(keys.length > 0 ? keys : ["local"])];
}

export function createGlobalSftpTransferScheduler(): GlobalSftpTransferScheduler {
  const queue: Array<ScheduledJob<unknown>> = [];
  const activeByResource = new Map<string, number>();
  let lastOwnerId: string | null = null;
  let prioritySequence = 0;
  const pausedJobs = new Map<string, ScheduledJob<unknown>>();

  const normalizeResourceKeys = (keys: readonly string[]) => [...new Set(keys.length > 0 ? keys : ["local"])];
  const canRun = (job: ScheduledJob<unknown>) => {
    const limit = normalizeLimit(job.readLimit());
    return job.resourceKeys.every((key) => (activeByResource.get(key) ?? 0) < limit);
  };
  const adjustActive = (job: ScheduledJob<unknown>, delta: 1 | -1) => {
    for (const key of job.resourceKeys) {
      const next = (activeByResource.get(key) ?? 0) + delta;
      if (next > 0) activeByResource.set(key, next);
      else activeByResource.delete(key);
    }
  };

  const pump = () => {
    while (queue.length > 0) {
      const runnable = queue.map((job, index) => ({ job, index })).filter(({ job }) => canRun(job));
      if (runnable.length === 0) return;
      const highestPriority = runnable.reduce((max, { job }) => Math.max(max, job.priority), 0);
      const prioritizedIndexes = queue
        .map((job, index) => ({ job, index }))
        .filter(({ job }) => job.priority === highestPriority && canRun(job));
      const alternate = lastOwnerId === null
        ? undefined
        : prioritizedIndexes.find(({ job }) => job.ownerId !== lastOwnerId);
      const index = alternate?.index ?? prioritizedIndexes[0]?.index ?? 0;
      const [job] = queue.splice(index, 1);
      if (!job) return;
      adjustActive(job, 1);
      lastOwnerId = job.ownerId;
      void job.work().then(job.resolve, job.reject).finally(() => {
        adjustActive(job, -1);
        pump();
      });
    }
  };

  return {
    run<T>(ownerId: string, taskId: string, resourceKeys: readonly string[], readLimit: LimitReader, work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ ownerId, taskId, resourceKeys: normalizeResourceKeys(resourceKeys), priority: 0, readLimit, work, resolve, reject } as ScheduledJob<unknown>);
        pump();
      });
    },
    prioritize(taskId: string) {
      const job = queue.find((candidate) => candidate.taskId === taskId) ?? pausedJobs.get(taskId);
      if (!job) return;
      prioritySequence += 1;
      job.priority = prioritySequence;
      pump();
    },
    pause(taskId: string) {
      const index = queue.findIndex((job) => job.taskId === taskId);
      if (index < 0) return false;
      const [job] = queue.splice(index, 1);
      if (!job) return false;
      pausedJobs.set(taskId, job);
      return true;
    },
    resume(taskId: string) {
      const job = pausedJobs.get(taskId);
      if (!job) return false;
      pausedJobs.delete(taskId);
      queue.push(job);
      pump();
      return true;
    },
    cancel(taskId: string) {
      const queueIndex = queue.findIndex((job) => job.taskId === taskId);
      const job = queueIndex >= 0 ? queue.splice(queueIndex, 1)[0] : pausedJobs.get(taskId);
      if (!job) return false;
      pausedJobs.delete(taskId);
      job.reject(new Error("Transfer cancelled"));
      pump();
      return true;
    },
  };
}

export const globalSftpTransferScheduler = createGlobalSftpTransferScheduler();
