import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDiskCapacityGb,
  resolveTerminalDiskSummary,
} from "./serverStatsFormat.ts";

test("disk capacity uses at most two decimal places", () => {
  assert.equal(formatDiskCapacityGb(5.964138), "5.96");
  assert.equal(formatDiskCapacityGb(28.893616), "28.89");
  assert.equal(formatDiskCapacityGb(0.005907), "0.01");
  assert.equal(formatDiskCapacityGb(10), "10");
  assert.equal(formatDiskCapacityGb(10.5), "10.5");
});

test("terminal disk summary totals every mounted filesystem", () => {
  const summary = resolveTerminalDiskSummary({
    diskUsed: 9.285,
    diskTotal: 899.763855,
    diskPercent: 2,
    disks: [
      { capacityKey: "/dev/sdb4", mountPoint: "/", used: 9.285, total: 899.763855 },
      { capacityKey: "/dev/sdb2", mountPoint: "/boot", used: 0.070892, total: 0.89909 },
      { capacityKey: "/dev/sdb1", mountPoint: "/boot/efi", used: 0.008568, total: 0.474628 },
      { capacityKey: "/dev/sda1", mountPoint: "/var", used: 215.84272, total: 1862.105923 },
    ],
  });

  assert.equal(summary.used === null ? null : formatDiskCapacityGb(summary.used), "225.21");
  assert.equal(summary.total === null ? null : formatDiskCapacityGb(summary.total), "2763.24");
  assert.equal(summary.percent, 8);
});

test("terminal disk summary preserves legacy root-only stats as a fallback", () => {
  assert.deepEqual(
    resolveTerminalDiskSummary({
      diskUsed: 12,
      diskTotal: 100,
      diskPercent: 12,
      disks: [],
    }),
    { used: 12, total: 100, percent: 12 },
  );
});
