"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { constants } = fs;
const {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

const {
  assertPluginStorageSegment,
  isPathInside,
  resolveInstalledVersionDirectory,
} = require("./paths.cjs");

const INSTALL_METADATA_FILE = "install.json";
const PACKAGE_DIRECTORY = "package";
const REMOVAL_METADATA_FILE = "remove.json";
const REMOVED_PLUGIN_DIRECTORY = "plugin";

async function loadPluginCli() {
  return import("@netcatty/plugin-cli");
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

async function copyImmutableArchive(sourcePath, destinationPath, maxBytes) {
  const sourcePathStats = await lstat(sourcePath);
  if (!sourcePathStats.isFile() || sourcePathStats.isSymbolicLink()) {
    throw new Error("Plugin package source must be a regular non-symbolic file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  let destination;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error("Plugin package source must be a regular file");
    if (before.size > maxBytes) throw new Error(`Plugin archive exceeds ${maxBytes} bytes`);
    destination = await open(destinationPath, "wx", 0o600);
    const sha256 = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written);
        if (result.bytesWritten === 0) throw new Error("Unable to stage the complete plugin package");
        written += result.bytesWritten;
      }
    }
    const after = await source.stat();
    if (
      position !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || (before.ino && after.ino && before.ino !== after.ino)
    ) {
      throw new Error("Plugin package source changed while it was staged");
    }
    await destination.sync();
    return { bytes: position, sha256: sha256.digest("hex") };
  } finally {
    await destination?.close();
    await source.close();
  }
}

function validateInstallMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plugin install metadata");
  }
  const pluginId = assertPluginStorageSegment(value.pluginId, "ID");
  const version = assertPluginStorageSegment(value.version, "version");
  if (!/^[a-f0-9]{64}$/u.test(value.archiveSha256)) {
    throw new Error("Invalid plugin install archive hash");
  }
  return { pluginId, version, archiveSha256: value.archiveSha256 };
}

function validateRemovalMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plugin removal metadata");
  }
  return { pluginId: assertPluginStorageSegment(value.pluginId, "ID") };
}

class PackageStore {
  constructor(options) {
    this.paths = options.paths;
    this.database = options.database;
    this.netcattyVersion = options.netcattyVersion;
    this.apiVersion = options.apiVersion;
    this.supportedFeatures = [...(options.supportedFeatures ?? [])];
    this.logger = options.logger ?? console;
  }

  async initialize() {
    await Promise.all(Object.values(this.paths)
      .filter((value) => typeof value === "string" && value !== this.paths.database)
      .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    await this.recover();
  }

  async install(archivePath, options = {}) {
    if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) {
      throw new TypeError("Plugin package path must be absolute");
    }
    if (path.extname(archivePath).toLowerCase() !== ".ncpkg") {
      throw new Error("Plugin packages must use the .ncpkg extension");
    }
    const pluginCli = await loadPluginCli();
    const stagingName = `install-${randomUUID()}`;
    const stagingDirectory = path.join(this.paths.staging, stagingName);
    const archiveSnapshot = path.join(stagingDirectory, "snapshot.ncpkg");
    const extractedDirectory = path.join(stagingDirectory, PACKAGE_DIRECTORY);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      const snapshot = await copyImmutableArchive(
        archivePath,
        archiveSnapshot,
        pluginCli.PACKAGE_LIMITS.archiveBytes,
      );
      const validation = await pluginCli.extractPluginPackage(archiveSnapshot, extractedDirectory);
      const manifest = validation.manifest;
      const compatibility = pluginCli.checkPluginCompatibility(manifest, {
        netcattyVersion: this.netcattyVersion,
        apiVersion: this.apiVersion,
        features: this.supportedFeatures,
      });
      if (!compatibility.compatible) {
        throw new Error(`Plugin is incompatible: ${compatibility.errors.join("; ")}`);
      }
      const pluginId = assertPluginStorageSegment(manifest.id, "ID");
      const version = assertPluginStorageSegment(manifest.version, "version");
      const targetDirectory = resolveInstalledVersionDirectory(this.paths, pluginId, version);
      const existing = this.database.getVersion(pluginId, version);
      if (existing) {
        if (existing.archiveSha256 !== snapshot.sha256) {
          throw new Error(`Plugin ${pluginId}@${version} is already installed with different contents`);
        }
        try {
          const existingPackage = path.join(targetDirectory, PACKAGE_DIRECTORY);
          const existingValidation = await pluginCli.validatePluginDirectory(existingPackage);
          if (existingValidation.manifest.id !== pluginId || existingValidation.manifest.version !== version) {
            throw new Error("Installed plugin identity does not match its database record");
          }
          this.database.installVersion({
            pluginId,
            version,
            manifest: existingValidation.manifest,
            archiveSha256: existing.archiveSha256,
            packageRelativePath: path.relative(this.paths.packages, existingPackage),
          }, { enable: options.enable === true });
          return this.database.getActivePlugin(pluginId);
        } catch {
          await rm(targetDirectory, { recursive: true, force: true });
        }
      }
      try {
        await stat(targetDirectory);
        throw new Error(`Plugin ${pluginId}@${version} has an uncommitted installed directory`);
      } catch (error) {
        if (!(error && error.code === "ENOENT")) throw error;
      }
      await rm(archiveSnapshot, { force: true });
      const metadata = { pluginId, version, archiveSha256: snapshot.sha256 };
      await writeFile(
        path.join(stagingDirectory, INSTALL_METADATA_FILE),
        `${JSON.stringify(metadata)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await syncDirectory(stagingDirectory);
      await mkdir(path.dirname(targetDirectory), { recursive: true, mode: 0o700 });
      await rename(stagingDirectory, targetDirectory);
      await syncDirectory(path.dirname(targetDirectory));
      const packageRelativePath = path.relative(
        this.paths.packages,
        path.join(targetDirectory, PACKAGE_DIRECTORY),
      );
      this.database.installVersion({
        pluginId,
        version,
        manifest,
        archiveSha256: snapshot.sha256,
        packageRelativePath,
      }, { enable: options.enable === true });
      return this.database.getActivePlugin(pluginId);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async recover() {
    await mkdir(this.paths.staging, { recursive: true, mode: 0o700 });
    const stagedEntries = await readdir(this.paths.staging, { withFileTypes: true });
    for (const entry of stagedEntries) {
      const stagedPath = path.join(this.paths.staging, entry.name);
      if (!entry.isDirectory() || !entry.name.startsWith("remove-")) {
        await rm(stagedPath, { recursive: true, force: true });
        continue;
      }
      const removedPluginPath = path.join(stagedPath, REMOVED_PLUGIN_DIRECTORY);
      let hasMovedPlugin = false;
      try {
        await lstat(removedPluginPath);
        hasMovedPlugin = true;
      } catch (error) {
        if (!(error && error.code === "ENOENT")) throw error;
      }
      // A crash can happen after remove-* is created but before remove.json is
      // durably written or before the installed package is moved. With no
      // moved package there is nothing to restore, so discard the debris even
      // when the metadata is missing or partial. If plugin/ exists, metadata
      // remains mandatory so recovery never deletes an unidentified package.
      if (!hasMovedPlugin) {
        await rm(stagedPath, { recursive: true, force: true });
        continue;
      }
      const metadata = validateRemovalMetadata(JSON.parse(await readFile(
        path.join(stagedPath, REMOVAL_METADATA_FILE),
        "utf8",
      )));
      const installedPluginPath = path.join(this.paths.packages, metadata.pluginId);
      const databasePlugin = this.database.getActivePlugin(metadata.pluginId);
      if (databasePlugin) {
        let installedExists = false;
        try {
          const installedStats = await lstat(installedPluginPath);
          installedExists = installedStats.isDirectory() && !installedStats.isSymbolicLink();
        } catch (error) {
          if (!(error && error.code === "ENOENT")) throw error;
        }
        if (!installedExists) {
          const removedStats = await lstat(removedPluginPath);
          if (!removedStats.isDirectory() || removedStats.isSymbolicLink()) {
            throw new Error(`Pending plugin removal is incomplete: ${metadata.pluginId}`);
          }
          await rename(removedPluginPath, installedPluginPath);
          await syncDirectory(this.paths.packages);
        }
      }
      await rm(stagedPath, { recursive: true, force: true });
    }
    const pluginCli = await loadPluginCli();
    const pluginDirectories = await readdir(this.paths.packages, { withFileTypes: true });
    for (const pluginEntry of pluginDirectories) {
      if (!pluginEntry.isDirectory()) continue;
      const pluginDirectory = path.join(this.paths.packages, pluginEntry.name);
      const versions = await readdir(pluginDirectory, { withFileTypes: true });
      for (const versionEntry of versions) {
        if (!versionEntry.isDirectory()) continue;
        const versionDirectory = path.join(pluginDirectory, versionEntry.name);
        try {
          const metadata = validateInstallMetadata(JSON.parse(await readFile(
            path.join(versionDirectory, INSTALL_METADATA_FILE),
            "utf8",
          )));
          if (metadata.pluginId !== pluginEntry.name || metadata.version !== versionEntry.name) {
            throw new Error("Plugin install metadata does not match its directory");
          }
          if (!this.database.getVersion(metadata.pluginId, metadata.version)) {
            const packageDirectory = path.join(versionDirectory, PACKAGE_DIRECTORY);
            const validation = await pluginCli.validatePluginDirectory(packageDirectory);
            if (
              validation.manifest.id !== metadata.pluginId
              || validation.manifest.version !== metadata.version
            ) {
              throw new Error("Recovered plugin manifest identity does not match install metadata");
            }
            this.database.installVersion({
              pluginId: metadata.pluginId,
              version: metadata.version,
              manifest: validation.manifest,
              archiveSha256: metadata.archiveSha256,
              packageRelativePath: path.relative(this.paths.packages, packageDirectory),
            }, { forceDisabled: true });
          }
        } catch (error) {
          this.logger.warn?.("[Plugins] Removing invalid uncommitted package", {
            directory: versionDirectory,
            error: error?.message ?? String(error),
          });
          await rm(versionDirectory, { recursive: true, force: true });
        }
      }
    }
    for (const plugin of this.database.listPlugins()) {
      if (!plugin.packageRelativePath) continue;
      const packageRoot = this.resolvePackageRoot(plugin);
      try {
        const packageStats = await stat(packageRoot);
        if (!packageStats.isDirectory()) throw new Error("not a directory");
        const validation = await pluginCli.validatePluginDirectory(packageRoot);
        if (validation.manifest.id !== plugin.id || validation.manifest.version !== plugin.activeVersion) {
          throw new Error("manifest identity mismatch");
        }
      } catch (error) {
        this.database.setEnabled(plugin.id, false);
        this.database.setRuntimeState(plugin.id, "error", {
          error: `Installed package files are invalid: ${error?.message ?? String(error)}`,
        });
      }
    }
  }

  resolvePackageRoot(plugin) {
    const relativePath = plugin?.packageRelativePath;
    if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
      throw new Error("Plugin package path is invalid");
    }
    const packageRoot = path.resolve(this.paths.packages, relativePath);
    if (!isPathInside(this.paths.packages, packageRoot)) {
      throw new Error("Plugin package path escapes the package store");
    }
    return packageRoot;
  }

  async uninstall(pluginId) {
    const plugin = this.database.getActivePlugin(pluginId);
    if (!plugin) return false;
    const pluginDirectory = path.join(
      this.paths.packages,
      assertPluginStorageSegment(pluginId, "ID"),
    );
    const removalDirectory = path.join(this.paths.staging, `remove-${randomUUID()}`);
    const removedPluginPath = path.join(removalDirectory, REMOVED_PLUGIN_DIRECTORY);
    await mkdir(removalDirectory, { recursive: false, mode: 0o700 });
    await writeFile(
      path.join(removalDirectory, REMOVAL_METADATA_FILE),
      `${JSON.stringify({ pluginId })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await syncDirectory(removalDirectory);
    let moved = false;
    try {
      await rename(pluginDirectory, removedPluginPath);
      moved = true;
      await syncDirectory(removalDirectory);
    } catch (error) {
      if (!(error && error.code === "ENOENT")) throw error;
    }
    try {
      this.database.removePlugin(pluginId);
    } catch (error) {
      let restored = !moved;
      if (moved) {
        try {
          await rename(removedPluginPath, pluginDirectory);
          await syncDirectory(this.paths.packages);
          restored = true;
        } catch {}
      }
      if (restored) await rm(removalDirectory, { recursive: true, force: true });
      throw error;
    }
    await rm(removalDirectory, { recursive: true, force: true });
    return true;
  }
}

module.exports = {
  INSTALL_METADATA_FILE,
  PACKAGE_DIRECTORY,
  REMOVAL_METADATA_FILE,
  REMOVED_PLUGIN_DIRECTORY,
  PackageStore,
  copyImmutableArchive,
  validateInstallMetadata,
  validateRemovalMetadata,
};
