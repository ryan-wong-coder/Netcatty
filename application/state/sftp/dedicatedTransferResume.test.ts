import assert from "node:assert/strict";
import test from "node:test";

import type { Host, TransferTask } from "../../../domain/models";
import {
  classifyDedicatedResumeEndpoints,
  classifyResumeSourceValidationError,
  findPersistedChildForResumeFile,
  MAX_CONCURRENT_DEDICATED_SESSION_OPENS,
  resetDedicatedSessionOpenGateForTests,
  resolveDirectoryResumeTargetRoot,
  resolveHostForTransferEndpoint,
  shouldSkipCompletedResumeChild,
  withDedicatedSessionOpenSlot,
} from "./dedicatedTransferResume";

const host = (id: string, label: string, hostname = label): Host => ({
  id,
  label,
  hostname,
  port: 22,
  username: "root",
  authMethod: "password",
  protocol: "ssh",
} as Host);

test("resolveDirectoryResumeTargetRoot prefers staged replace path", () => {
  assert.equal(
    resolveDirectoryResumeTargetRoot({
      targetPath: "/final/dir",
      stagedTargetPath: "/final/dir.netcatty-abc.part",
      replaceExistingTarget: true,
    }),
    "/final/dir.netcatty-abc.part",
  );
  assert.equal(
    resolveDirectoryResumeTargetRoot({
      targetPath: "/final/dir",
    }),
    "/final/dir",
  );
});

test("findPersistedChildForResumeFile matches staged target paths", () => {
  const staged = "/final/dir.netcatty-abc.part/a.txt";
  const child = {
    id: "c1",
    status: "completed" as const,
    sourcePath: "/src/a.txt",
    targetPath: staged,
    checkpointBytes: 10,
    transferredBytes: 10,
    totalBytes: 10,
  };
  const planRoot = resolveDirectoryResumeTargetRoot({
    targetPath: "/final/dir",
    stagedTargetPath: "/final/dir.netcatty-abc.part",
  });
  const planned = { sourcePath: "/src/a.txt", targetPath: `${planRoot}/a.txt` };
  assert.equal(findPersistedChildForResumeFile([child], planned)?.id, "c1");
  assert.equal(shouldSkipCompletedResumeChild(findPersistedChildForResumeFile([child], planned)), true);
});

test("resolveHostForTransferEndpoint prefers id then label", () => {
  const hosts = [host("id-1", "CI-Build-01", "ci-01.example")];
  assert.equal(resolveHostForTransferEndpoint(hosts, "id-1", "other")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, "missing", "CI-Build-01")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, undefined, "ci-01.example")?.id, "id-1");
  assert.equal(resolveHostForTransferEndpoint(hosts, "missing", "gone"), null);
});

test("classifyDedicatedResumeEndpoints detects download, upload, and remote-to-remote", () => {
  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "download",
    sourceHostId: "h1",
    targetConnectionId: "local",
  }), { isDownload: true, isUpload: false, isRemoteToRemote: false });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "upload",
    targetHostId: "h1",
    sourceConnectionId: "local",
  }), { isDownload: false, isUpload: true, isRemoteToRemote: false });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "remote-to-remote",
    sourceHostId: "a",
    targetHostId: "b",
  }), { isDownload: false, isUpload: false, isRemoteToRemote: true });

  assert.deepEqual(classifyDedicatedResumeEndpoints({
    direction: "download",
    sourceHostId: "a",
    targetHostId: "b",
    sourceConnectionId: "s1",
    targetConnectionId: "s2",
  }), { isDownload: false, isUpload: false, isRemoteToRemote: true });
});

test("directory resume skips completed children and matches by path", () => {
  const children = [
    {
      id: "c1",
      status: "completed" as const,
      sourcePath: "/remote/a.txt",
      targetPath: "/local/a.txt",
      checkpointBytes: 10,
      transferredBytes: 10,
      totalBytes: 10,
    },
    {
      id: "c2",
      status: "interrupted" as const,
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
      checkpointBytes: 4,
      transferredBytes: 4,
      totalBytes: 20,
    },
  ];

  assert.equal(
    shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/a.txt",
      targetPath: "/local/a.txt",
    })),
    true,
  );
  assert.equal(
    shouldSkipCompletedResumeChild(findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
    })),
    false,
  );
  assert.equal(
    findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/b.txt",
      targetPath: "/local/b.txt",
    })?.checkpointBytes,
    4,
  );
  assert.equal(
    findPersistedChildForResumeFile(children, {
      sourcePath: "/remote/missing.txt",
      targetPath: "/local/missing.txt",
    }),
    null,
  );
  // Ambiguous OR match must not win: two children share sourcePath different targets.
  const ambiguous = [
    { id: "x", status: "interrupted" as const, sourcePath: "/s/a", targetPath: "/t/1", checkpointBytes: 1, transferredBytes: 1, totalBytes: 10 },
    { id: "y", status: "interrupted" as const, sourcePath: "/s/a", targetPath: "/t/2", checkpointBytes: 2, transferredBytes: 2, totalBytes: 10 },
  ];
  assert.equal(
    findPersistedChildForResumeFile(ambiguous, { sourcePath: "/s/a", targetPath: "/t/other" }),
    null,
  );
  assert.equal(
    findPersistedChildForResumeFile(ambiguous, { sourcePath: "/s/a", targetPath: "/t/2" })?.id,
    "y",
  );
});

test("directory parent classification stays distinct from single-file downloads", () => {
  const parent = {
    direction: "download" as const,
    sourceHostId: "h1",
    targetConnectionId: "local",
    isDirectory: true,
  } satisfies Pick<TransferTask, "direction" | "sourceHostId" | "targetConnectionId" | "isDirectory">;
  assert.equal(parent.isDirectory, true);
  assert.equal(classifyDedicatedResumeEndpoints(parent).isDownload, true);
});

test("classifyResumeSourceValidationError maps size vs modified vs fatal", () => {
  assert.equal(classifyResumeSourceValidationError(null).kind, "ok");
  assert.equal(classifyResumeSourceValidationError("Source size changed while the transfer was paused").kind, "restart");
  assert.equal(classifyResumeSourceValidationError("Saved checkpoint is beyond the current source size").kind, "restart");
  assert.equal(classifyResumeSourceValidationError("Source was modified while the transfer was paused").kind, "modified");
  assert.equal(classifyResumeSourceValidationError("Source is unavailable").kind, "fatal");
});

test("dedicated session open gate limits concurrent dials", async () => {
  resetDedicatedSessionOpenGateForTests();
  assert.equal(MAX_CONCURRENT_DEDICATED_SESSION_OPENS, 2);

  let inFlight = 0;
  let peak = 0;
  const work = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
  };

  await Promise.all([
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
    withDedicatedSessionOpenSlot(work),
  ]);

  assert.ok(peak <= MAX_CONCURRENT_DEDICATED_SESSION_OPENS, `peak open slots ${peak}`);
  resetDedicatedSessionOpenGateForTests();
});
