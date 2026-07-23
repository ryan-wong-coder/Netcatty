/**
 * Temp Directory Bridge - Manages Netcatty's dedicated temp directory
 * 
 * All temporary files (SFTP downloads, etc.) are stored in a dedicated
 * Netcatty folder within the system temp directory for easier cleanup.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Keep the legacy name when the OS already provides a private per-user temp
// root. Shared temp roots fall back to a stable directory under the user's home
// so another OS user cannot claim Netcatty's path before startup.
const NETCATTY_TEMP_DIR_NAME = "Netcatty";
const MAX_TOOL_OUTPUT_TEMP_CHARS = 4_000_000;
const MAX_TOOL_OUTPUT_TEMP_BYTES = 8_000_000;
const TOOL_OUTPUT_ORPHAN_TTL_MS = 30 * 60 * 1_000;
const TOOL_OUTPUT_PERSISTED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TOOL_OUTPUT_MANIFEST_MAX_BYTES = 16_384;
const TOOL_OUTPUT_MAX_HANDLES_PER_SESSION = 64;
const TOOL_OUTPUT_MAX_CHARS_PER_SESSION = 8_000_000;
const TOOL_OUTPUT_MAX_HANDLES_GLOBAL = 256;
const TOOL_OUTPUT_MAX_CHARS_GLOBAL = 32_000_000;
const TOOL_OUTPUT_READ_MAX_CHARS = 12_000;
const TOOL_OUTPUT_SEARCH_CONTEXT_CHARS = 320;
const TOOL_OUTPUT_SEARCH_MAX_MATCHES = 20;
const TOOL_OUTPUT_SIGNING_KEY_FILE = ".tool-output-signing-key";

// Cached temp directory path
let cachedTempDir = null;
let cachedTempDirIdentity = null;
let tempFileCounter = 0;
let toolOutputSigningKeyPromise = Promise.resolve(crypto.randomBytes(32));
let toolOutputSigningKeyRecoveryPromise = null;
let toolOutputSafeStorage = null;
const toolOutputSessionDeletions = new Map();
const toolOutputChatDeletionGenerations = new Map();
const closedToolOutputTerminalSessions = new Set();

function isSecureToolOutputStorageAvailable(safeStorage, platform = process.platform) {
  if (!safeStorage?.isEncryptionAvailable?.()) return false;
  if (platform !== "linux" || typeof safeStorage.getSelectedStorageBackend !== "function") return true;
  const backend = safeStorage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

function getToolOutputChatDeletionGeneration(chatSessionId) {
  return toolOutputChatDeletionGenerations.get(chatSessionId) ?? 0;
}

async function loadOrCreateToolOutputSigningKey(safeStorage) {
  if (!isSecureToolOutputStorageAvailable(safeStorage)) return null;
  const keyPath = path.join(getTempDir(), TOOL_OUTPUT_SIGNING_KEY_FILE);
  try {
    const stat = await fs.promises.lstat(keyPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4096) {
      let encrypted;
      try {
        encrypted = await fs.promises.readFile(keyPath);
      } catch {
        // A transient read failure must not destroy the only key for existing output.
        return null;
      }
      try {
        const decoded = Buffer.from(safeStorage.decryptString(encrypted), "base64");
        if (decoded.length === 32) return decoded;
      } catch {
        // A locked or temporarily unavailable OS keychain must not destroy the
        // only key capable of verifying previously persisted output.
        return null;
      }
    }
    if ((stat.isFile() || stat.isSymbolicLink())) {
      await fs.promises.unlink(keyPath);
    } else {
      return null;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
  }

  const key = crypto.randomBytes(32);
  const pendingPath = `${keyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.pending`;
  try {
    const encrypted = safeStorage.encryptString(key.toString("base64"));
    await fs.promises.writeFile(pendingPath, encrypted, { mode: 0o600, flag: "wx" });
    await fs.promises.rename(pendingPath, keyPath);
    return key;
  } catch (error) {
    await safeUnlink(pendingPath);
    if (error?.code !== "EEXIST") return null;
    try {
      const encrypted = await fs.promises.readFile(keyPath);
      const decoded = Buffer.from(safeStorage.decryptString(encrypted), "base64");
      return decoded.length === 32 ? decoded : null;
    } catch {
      return null;
    }
  }
}

function configureToolOutputSigningKey(electronModule) {
  if (!electronModule) return;
  toolOutputSafeStorage = electronModule.safeStorage;
  toolOutputSigningKeyRecoveryPromise = null;
  toolOutputSigningKeyPromise = loadOrCreateToolOutputSigningKey(toolOutputSafeStorage);
}

async function getToolOutputSigningKey({ retry = true } = {}) {
  const key = await toolOutputSigningKeyPromise.catch(() => null);
  if (key || !retry || !toolOutputSafeStorage) return key;
  if (toolOutputSigningKeyRecoveryPromise) return toolOutputSigningKeyRecoveryPromise;
  const recovery = loadOrCreateToolOutputSigningKey(toolOutputSafeStorage).catch(() => null);
  toolOutputSigningKeyRecoveryPromise = recovery;
  try {
    const recovered = await recovery;
    toolOutputSigningKeyPromise = Promise.resolve(recovered);
    return recovered;
  } finally {
    if (toolOutputSigningKeyRecoveryPromise === recovery) {
      toolOutputSigningKeyRecoveryPromise = null;
    }
  }
}

async function ensureToolOutputSigningKeyFile(key) {
  if (!isSecureToolOutputStorageAvailable(toolOutputSafeStorage)) return true;
  const keyPath = path.join(getTempDir(), TOOL_OUTPUT_SIGNING_KEY_FILE);
  try {
    const stat = await fs.promises.lstat(keyPath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    const encrypted = toolOutputSafeStorage.encryptString(key.toString("base64"));
    await fs.promises.writeFile(keyPath, encrypted, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    return error?.code === "EEXIST";
  }
}

function unsignedToolOutputManifest(manifest) {
  return {
    record: manifest.record,
    contentFile: manifest.contentFile,
    contentBytes: manifest.contentBytes,
    contentSha256: manifest.contentSha256,
  };
}

function signToolOutputManifest(manifest, key) {
  return crypto.createHmac("sha256", key)
    .update(JSON.stringify(unsignedToolOutputManifest(manifest)))
    .digest("hex");
}

async function hasValidToolOutputManifestSignature(manifest, signingKey) {
  const key = signingKey ?? await getToolOutputSigningKey();
  if (!key || !isBoundedString(manifest.signature, 64) || !/^[a-f0-9]{64}$/.test(manifest.signature)) return false;
  const expected = Buffer.from(signToolOutputManifest(manifest, key), "hex");
  const actual = Buffer.from(manifest.signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function resolvePrivateTempDir(systemTempDir = os.tmpdir(), homeDir = os.homedir()) {
  if (typeof process.getuid !== "function") {
    return path.join(systemTempDir, NETCATTY_TEMP_DIR_NAME);
  }
  try {
    const stat = fs.lstatSync(systemTempDir);
    const isPrivate = stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === process.getuid()
      && (stat.mode & 0o077) === 0;
    if (isPrivate) return path.join(systemTempDir, NETCATTY_TEMP_DIR_NAME);
  } catch {
    // Fall through to the stable per-user directory.
  }
  return path.join(homeDir, ".netcatty", "tmp", NETCATTY_TEMP_DIR_NAME);
}

/**
 * Get the Netcatty temp directory path
 * Creates the directory if it doesn't exist
 */
function getTempDir() {
  if (cachedTempDir) {
    try {
      assertSafeTempDir(cachedTempDir, cachedTempDirIdentity);
      return cachedTempDir;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      cachedTempDir = null;
      cachedTempDirIdentity = null;
    }
  }
  
  const netcattyTempDir = resolvePrivateTempDir();
  
  try {
    if (!fs.existsSync(netcattyTempDir)) {
      fs.mkdirSync(netcattyTempDir, { recursive: true, mode: 0o700 });
      console.log(`[TempDir] Created Netcatty temp directory: ${netcattyTempDir}`);
    }
    const safeStat = assertSafeTempDir(netcattyTempDir);
    cachedTempDir = netcattyTempDir;
    cachedTempDirIdentity = { dev: safeStat.dev, ino: safeStat.ino };
    return netcattyTempDir;
  } catch (err) {
    console.error(`[TempDir] Failed to create temp directory:`, err.message);
    throw err;
  }
}

function assertSafeTempDir(tempDir, expectedIdentity) {
  const stat = fs.lstatSync(tempDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Netcatty temp path is not a safe directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Netcatty temp directory is not owned by the current user.");
  }
  if (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) {
    throw new Error("Netcatty temp directory identity changed during this process.");
  }
  fs.chmodSync(tempDir, 0o700);
  const expectedRealPath = path.join(fs.realpathSync(path.dirname(tempDir)), path.basename(tempDir));
  if (fs.realpathSync(tempDir) !== expectedRealPath) {
    throw new Error("Netcatty temp directory must not traverse symbolic links.");
  }
  return stat;
}

/**
 * Ensure the temp directory exists (call on app startup)
 */
function ensureTempDir() {
  const tempDir = getTempDir();
  console.log(`[TempDir] Netcatty temp directory: ${tempDir}`);
  return tempDir;
}

/**
 * Get temp directory info (path, size, file count)
 */
async function getTempDirInfo() {
  const tempDir = getTempDir();
  
  try {
    const files = await fs.promises.readdir(tempDir);
    let totalSize = 0;
    let fileCount = 0;
    
    for (const file of files) {
      if (file === TOOL_OUTPUT_SIGNING_KEY_FILE) continue;
      try {
        const filePath = path.join(tempDir, file);
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          fileCount++;
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
    
    return {
      path: tempDir,
      totalSize,
      fileCount,
    };
  } catch (err) {
    console.error(`[TempDir] Failed to get temp dir info:`, err.message);
    return {
      path: tempDir,
      totalSize: 0,
      fileCount: 0,
    };
  }
}

/**
 * Clear all files in the temp directory
 * Returns the number of files deleted
 */
async function clearTempDir() {
  const tempDir = getTempDir();
  let deletedCount = 0;
  let failedCount = 0;
  const resetUnavailableSigningKey = Boolean(toolOutputSafeStorage)
    && !await getToolOutputSigningKey();
  
  try {
    const files = await fs.promises.readdir(tempDir);
    
    for (const file of files) {
      if (file === TOOL_OUTPUT_SIGNING_KEY_FILE && !resetUnavailableSigningKey) continue;
      try {
        const filePath = path.join(tempDir, file);
        const stat = await fs.promises.stat(filePath);
        
        if (stat.isFile()) {
          await fs.promises.unlink(filePath);
          deletedCount++;
          console.log(`[TempDir] Deleted: ${file}`);
        } else if (stat.isDirectory()) {
          // Recursively delete subdirectories
          await fs.promises.rm(filePath, { recursive: true, force: true });
          deletedCount++;
          console.log(`[TempDir] Deleted directory: ${file}`);
        }
      } catch (err) {
        failedCount++;
        console.log(`[TempDir] Could not delete ${file}: ${err.message}`);
      }
    }

    if (resetUnavailableSigningKey) {
      toolOutputSigningKeyPromise = Promise.resolve(null);
      await getToolOutputSigningKey();
    }
    
    console.log(`[TempDir] Cleanup complete: ${deletedCount} deleted, ${failedCount} failed`);
    return { deletedCount, failedCount };
  } catch (err) {
    console.error(`[TempDir] Failed to clear temp dir:`, err.message);
    return { deletedCount: 0, failedCount: 0, error: err.message };
  }
}

/**
 * Generate a unique temp file path for a given filename
 */
function getTempFilePath(fileName) {
  const tempDir = getTempDir();
  const timestamp = Date.now();
  tempFileCounter = (tempFileCounter + 1) % 1000000;
  const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
  return path.join(tempDir, `${timestamp}_${tempFileCounter}_${safeFileName}`);
}

function getTransferTempFilePath(transferId, fileName) {
  const tempDir = getTempDir();
  const safeTransferId = String(transferId || "transfer").replace(/[^A-Za-z0-9_-]/g, "_");
  const safeFileName = String(fileName || "file").replace(/[<>:"/\\|?*]/g, "_");
  return path.join(tempDir, `.transfer_${safeTransferId}_${safeFileName}.part`);
}

function isNetcattyTempPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const tempDir = path.resolve(getTempDir());
  const resolved = path.resolve(filePath);
  const relative = path.relative(tempDir, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function openSafeToolOutputFile(filePath) {
  if (!isNetcattyTempPath(filePath)) return null;
  let file;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = await file.stat();
    assertSafeTempDir(getTempDir(), cachedTempDirIdentity);
    const pathStat = await fs.promises.lstat(filePath);
    if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      await file.close();
      return null;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_TOOL_OUTPUT_TEMP_BYTES || stat.size % 2 !== 0) {
      await file.close();
      return null;
    }
    return { file, stat };
  } catch {
    await file?.close().catch(() => {});
    return null;
  }
}

function isBoundedString(value, maxLength, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isSafeToolOutputRecord(record) {
  return record
    && record.schemaVersion === 1
    && isBoundedString(record.handleId, 200)
    && /^[A-Za-z0-9_.-]+$/.test(record.handleId)
    && isBoundedString(record.chatSessionId, 512)
    && isBoundedString(record.capabilityId, 256)
    && (record.terminalSessionId == null || isBoundedString(record.terminalSessionId, 512))
    && Number.isSafeInteger(record.totalChars)
    && record.totalChars >= 0
    && Number.isSafeInteger(record.storedChars)
    && record.storedChars >= 0
    && record.storedChars <= MAX_TOOL_OUTPUT_TEMP_CHARS
    && record.totalChars >= record.storedChars
    && typeof record.sourceTruncated === "boolean"
    && isBoundedString(record.preview, 2_000, true)
    && Number.isFinite(record.storedAt)
    && record.storedAt > 0
    && Number.isFinite(record.accessedAt)
    && record.accessedAt > 0;
}

function toolOutputManifestPath(filePath) {
  return `${filePath}.meta.json`;
}

function toolOutputOwnershipMarker(chatSessionId, terminalSessionId) {
  const digest = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `_tool-output-${digest(chatSessionId)}-${digest(terminalSessionId ?? "")}-`;
}

async function deleteToolOutputsByOwnership(chatSessionId, terminalSessionId) {
  const tempDir = getTempDir();
  const marker = terminalSessionId == null
    ? `_tool-output-${crypto.createHash("sha256").update(chatSessionId).digest("hex").slice(0, 24)}-`
    : toolOutputOwnershipMarker(chatSessionId, terminalSessionId);
  let deletedCount = 0;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return { deletedCount };
  }
  for (const file of files) {
    if (!file.includes(marker) || !file.endsWith(".log")) continue;
    if (await deleteToolOutputPair(path.join(tempDir, file))) deletedCount += 1;
  }
  return { deletedCount };
}

async function deleteToolOutputsByTerminal(terminalSessionId) {
  const tempDir = getTempDir();
  const terminalHash = crypto.createHash("sha256").update(terminalSessionId).digest("hex").slice(0, 24);
  const marker = new RegExp(`_tool-output-[a-f0-9]{24}-${terminalHash}-`);
  let deletedCount = 0;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return { deletedCount };
  }
  for (const file of files) {
    if (!marker.test(file) || !file.endsWith(".log")) continue;
    if (await deleteToolOutputPair(path.join(tempDir, file))) deletedCount += 1;
  }
  return { deletedCount };
}

async function safeUnlink(filePath) {
  if (!isNetcattyTempPath(filePath)) return false;
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function deleteToolOutputPair(filePath) {
  const manifestPath = toolOutputManifestPath(filePath);
  const manifestDeleted = await safeUnlink(manifestPath);
  const contentDeleted = await safeUnlink(filePath);
  return manifestDeleted && contentDeleted;
}

async function readSafeManifest(manifestPath, signingKey) {
  if (!isNetcattyTempPath(manifestPath) || !manifestPath.endsWith(".log.meta.json")) return null;
  let file;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    file = await fs.promises.open(manifestPath, fs.constants.O_RDONLY | noFollow);
    const stat = await file.stat();
    const pathStat = await fs.promises.lstat(manifestPath);
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || stat.size > TOOL_OUTPUT_MANIFEST_MAX_BYTES
      || pathStat.isSymbolicLink()
      || pathStat.dev !== stat.dev
      || pathStat.ino !== stat.ino
    ) return null;
    const parsed = JSON.parse(await file.readFile({ encoding: "utf8" }));
    if (!isSafeToolOutputRecord(parsed.record)) return null;
    if (!isBoundedString(parsed.contentFile, 512) || path.basename(parsed.contentFile) !== parsed.contentFile) return null;
    if (!Number.isSafeInteger(parsed.contentBytes) || parsed.contentBytes < 0 || parsed.contentBytes > MAX_TOOL_OUTPUT_TEMP_BYTES) return null;
    if (!isBoundedString(parsed.contentSha256, 64) || !/^[a-f0-9]{64}$/.test(parsed.contentSha256)) return null;
    if (!await hasValidToolOutputManifestSignature(parsed, signingKey)) return null;
    const contentPath = path.join(getTempDir(), parsed.contentFile);
    if (toolOutputManifestPath(contentPath) !== manifestPath) return null;
    return { manifest: parsed, manifestPath, manifestStat: stat, contentPath };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function readVerifiedManifestContent(entry) {
  const opened = await openSafeToolOutputFile(entry.contentPath);
  if (!opened) return null;
  try {
    if (opened.stat.size !== entry.manifest.contentBytes) return null;
    const contentBuffer = await opened.file.readFile();
    const digest = crypto.createHash("sha256").update(contentBuffer).digest("hex");
    if (digest !== entry.manifest.contentSha256) return null;
    return { stat: opened.stat, contentBuffer };
  } finally {
    await opened.file.close();
  }
}

async function verifyManifestContent(entry) {
  return Boolean(await readVerifiedManifestContent(entry));
}

async function listToolOutputManifestEntries() {
  const tempDir = getTempDir();
  const entries = [];
  const signingKey = await getToolOutputSigningKey();
  if (!signingKey) return entries;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return entries;
  }
  for (const file of files) {
    if (!file.endsWith(".log.meta.json")) continue;
    const entry = await readSafeManifest(path.join(tempDir, file), signingKey);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function touchToolOutputEntry(entry, now = new Date()) {
  const key = await getToolOutputSigningKey();
  if (!key) return false;
  const pendingPath = getTempFilePath(`${entry.manifest.record.handleId}.manifest.pending`);
  const manifest = {
    ...unsignedToolOutputManifest(entry.manifest),
    record: { ...entry.manifest.record, accessedAt: now.getTime() },
  };
  manifest.signature = signToolOutputManifest(manifest, key);
  try {
    await fs.promises.writeFile(pendingPath, JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.promises.rename(pendingPath, entry.manifestPath);
    entry.manifest = manifest;
    entry.manifestStat = await fs.promises.stat(entry.manifestPath);
    return true;
  } catch {
    await safeUnlink(pendingPath);
    return false;
  }
}

function isToolOutputEntryExpired(entry, now = Date.now()) {
  return now - entry.manifest.record.accessedAt >= TOOL_OUTPUT_PERSISTED_TTL_MS;
}

async function enforcePersistedToolOutputLimits() {
  const entries = await listToolOutputManifestEntries();
  const active = [...entries].sort((a, b) => (
    b.manifest.record.accessedAt - a.manifest.record.accessedAt
  ));
  const kept = [];
  const sessionCounts = new Map();
  const sessionChars = new Map();
  let globalChars = 0;
  for (const entry of active) {
    if (!await verifyManifestContent(entry)) {
      await deleteToolOutputPair(entry.contentPath);
      continue;
    }
    const { chatSessionId, storedChars } = entry.manifest.record;
    const sessionCount = sessionCounts.get(chatSessionId) ?? 0;
    const sessionTotal = sessionChars.get(chatSessionId) ?? 0;
    const keep = kept.length < TOOL_OUTPUT_MAX_HANDLES_GLOBAL
      && globalChars + storedChars <= TOOL_OUTPUT_MAX_CHARS_GLOBAL
      && sessionCount < TOOL_OUTPUT_MAX_HANDLES_PER_SESSION
      && sessionTotal + storedChars <= TOOL_OUTPUT_MAX_CHARS_PER_SESSION;
    if (!keep) {
      await deleteToolOutputPair(entry.contentPath);
      continue;
    }
    kept.push(entry);
    globalChars += storedChars;
    sessionCounts.set(chatSessionId, sessionCount + 1);
    sessionChars.set(chatSessionId, sessionTotal + storedChars);
  }
}

async function cleanupExpiredToolOutputFiles(now = Date.now()) {
  const tempDir = getTempDir();
  let deletedCount = 0;
  try {
    const files = await fs.promises.readdir(tempDir);
    const signingKeyAvailable = Boolean(await getToolOutputSigningKey());
    const managedContent = new Set();
    for (const file of files) {
      if (
        file.endsWith(".manifest.pending")
        || (file.startsWith(`${TOOL_OUTPUT_SIGNING_KEY_FILE}.`) && file.endsWith(".pending"))
      ) {
        const pendingPath = path.join(tempDir, file);
        try {
          const stat = await fs.promises.lstat(pendingPath);
          if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= TOOL_OUTPUT_ORPHAN_TTL_MS) {
            if (await safeUnlink(pendingPath)) deletedCount += 1;
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      if (!file.endsWith(".log.meta.json")) continue;
      const manifestPath = path.join(tempDir, file);
      if (!signingKeyAvailable) {
        try {
          const stat = await fs.promises.lstat(manifestPath);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          const contentPath = manifestPath.slice(0, -".meta.json".length);
          if (now - stat.mtimeMs >= TOOL_OUTPUT_PERSISTED_TTL_MS) {
            if (await safeUnlink(manifestPath)) deletedCount += 1;
            if (await safeUnlink(contentPath)) deletedCount += 1;
          } else {
            managedContent.add(path.basename(contentPath));
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      const entry = await readSafeManifest(manifestPath);
      if (!entry) {
        try {
          const stat = await fs.promises.lstat(manifestPath);
          if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= TOOL_OUTPUT_ORPHAN_TTL_MS) {
            if (await safeUnlink(manifestPath)) deletedCount += 1;
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      if (!await verifyManifestContent(entry)) {
        if (await safeUnlink(entry.manifestPath)) deletedCount += 1;
        if (await safeUnlink(entry.contentPath)) deletedCount += 1;
        continue;
      }
      managedContent.add(path.basename(entry.contentPath));
      if (!isToolOutputEntryExpired(entry, now)) continue;
      if (await safeUnlink(entry.manifestPath)) deletedCount += 1;
      if (await safeUnlink(entry.contentPath)) deletedCount += 1;
    }
    for (const file of files) {
      if (!file.includes("_tool-output-") || !file.endsWith(".log")) continue;
      if (managedContent.has(file)) continue;
      const filePath = path.join(tempDir, file);
      try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (now - stat.mtimeMs < TOOL_OUTPUT_ORPHAN_TTL_MS) continue;
        await fs.promises.unlink(filePath);
        deletedCount += 1;
      } catch {
        // Best-effort startup cleanup.
      }
    }
  } catch {
    // Temp persistence is optional; keep startup resilient.
  }
  if (await getToolOutputSigningKey()) {
    await enforcePersistedToolOutputLimits();
  }
  return deletedCount;
}

function safeUtf16SliceBounds(content, requestedStart, requestedEnd) {
  let start = Math.min(content.length, Math.max(0, requestedStart));
  let end = Math.min(content.length, Math.max(start, requestedEnd));
  const isHigh = value => value >= 0xd800 && value <= 0xdbff;
  const isLow = value => value >= 0xdc00 && value <= 0xdfff;
  if (start > 0 && start < content.length && isLow(content.charCodeAt(start))) start -= 1;
  if (end > start && end < content.length && isHigh(content.charCodeAt(end - 1))) end -= 1;
  return [start, end];
}

async function readToolOutputChunk(content, request) {
  const storedChars = content.length;
  const requestedMax = Number.isFinite(request?.maxChars) ? Math.floor(request.maxChars) : TOOL_OUTPUT_READ_MAX_CHARS;
  const maxChars = Math.min(TOOL_OUTPUT_READ_MAX_CHARS, Math.max(1, requestedMax));
  const mode = request?.mode ?? "head";

  if (mode === "search") {
    const query = String(request?.query ?? "");
    if (!query) {
      return { mode, content: "Search query is required.", totalChars: storedChars, startOffset: 0, endOffset: 0, nextOffset: 0, hasMore: false, matchOffsets: [] };
    }
    const haystack = content.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const offsets = [];
    let cursor = Math.max(0, Math.floor(request?.offset ?? 0));
    while (offsets.length < TOOL_OUTPUT_SEARCH_MAX_MATCHES) {
      const match = haystack.indexOf(needle, cursor);
      if (match < 0) break;
      offsets.push(match);
      cursor = match + Math.max(1, needle.length);
    }
    const excerpts = [];
    const renderedOffsets = [];
    let renderedChars = 0;
    for (const match of offsets) {
      const [start, end] = safeUtf16SliceBounds(content, match - TOOL_OUTPUT_SEARCH_CONTEXT_CHARS, match + query.length + TOOL_OUTPUT_SEARCH_CONTEXT_CHARS);
      const excerpt = `[match offset=${match}]\n${content.slice(start, end)}`;
      const separator = excerpts.length > 0 ? "\n\n" : "";
      const available = maxChars - renderedChars - separator.length;
      if (available <= 0) break;
      if (excerpt.length > available) {
        if (excerpts.length > 0) break;
        const [, safeEnd] = safeUtf16SliceBounds(excerpt, 0, available);
        excerpts.push(excerpt.slice(0, safeEnd));
        renderedOffsets.push(match);
        renderedChars += safeEnd;
        break;
      }
      excerpts.push(excerpt);
      renderedOffsets.push(match);
      renderedChars += separator.length + excerpt.length;
    }
    const nextOffset = renderedOffsets.length
      ? renderedOffsets[renderedOffsets.length - 1] + Math.max(1, query.length)
      : storedChars;
    return {
      mode,
      content: excerpts.join("\n\n") || `No matches found for "${query}".`,
      totalChars: storedChars,
      startOffset: Math.max(0, Math.floor(request?.offset ?? 0)),
      endOffset: nextOffset,
      nextOffset,
      hasMore: haystack.indexOf(needle, nextOffset) >= 0,
      matchOffsets: renderedOffsets,
    };
  }

  let startOffset = mode === "tail"
    ? Math.max(0, storedChars - maxChars)
    : mode === "range" ? Math.min(storedChars, Math.max(0, Math.floor(request?.offset ?? 0))) : 0;
  const readStart = Math.max(0, startOffset - 1);
  const window = content.slice(readStart, Math.min(storedChars, readStart + maxChars + 2));
  const relativeStart = startOffset - readStart;
  const [safeStart, safeEnd] = safeUtf16SliceBounds(window, relativeStart, relativeStart + maxChars);
  startOffset = readStart + safeStart;
  const chunk = window.slice(safeStart, safeEnd);
  const endOffset = startOffset + chunk.length;
  return { mode, content: chunk, totalChars: storedChars, startOffset, endOffset, nextOffset: endOffset, hasMore: endOffset < storedChars };
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain, shell, electronModule) {
  configureToolOutputSigningKey(electronModule);
  void cleanupExpiredToolOutputFiles();
  ipcMain.handle("netcatty:tempdir:getInfo", async () => {
    return getTempDirInfo();
  });
  
  ipcMain.handle("netcatty:tempdir:clear", async () => {
    return clearTempDir();
  });
  
  ipcMain.handle("netcatty:tempdir:getPath", () => {
    return getTempDir();
  });
  
  ipcMain.handle("netcatty:tempdir:open", async () => {
    const tempDir = getTempDir();
    if (shell?.openPath) {
      await shell.openPath(tempDir);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputPersistenceStatus", async () => {
    const durable = Boolean(await getToolOutputSigningKey());
    return {
      durable,
      reason: durable ? undefined : "Secure local storage is unavailable.",
    };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputWrite", async (_event, payload = {}) => {
    const content = String(payload.content ?? "");
    const record = payload.record;
    if (
      !isSafeToolOutputRecord(record)
      || content.length > MAX_TOOL_OUTPUT_TEMP_CHARS
      || record.storedChars !== content.length
    ) {
      return { ok: false, error: "Tool output exceeds the temp-file limit." };
    }
    const contentBuffer = Buffer.from(content, "utf16le");
    if (contentBuffer.length > MAX_TOOL_OUTPUT_TEMP_BYTES) {
      return { ok: false, error: "Tool output exceeds the temp-file limit." };
    }
    const ownershipMarker = toolOutputOwnershipMarker(record.chatSessionId, record.terminalSessionId);
    const chatDeletionGeneration = getToolOutputChatDeletionGeneration(record.chatSessionId);
    const filePath = getTempFilePath(`${ownershipMarker.slice(1)}${record.handleId}.log`);
    const manifestPath = toolOutputManifestPath(filePath);
    const pendingManifestPath = getTempFilePath(`${record.handleId}.manifest.pending`);
    try {
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        throw new Error("Terminal session is already closed.");
      }
      await toolOutputSessionDeletions.get(record.chatSessionId);
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        throw new Error("Chat session was cleared while output was being saved.");
      }
      const signingKey = await getToolOutputSigningKey();
      if (!signingKey) throw new Error("Secure local storage is unavailable.");
      if (!await ensureToolOutputSigningKeyFile(signingKey)) {
        throw new Error("Unable to prepare secure local storage.");
      }
      await fs.promises.writeFile(filePath, contentBuffer, { mode: 0o600, flag: "wx" });
      const manifest = {
        record,
        contentFile: path.basename(filePath),
        contentBytes: contentBuffer.length,
        contentSha256: crypto.createHash("sha256").update(contentBuffer).digest("hex"),
      };
      manifest.signature = signToolOutputManifest(manifest, signingKey);
      await fs.promises.writeFile(pendingManifestPath, JSON.stringify(manifest), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(pendingManifestPath, manifestPath);
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        await deleteToolOutputPair(filePath);
        throw new Error("Chat session was cleared while output was being saved.");
      }
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        await deleteToolOutputPair(filePath);
        throw new Error("Terminal session closed while output was being saved.");
      }
      await enforcePersistedToolOutputLimits();
      const persistedEntry = await readSafeManifest(manifestPath);
      if (!persistedEntry || path.resolve(persistedEntry.contentPath) !== path.resolve(filePath)) {
        throw new Error("Saved output was removed while enforcing storage limits.");
      }
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        await deleteToolOutputPair(filePath);
        throw new Error("Chat session was cleared while output was being saved.");
      }
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        await deleteToolOutputPair(filePath);
        throw new Error("Terminal session closed while output was being saved.");
      }
      return { ok: true, path: filePath, manifestPath };
    } catch (error) {
      await Promise.allSettled([
        safeUnlink(pendingManifestPath),
        safeUnlink(manifestPath),
        safeUnlink(filePath),
      ]);
      return { ok: false, error: error?.message || "Unable to persist tool output." };
    }
  });

  ipcMain.handle("netcatty:tempdir:toolOutputRestore", async (_event, payload = {}) => {
    const handleId = String(payload.handleId ?? "");
    const chatSessionId = String(payload.chatSessionId ?? "");
    if (!isBoundedString(handleId, 200) || !isBoundedString(chatSessionId, 512)) return null;
    const chatDeletionGeneration = getToolOutputChatDeletionGeneration(chatSessionId);
    await toolOutputSessionDeletions.get(chatSessionId);
    if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) return null;
    const entries = await listToolOutputManifestEntries();
    const entry = entries.find(candidate => (
      candidate.manifest.record.handleId === handleId
      && candidate.manifest.record.chatSessionId === chatSessionId
    ));
    if (!entry) return null;
    if (
      entry.manifest.record.terminalSessionId
      && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
    ) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    if (isToolOutputEntryExpired(entry)) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    if (!await verifyManifestContent(entry)) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    if (
      entry.manifest.record.terminalSessionId
      && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
    ) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    await touchToolOutputEntry(entry);
    if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    if (
      entry.manifest.record.terminalSessionId
      && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
    ) {
      await deleteToolOutputPair(entry.contentPath);
      return null;
    }
    return {
      path: entry.contentPath,
      record: entry.manifest.record,
    };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputRead", async (_event, payload = {}) => {
    const filePath = payload.path;
    const manifestEntry = await readSafeManifest(toolOutputManifestPath(filePath));
    if (!manifestEntry || path.resolve(manifestEntry.contentPath) !== path.resolve(filePath)) return null;
    const chatSessionId = manifestEntry.manifest.record.chatSessionId;
    const chatDeletionGeneration = getToolOutputChatDeletionGeneration(chatSessionId);
    await toolOutputSessionDeletions.get(chatSessionId);
    if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) return null;
    if (
      manifestEntry.manifest.record.terminalSessionId
      && closedToolOutputTerminalSessions.has(manifestEntry.manifest.record.terminalSessionId)
    ) {
      await deleteToolOutputPair(manifestEntry.contentPath);
      return null;
    }
    if (isToolOutputEntryExpired(manifestEntry)) {
      await deleteToolOutputPair(manifestEntry.contentPath);
      return null;
    }
    const verified = await readVerifiedManifestContent(manifestEntry);
    if (!verified) {
      await deleteToolOutputPair(manifestEntry.contentPath);
      return null;
    }
    const content = verified.contentBuffer.toString("utf16le");
    const result = !payload.request ? content : await readToolOutputChunk(content, payload.request);
    await touchToolOutputEntry(manifestEntry);
    if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) {
      await deleteToolOutputPair(manifestEntry.contentPath);
      return null;
    }
    if (
      manifestEntry.manifest.record.terminalSessionId
      && closedToolOutputTerminalSessions.has(manifestEntry.manifest.record.terminalSessionId)
    ) {
      await deleteToolOutputPair(manifestEntry.contentPath);
      return null;
    }
    return result;
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDelete", async (_event, payload = {}) => {
    const filePath = payload.path;
    if (!isNetcattyTempPath(filePath)) return { ok: false };
    return { ok: await deleteToolOutputPair(filePath) };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteSession", async (_event, payload = {}) => {
    const chatSessionId = String(payload.chatSessionId ?? "");
    if (!isBoundedString(chatSessionId, 512)) return { deletedCount: 0 };
    toolOutputChatDeletionGenerations.set(
      chatSessionId,
      getToolOutputChatDeletionGeneration(chatSessionId) + 1,
    );
    const existing = toolOutputSessionDeletions.get(chatSessionId);
    if (existing) return existing;
    const deletion = (async () => {
      return deleteToolOutputsByOwnership(chatSessionId);
    })().finally(() => {
      if (toolOutputSessionDeletions.get(chatSessionId) === deletion) {
        toolOutputSessionDeletions.delete(chatSessionId);
      }
    });
    toolOutputSessionDeletions.set(chatSessionId, deletion);
    return deletion;
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteTerminalSession", async (_event, payload = {}) => {
    const chatSessionId = String(payload.chatSessionId ?? "");
    const terminalSessionId = String(payload.terminalSessionId ?? "");
    if (!isBoundedString(chatSessionId, 512) || !isBoundedString(terminalSessionId, 512)) {
      return { deletedCount: 0 };
    }
    closedToolOutputTerminalSessions.add(terminalSessionId);
    return deleteToolOutputsByOwnership(chatSessionId, terminalSessionId);
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteTerminal", async (_event, payload = {}) => {
    const terminalSessionId = String(payload.terminalSessionId ?? "");
    if (!isBoundedString(terminalSessionId, 512)) return { deletedCount: 0 };
    closedToolOutputTerminalSessions.add(terminalSessionId);
    return deleteToolOutputsByTerminal(terminalSessionId);
  });
}

module.exports = {
  getTempDir,
  ensureTempDir,
  getTempDirInfo,
  clearTempDir,
  getTempFilePath,
  getTransferTempFilePath,
  cleanupExpiredToolOutputFiles,
  registerHandlers,
  resolvePrivateTempDir,
  isSecureToolOutputStorageAvailable,
};
