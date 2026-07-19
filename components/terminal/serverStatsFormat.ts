import {
  aggregateMountedDiskUsage,
  type MountedDiskUsage,
} from "../../domain/systemDiskUsage";

interface TerminalDiskStats {
  diskUsed: number | null;
  diskTotal: number | null;
  diskPercent: number | null;
  disks: readonly MountedDiskUsage[];
}

export interface TerminalDiskSummary {
  used: number | null;
  total: number | null;
  percent: number | null;
}

export function formatDiskCapacityGb(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function resolveTerminalDiskSummary(
  stats: TerminalDiskStats,
): TerminalDiskSummary {
  const mountedUsage = aggregateMountedDiskUsage(stats.disks);
  if (mountedUsage) {
    return {
      used: mountedUsage.used,
      total: mountedUsage.total,
      percent: Math.round(mountedUsage.percent),
    };
  }

  return {
    used: stats.diskUsed,
    total: stats.diskTotal,
    percent: stats.diskPercent,
  };
}
