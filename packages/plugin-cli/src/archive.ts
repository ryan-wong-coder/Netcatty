import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import type { PluginManifest } from "@netcatty/plugin-contract";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { IGNORED_ROOT_ENTRIES, PACKAGE_LIMITS } from "./constants.js";
import { readAndValidateManifest, validateManifestValue } from "./manifest.js";
import { assertSafePackagePath, PackagePathRegistry } from "./packagePath.js";

const CRC32_TABLE = new Uint32Array(256);
const EXECUTABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".exe", ".ps1"]);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly packagePath: string;
  readonly size: number;
  readonly crc32: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface PackageBuildResult {
  readonly outputPath: string;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
  readonly archiveBytes: number;
  readonly sha256: string;
}

export interface PackageValidationResult {
  readonly manifest: PluginManifest;
  readonly fileCount: number;
  readonly uncompressedBytes: number;
}

export type PluginDirectoryValidationResult = PackageValidationResult;

function updateCrc32(current: number, chunk: Buffer): number {
  let crc = current;
  for (const byte of chunk) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

async function readRegularFile(
  filePath: string,
  onChunk: (chunk: Buffer) => void,
): Promise<{ size: number; mode: number }> {
  const noFollow = "O_NOFOLLOW" in constants
    ? constants.O_NOFOLLOW
    : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error(`Package source is not a regular file: ${filePath}`);
    let size = 0;
    const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      onChunk(buffer);
    }
    return { size, mode: fileStats.mode };
  } finally {
    await handle.close();
  }
}

async function hashFile(
  filePath: string,
): Promise<{ crc32: number; sha256: string; size: number; mode: number }> {
  const sha256 = createHash("sha256");
  let crc = 0xffffffff;
  const file = await readRegularFile(filePath, (buffer) => {
    sha256.update(buffer);
    crc = updateCrc32(crc, buffer);
  });
  return {
    crc32: (crc ^ 0xffffffff) >>> 0,
    sha256: sha256.digest("hex"),
    size: file.size,
    mode: file.mode,
  };
}

function sortPackagePaths(left: ScannedFile, right: ScannedFile): number {
  return Buffer.compare(Buffer.from(left.packagePath), Buffer.from(right.packagePath));
}

function isExecutablePackageFile(packagePath: string, mode: number): boolean {
  return (mode & 0o111) !== 0
    || EXECUTABLE_EXTENSIONS.has(path.posix.extname(packagePath).toLowerCase());
}

async function scanPackageDirectory(
  pluginDirectory: string,
  manifest: PluginManifest,
): Promise<ScannedFile[]> {
  const registry = new PackagePathRegistry();
  const companionPaths = new Map(
    (manifest.companionExecutables ?? []).map((companion) => [companion.path, companion]),
  );
  const files: ScannedFile[] = [];
  let totalBytes = 0;

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (
        relativeDirectory === ""
        && (IGNORED_ROOT_ENTRIES.has(entry.name) || entry.name.endsWith(".ncpkg"))
      ) {
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const packagePath = assertSafePackagePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      const fileStats = await lstat(absolutePath);
      if (fileStats.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in plugin packages: ${packagePath}`);
      }
      if (fileStats.isDirectory()) {
        await visit(absolutePath, packagePath);
        continue;
      }
      if (!fileStats.isFile()) {
        throw new Error(`Only regular files are allowed in plugin packages: ${packagePath}`);
      }
      registry.add(packagePath);
      if (files.length + 1 > PACKAGE_LIMITS.fileCount) {
        throw new Error(`Plugin package exceeds ${PACKAGE_LIMITS.fileCount} files`);
      }
      if (fileStats.size > PACKAGE_LIMITS.singleFileBytes) {
        throw new Error(`Plugin file exceeds ${PACKAGE_LIMITS.singleFileBytes} bytes: ${packagePath}`);
      }
      totalBytes += fileStats.size;
      if (totalBytes > PACKAGE_LIMITS.uncompressedBytes) {
        throw new Error(
          `Plugin package exceeds ${PACKAGE_LIMITS.uncompressedBytes} uncompressed bytes`,
        );
      }
      const hashes = await hashFile(absolutePath);
      if (hashes.size !== fileStats.size || hashes.mode !== fileStats.mode) {
        throw new Error(`Package source changed while it was being scanned: ${packagePath}`);
      }
      const isExecutable = isExecutablePackageFile(packagePath, hashes.mode);
      if (isExecutable && !companionPaths.has(packagePath)) {
        throw new Error(`Executable file is not declared as a companion: ${packagePath}`);
      }
      const companion = companionPaths.get(packagePath);
      if (companion && companion.sha256 !== hashes.sha256) {
        throw new Error(`Companion SHA-256 mismatch: ${packagePath}`);
      }
      files.push({
        absolutePath,
        packagePath,
        size: fileStats.size,
        executable: Boolean(companion),
        crc32: hashes.crc32,
        sha256: hashes.sha256,
      });
    }
  }

  await visit(pluginDirectory, "");
  const packagedPaths = new Set(files.map(({ packagePath }) => packagePath));
  const requiredPaths = [
    "netcatty.plugin.json",
    manifest.main.browser,
    manifest.main.node,
    ...(manifest.contributes?.views ?? []).map(({ entry }) => entry),
    ...companionPaths.keys(),
  ].filter((entryPath): entryPath is string => Boolean(entryPath));
  for (const requiredPath of requiredPaths) {
    if (!packagedPaths.has(requiredPath)) {
      throw new Error(`Manifest references a missing package file: ${requiredPath}`);
    }
  }
  return files.sort(sortPackagePaths);
}

function makeLocalHeader(file: ScannedFile): Buffer {
  const name = Buffer.from(file.packagePath, "utf8");
  const header = Buffer.alloc(30 + name.byteLength);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(file.crc32, 14);
  header.writeUInt32LE(file.size, 18);
  header.writeUInt32LE(file.size, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function makeCentralHeader(file: ScannedFile, localOffset: number): Buffer {
  const name = Buffer.from(file.packagePath, "utf8");
  const header = Buffer.alloc(46 + name.byteLength);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(file.crc32, 16);
  header.writeUInt32LE(file.size, 20);
  header.writeUInt32LE(file.size, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const mode = file.executable ? 0o100755 : 0o100644;
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  name.copy(header, 46);
  return header;
}

function makeEndOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

async function writeBuffer(output: ReturnType<typeof createWriteStream>, buffer: Buffer) {
  if (!output.write(buffer)) await once(output, "drain");
}

async function writeArchive(files: readonly ScannedFile[], outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  const centralHeaders: Buffer[] = [];
  let offset = 0;
  try {
    await once(output, "open");
    for (const file of files) {
      const localHeader = makeLocalHeader(file);
      centralHeaders.push(makeCentralHeader(file, offset));
      await writeBuffer(output, localHeader);
      offset += localHeader.byteLength;
      const sha256 = createHash("sha256");
      let crc = 0xffffffff;
      let writtenBytes = 0;
      const input = await open(
        file.absolutePath,
        constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      );
      try {
        const inputStats = await input.stat();
        if (!inputStats.isFile() || inputStats.size !== file.size) {
          throw new Error(`Package source changed before archive write: ${file.packagePath}`);
        }
        const stream = createReadStream(file.absolutePath, { fd: input.fd, autoClose: false });
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          writtenBytes += buffer.byteLength;
          sha256.update(buffer);
          crc = updateCrc32(crc, buffer);
          await writeBuffer(output, buffer);
          offset += buffer.byteLength;
        }
      } finally {
        await input.close();
      }
      if (
        writtenBytes !== file.size
        || ((crc ^ 0xffffffff) >>> 0) !== file.crc32
        || sha256.digest("hex") !== file.sha256
      ) {
        throw new Error(`Package source changed while it was being written: ${file.packagePath}`);
      }
    }
    const centralOffset = offset;
    for (const centralHeader of centralHeaders) {
      await writeBuffer(output, centralHeader);
      offset += centralHeader.byteLength;
    }
    await writeBuffer(
      output,
      makeEndOfCentralDirectory(files.length, offset - centralOffset, centralOffset),
    );
    output.end();
    await once(output, "close");
    const archiveStats = await stat(temporaryPath);
    if (archiveStats.size > PACKAGE_LIMITS.archiveBytes) {
      throw new Error(`Plugin archive exceeds ${PACKAGE_LIMITS.archiveBytes} bytes`);
    }
    await rename(temporaryPath, outputPath);
  } catch (error) {
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function buildPluginPackage(
  pluginDirectory: string,
  outputPath: string,
): Promise<PackageBuildResult> {
  const sourceDirectory = path.resolve(pluginDirectory);
  const resolvedOutputPath = path.resolve(outputPath);
  if (!resolvedOutputPath.endsWith(".ncpkg")) {
    throw new Error("Plugin package output must use the .ncpkg extension");
  }
  const manifest = await readAndValidateManifest(sourceDirectory);
  const files = await scanPackageDirectory(sourceDirectory, manifest);
  await writeArchive(files, resolvedOutputPath);
  const outputStats = await stat(resolvedOutputPath);
  const archiveHash = await hashFile(resolvedOutputPath);
  return {
    outputPath: resolvedOutputPath,
    fileCount: files.length,
    uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
    archiveBytes: outputStats.size,
    sha256: archiveHash.sha256,
  };
}

export async function validatePluginDirectory(
  pluginDirectory: string,
): Promise<PluginDirectoryValidationResult> {
  const sourceDirectory = path.resolve(pluginDirectory);
  const manifest = await readAndValidateManifest(sourceDirectory);
  const files = await scanPackageDirectory(sourceDirectory, manifest);
  return {
    manifest,
    fileCount: files.length,
    uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(error ?? new Error("Unable to open plugin archive"));
        else resolve(zipFile);
      },
    );
  });
}

interface ReadArchiveEntryResult {
  readonly bytes: number;
  readonly crc32: number;
  readonly sha256: string;
  readonly contents?: Buffer;
}

function readEntry(
  zipFile: ZipFile,
  entry: Entry,
  captureContents: boolean,
): Promise<ReadArchiveEntryResult> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read archive entry: ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      const sha256 = createHash("sha256");
      let crc = 0xffffffff;
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        bytes += chunk.byteLength;
        if (bytes > PACKAGE_LIMITS.singleFileBytes) {
          stream.destroy(new Error(`Plugin file exceeds size limit: ${entry.fileName}`));
          return;
        }
        sha256.update(buffer);
        crc = updateCrc32(crc, buffer);
        if (captureContents) chunks.push(buffer);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve({
        bytes,
        crc32: (crc ^ 0xffffffff) >>> 0,
        sha256: sha256.digest("hex"),
        contents: captureContents ? Buffer.concat(chunks) : undefined,
      }));
    });
  });
}

export async function validatePluginPackage(
  archivePath: string,
): Promise<PackageValidationResult> {
  const archiveStats = await stat(archivePath);
  if (archiveStats.size > PACKAGE_LIMITS.archiveBytes) {
    throw new Error(`Plugin archive exceeds ${PACKAGE_LIMITS.archiveBytes} bytes`);
  }
  const zipFile = await openZip(archivePath);
  const registry = new PackagePathRegistry();
  const entries = new Map<string, { contents?: Buffer; mode: number; sha256: string }>();
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zipFile.close();
      reject(error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", resolve);
    zipFile.on("entry", (entry: Entry) => {
      void (async () => {
        try {
          const packagePath = registry.add(entry.fileName);
          if (entries.size + 1 > PACKAGE_LIMITS.fileCount) {
            throw new Error(`Plugin package exceeds ${PACKAGE_LIMITS.fileCount} files`);
          }
          if ((entry.generalPurposeBitFlag & 1) !== 0) {
            throw new Error(`Encrypted ZIP entries are not allowed: ${packagePath}`);
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            throw new Error(`Unsupported ZIP compression method: ${packagePath}`);
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = mode & 0o170000;
          if (fileType !== 0 && fileType !== 0o100000) {
            throw new Error(`Only regular files are allowed: ${packagePath}`);
          }
          if (entry.uncompressedSize > PACKAGE_LIMITS.singleFileBytes) {
            throw new Error(`Plugin file exceeds size limit: ${packagePath}`);
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > PACKAGE_LIMITS.uncompressedBytes) {
            throw new Error("Plugin package exceeds the uncompressed size limit");
          }
          const result = await readEntry(
            zipFile,
            entry,
            packagePath === "netcatty.plugin.json",
          );
          if (result.bytes !== entry.uncompressedSize || result.crc32 !== entry.crc32) {
            throw new Error(`ZIP entry integrity check failed: ${packagePath}`);
          }
          entries.set(packagePath, {
            contents: result.contents,
            mode,
            sha256: result.sha256,
          });
          zipFile.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zipFile.readEntry();
  });

  const manifestEntry = entries.get("netcatty.plugin.json");
  if (!manifestEntry?.contents) throw new Error("Plugin package is missing netcatty.plugin.json");
  if (manifestEntry.contents.byteLength > PACKAGE_LIMITS.manifestBytes) {
    throw new Error("Plugin manifest exceeds the size limit");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestEntry.contents.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Plugin manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validation = validateManifestValue(manifestValue);
  if (!validation.valid || !validation.manifest) {
    throw new Error(`Plugin manifest is invalid:\n- ${validation.errors.join("\n- ")}`);
  }
  const manifest = validation.manifest;
  const declaredCompanions = new Map(
    (manifest.companionExecutables ?? []).map((companion) => [companion.path, companion]),
  );
  for (const [packagePath, entry] of entries) {
    const isExecutable = isExecutablePackageFile(packagePath, entry.mode);
    if (isExecutable && !declaredCompanions.has(packagePath)) {
      throw new Error(`Executable file is not declared as a companion: ${packagePath}`);
    }
  }
  const requiredPaths = [
    manifest.main.browser,
    manifest.main.node,
    ...(manifest.contributes?.views ?? []).map(({ entry }) => entry),
  ].filter((entryPath): entryPath is string => Boolean(entryPath));
  for (const requiredPath of requiredPaths) {
    if (!entries.has(requiredPath)) {
      throw new Error(`Manifest references a missing package file: ${requiredPath}`);
    }
  }
  for (const [companionPath, companion] of declaredCompanions) {
    const entry = entries.get(companionPath);
    if (!entry) throw new Error(`Manifest references a missing companion: ${companionPath}`);
    if (entry.sha256 !== companion.sha256) {
      throw new Error(`Companion SHA-256 mismatch: ${companionPath}`);
    }
  }
  return { manifest, fileCount: entries.size, uncompressedBytes: totalBytes };
}
