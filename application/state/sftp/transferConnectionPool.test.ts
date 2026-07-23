import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransferPoolKey,
  createTransferConnectionPool,
  DEFAULT_TRANSFER_CONNECTIONS_PER_HOST,
} from "./transferConnectionPool";

test("buildTransferPoolKey prefers host id", () => {
  assert.equal(buildTransferPoolKey({ hostId: "h1", hostname: "x" }), "host:h1");
  assert.equal(
    buildTransferPoolKey({ hostname: "ci.example", port: 22, username: "root" }),
    "ep:ci.example:22:root:ssh:nosudo",
  );
});

test("pool opens at most maxPerHost connections and reuses them", async () => {
  let opens = 0;
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 2,
    idleTtlMs: 1,
    closeSession: async (id) => { closed.push(id); },
  });

  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);

  // Third transfer reuses least-loaded connection (both size 1 → first by age).
  const c = await pool.acquire("host:a", "t3", open);
  assert.equal(opens, 2);
  assert.ok(c.sftpId === a.sftpId || c.sftpId === b.sftpId);

  a.release();
  b.release();
  c.release();

  // Idle connection is preferred for the next acquire.
  const d = await pool.acquire("host:a", "t4", open);
  assert.equal(opens, 2);
  d.release();

  const stats = pool.getStats("host:a");
  assert.equal(stats.connections, 2);
  assert.equal(stats.busy, 0);
  assert.equal(stats.idle, 2);

  // After idle TTL, connections are closed.
  await new Promise((r) => setTimeout(r, 5));
  const n = await pool.closeIdle(Date.now() + 1000);
  assert.equal(n, 2);
  assert.equal(closed.length, 2);
  assert.equal(pool.getStats("host:a").connections, 0);
});

test("different hosts get independent connection pools", async () => {
  let opens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 1 });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  const b = await pool.acquire("host:b", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);
  a.release();
  b.release();
});

test("default max per host is FileZilla-like (2)", () => {
  assert.equal(DEFAULT_TRANSFER_CONNECTIONS_PER_HOST, 2);
});

test("concurrent acquires do not exceed maxPerHost", async () => {
  let opens = 0;
  let inFlightOpens = 0;
  let maxInFlightOpens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 2 });
  const open = async () => {
    inFlightOpens += 1;
    maxInFlightOpens = Math.max(maxInFlightOpens, inFlightOpens);
    await new Promise((r) => setTimeout(r, 10));
    opens += 1;
    inFlightOpens -= 1;
    return `sftp-${opens}`;
  };

  const leases = await Promise.all([
    pool.acquire("host:a", "t1", open),
    pool.acquire("host:a", "t2", open),
    pool.acquire("host:a", "t3", open),
    pool.acquire("host:a", "t4", open),
  ]);

  assert.equal(opens, 2);
  assert.ok(maxInFlightOpens <= 2);
  const ids = new Set(leases.map((l) => l.sftpId));
  assert.equal(ids.size, 2);
  for (const lease of leases) lease.release();
});

test("busy first connection causes a second open (FileZilla style)", async () => {
  let opens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 2 });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const first = await pool.acquire("host:a", "t1", open);
  assert.equal(opens, 1);

  // First is still held → open a second dedicated connection.
  const second = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(first.sftpId, second.sftpId);

  first.release();
  second.release();
});

test("discard removes a dead session so next acquire reopens", async () => {
  let opens = 0;
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    closeSession: async (id) => { closed.push(id); },
  });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  assert.equal(opens, 1);
  a.discard();
  assert.equal(closed.length, 1);
  assert.equal(pool.getStats("host:a").connections, 0);

  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);
  b.release();
});

test("closeIdle detaches slots before closing so acquire cannot re-lease them", async () => {
  let opens = 0;
  let closeStarted = 0;
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    idleTtlMs: 1,
    closeSession: async () => {
      closeStarted += 1;
      await closeGate;
    },
  });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  a.release();
  assert.equal(opens, 1);

  // Start idle close (holds while closeSession awaits).
  const closing = pool.closeIdle(Date.now() + 1000);
  // Allow the async closeIdle to detach the slot.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(closeStarted, 1);
  assert.equal(pool.getStats("host:a").connections, 0);

  // Concurrent acquire must open a fresh connection, not reuse the closing one.
  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(b.sftpId, a.sftpId);
  releaseClose();
  await closing;
  b.release();
});

test("discard does not close multiplexed connections while peers hold them", async () => {
  let opens = 0;
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    closeSession: async (id) => { closed.push(id); },
  });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 1);
  assert.equal(a.sftpId, b.sftpId);

  a.discard();
  // Peer still holds the session — do not close yet.
  assert.equal(closed.length, 0);
  assert.equal(pool.getStats("host:a").connections, 1);

  // New acquires must not reuse the unhealthy session.
  const c = await pool.acquire("host:a", "t3", open);
  assert.equal(opens, 2);
  assert.notEqual(c.sftpId, a.sftpId);

  b.release();
  // Last peer of unhealthy slot releases → close original.
  assert.ok(closed.includes(a.sftpId));
  c.release();
});
