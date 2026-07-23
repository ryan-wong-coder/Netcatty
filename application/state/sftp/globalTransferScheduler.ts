type LimitReader = () => number | null | undefined;

interface ScheduledJob<T> {
  ownerId: string;
  taskId: string;
  priority: number;
  readLimit: LimitReader;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface GlobalSftpTransferScheduler {
  run<T>(ownerId: string, taskId: string, readLimit: LimitReader, work: () => Promise<T>): Promise<T>;
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

export function createGlobalSftpTransferScheduler(): GlobalSftpTransferScheduler {
  const queue: Array<ScheduledJob<unknown>> = [];
  let active = 0;
  let lastOwnerId: string | null = null;
  let prioritySequence = 0;
  const pausedJobs = new Map<string, ScheduledJob<unknown>>();

  const pump = () => {
    const limit = normalizeLimit(queue[0]?.readLimit());
    while (active < limit && queue.length > 0) {
      const highestPriority = queue.reduce((max, job) => Math.max(max, job.priority), 0);
      const prioritizedIndexes = queue
        .map((job, index) => ({ job, index }))
        .filter(({ job }) => job.priority === highestPriority);
      const alternate = lastOwnerId === null
        ? undefined
        : prioritizedIndexes.find(({ job }) => job.ownerId !== lastOwnerId);
      const index = alternate?.index ?? prioritizedIndexes[0]?.index ?? 0;
      const [job] = queue.splice(index, 1);
      if (!job) return;
      active += 1;
      lastOwnerId = job.ownerId;
      void job.work().then(job.resolve, job.reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  return {
    run<T>(ownerId: string, taskId: string, readLimit: LimitReader, work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ ownerId, taskId, priority: 0, readLimit, work, resolve, reject } as ScheduledJob<unknown>);
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
