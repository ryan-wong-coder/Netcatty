"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 1;

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Corrupt plugin database ${label}`);
  }
}

class PluginDatabase {
  constructor(databasePath, options = {}) {
    if (typeof databasePath !== "string" || !path.isAbsolute(databasePath)) {
      throw new TypeError("Plugin database path must be absolute");
    }
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.databasePath = databasePath;
    this.clock = options.clock ?? (() => Date.now());
    const ownsDatabase = !options.database;
    this.db = options.database ?? new DatabaseSync(databasePath);
    try {
      this.#initializeSchema();
    } catch (error) {
      if (ownsDatabase) {
        try { this.db.close(); } catch {}
      }
      throw error;
    }
  }

  #initializeSchema() {
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Plugin database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE plugins (
            id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            active_version TEXT,
            installed_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE plugin_versions (
            plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            archive_sha256 TEXT NOT NULL,
            package_relative_path TEXT NOT NULL,
            installed_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, version)
          );
          CREATE TABLE plugin_runtime_state (
            plugin_id TEXT NOT NULL,
            plugin_version TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'stopped',
            runtime_kind TEXT,
            last_error TEXT,
            quarantined_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, plugin_version),
            FOREIGN KEY (plugin_id, plugin_version)
              REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
          );
          CREATE TABLE plugin_crashes (
            plugin_id TEXT NOT NULL,
            plugin_version TEXT NOT NULL,
            crashed_at INTEGER NOT NULL,
            FOREIGN KEY (plugin_id, plugin_version)
              REFERENCES plugin_versions(plugin_id, version) ON DELETE CASCADE
          );
          CREATE INDEX plugin_crashes_lookup
            ON plugin_crashes(plugin_id, plugin_version, crashed_at);
          CREATE TABLE plugin_kv (
            plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (plugin_id, key)
          );
          PRAGMA user_version = 1;
        `);
      });
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        throw new TypeError("Plugin database transactions must be synchronous");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  installVersion(record, options = {}) {
    if (options.enable === true && options.forceDisabled === true) {
      throw new TypeError("Plugin version cannot be enabled and force-disabled together");
    }
    const now = this.clock();
    const manifestJson = JSON.stringify(record.manifest);
    const requestedEnabled = options.enable === true ? 1 : 0;
    const overwriteEnabled = options.enable === true || options.forceDisabled === true;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          active_version = excluded.active_version,
          enabled = CASE WHEN ? THEN excluded.enabled ELSE plugins.enabled END,
          updated_at = excluded.updated_at
      `).run(
        record.pluginId,
        requestedEnabled,
        record.version,
        now,
        now,
        overwriteEnabled ? 1 : 0,
      );
      this.db.prepare(`
        INSERT INTO plugin_versions(
          plugin_id, version, manifest_json, archive_sha256, package_relative_path, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id, version) DO UPDATE SET
          manifest_json = excluded.manifest_json,
          archive_sha256 = excluded.archive_sha256,
          package_relative_path = excluded.package_relative_path,
          installed_at = excluded.installed_at
      `).run(
        record.pluginId,
        record.version,
        manifestJson,
        record.archiveSha256,
        record.packageRelativePath,
        now,
      );
      this.db.prepare(`
        INSERT INTO plugin_runtime_state(plugin_id, plugin_version, status, updated_at)
        VALUES (?, ?, 'stopped', ?)
        ON CONFLICT(plugin_id, plugin_version) DO NOTHING
      `).run(record.pluginId, record.version, now);
    });
  }

  getVersion(pluginId, version) {
    const row = this.db.prepare(`
      SELECT plugin_id, version, manifest_json, archive_sha256,
             package_relative_path, installed_at
      FROM plugin_versions WHERE plugin_id = ? AND version = ?
    `).get(pluginId, version);
    return row ? this.#mapVersion(row) : null;
  }

  getActivePlugin(pluginId) {
    const row = this.db.prepare(`
      SELECT p.id, p.enabled, p.active_version, p.installed_at, p.updated_at,
             v.manifest_json, v.archive_sha256, v.package_relative_path,
             r.status, r.runtime_kind, r.last_error, r.quarantined_at
      FROM plugins p
      LEFT JOIN plugin_versions v
        ON v.plugin_id = p.id AND v.version = p.active_version
      LEFT JOIN plugin_runtime_state r ON r.plugin_id = p.id
        AND r.plugin_version = p.active_version
      WHERE p.id = ?
    `).get(pluginId);
    return row ? this.#mapPlugin(row) : null;
  }

  listPlugins() {
    return this.db.prepare(`
      SELECT p.id, p.enabled, p.active_version, p.installed_at, p.updated_at,
             v.manifest_json, v.archive_sha256, v.package_relative_path,
             r.status, r.runtime_kind, r.last_error, r.quarantined_at
      FROM plugins p
      LEFT JOIN plugin_versions v
        ON v.plugin_id = p.id AND v.version = p.active_version
      LEFT JOIN plugin_runtime_state r ON r.plugin_id = p.id
        AND r.plugin_version = p.active_version
      ORDER BY p.id COLLATE BINARY
    `).all().map((row) => this.#mapPlugin(row));
  }

  #mapVersion(row) {
    return {
      pluginId: row.plugin_id,
      version: row.version,
      manifest: parseJson(row.manifest_json, "manifest"),
      archiveSha256: row.archive_sha256,
      packageRelativePath: row.package_relative_path,
      installedAt: Number(row.installed_at),
    };
  }

  #mapPlugin(row) {
    return {
      id: row.id,
      enabled: row.enabled === 1,
      activeVersion: row.active_version ?? null,
      installedAt: Number(row.installed_at),
      updatedAt: Number(row.updated_at),
      manifest: row.manifest_json ? parseJson(row.manifest_json, "manifest") : null,
      archiveSha256: row.archive_sha256 ?? null,
      packageRelativePath: row.package_relative_path ?? null,
      runtime: {
        status: row.status ?? "stopped",
        kind: row.runtime_kind ?? null,
        lastError: row.last_error ?? null,
        quarantinedAt: row.quarantined_at == null ? null : Number(row.quarantined_at),
      },
    };
  }

  setEnabled(pluginId, enabled) {
    const result = this.db.prepare("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, this.clock(), pluginId);
    if (Number(result.changes) !== 1) throw new Error(`Plugin is not installed: ${pluginId}`);
  }

  setActiveVersion(pluginId, version, options = {}) {
    this.transaction(() => {
      if (!this.getVersion(pluginId, version)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${version}`);
      }
      const enabled = options.enabled === true ? 1 : 0;
      const expectedActiveVersion = options.expectedActiveVersion;
      const result = expectedActiveVersion === undefined
        ? this.db.prepare(`
            UPDATE plugins
            SET active_version = ?, enabled = ?, updated_at = ?
            WHERE id = ?
          `).run(version, enabled, this.clock(), pluginId)
        : this.db.prepare(`
            UPDATE plugins
            SET active_version = ?, enabled = ?, updated_at = ?
            WHERE id = ? AND active_version = ?
          `).run(version, enabled, this.clock(), pluginId, expectedActiveVersion);
      if (Number(result.changes) !== 1) {
        throw new Error(`Plugin active version changed before it could be restored: ${pluginId}`);
      }
    });
    return this.getActivePlugin(pluginId);
  }

  setRuntimeState(pluginId, status, options = {}) {
    const activeVersion = this.db.prepare(
      "SELECT active_version FROM plugins WHERE id = ?",
    ).get(pluginId)?.active_version;
    const pluginVersion = options.pluginVersion ?? activeVersion;
    if (!pluginVersion) throw new Error(`Plugin is not installed: ${pluginId}`);
    if (!this.getVersion(pluginId, pluginVersion)) {
      throw new Error(`Plugin version is not installed: ${pluginId}@${pluginVersion}`);
    }
    this.db.prepare(`
      INSERT INTO plugin_runtime_state(
        plugin_id, plugin_version, status, runtime_kind,
        last_error, quarantined_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, plugin_version) DO UPDATE SET
        status = excluded.status,
        runtime_kind = excluded.runtime_kind,
        last_error = excluded.last_error,
        quarantined_at = COALESCE(excluded.quarantined_at, plugin_runtime_state.quarantined_at),
        updated_at = excluded.updated_at
    `).run(
      pluginId,
      pluginVersion,
      status,
      options.kind ?? null,
      options.error == null ? null : String(options.error).slice(0, 4_096),
      options.quarantinedAt ?? null,
      this.clock(),
    );
  }

  recordCrash(pluginId, pluginVersion, windowMs, threshold) {
    const now = this.clock();
    return this.transaction(() => {
      if (!this.getVersion(pluginId, pluginVersion)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${pluginVersion}`);
      }
      this.db.prepare(`
        DELETE FROM plugin_crashes
        WHERE plugin_id = ? AND plugin_version = ? AND crashed_at < ?
      `).run(pluginId, pluginVersion, now - windowMs);
      this.db.prepare(`
        INSERT INTO plugin_crashes(plugin_id, plugin_version, crashed_at)
        VALUES (?, ?, ?)
      `).run(pluginId, pluginVersion, now);
      const count = Number(this.db.prepare(
        "SELECT COUNT(*) AS count FROM plugin_crashes WHERE plugin_id = ? AND plugin_version = ?",
      ).get(pluginId, pluginVersion)?.count ?? 0);
      if (count >= threshold) {
        this.db.prepare(`
          UPDATE plugin_runtime_state
          SET status = 'quarantined', quarantined_at = ?, updated_at = ?
          WHERE plugin_id = ? AND plugin_version = ?
        `).run(now, now, pluginId, pluginVersion);
      }
      return { count, quarantined: count >= threshold, quarantinedAt: count >= threshold ? now : null };
    });
  }

  clearQuarantine(pluginId, pluginVersion) {
    const now = this.clock();
    this.transaction(() => {
      const activeVersion = this.db.prepare(
        "SELECT active_version FROM plugins WHERE id = ?",
      ).get(pluginId)?.active_version;
      const targetVersion = pluginVersion ?? activeVersion;
      if (!targetVersion) throw new Error(`Plugin is not installed: ${pluginId}`);
      if (!this.getVersion(pluginId, targetVersion)) {
        throw new Error(`Plugin version is not installed: ${pluginId}@${targetVersion}`);
      }
      this.db.prepare(`
        DELETE FROM plugin_crashes WHERE plugin_id = ? AND plugin_version = ?
      `).run(pluginId, targetVersion);
      this.db.prepare(`
        UPDATE plugin_runtime_state
        SET status = 'stopped', last_error = NULL, quarantined_at = NULL, updated_at = ?
        WHERE plugin_id = ? AND plugin_version = ?
      `).run(now, pluginId, targetVersion);
    });
  }

  removePlugin(pluginId) {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(pluginId);
  }

  getValue(pluginId, key) {
    const row = this.db.prepare(
      "SELECT value_json FROM plugin_kv WHERE plugin_id = ? AND key = ?",
    ).get(pluginId, key);
    return row ? parseJson(row.value_json, "key/value entry") : undefined;
  }

  setValue(pluginId, key, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Plugin storage value must be JSON serializable");
    this.db.prepare(`
      INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(pluginId, key, serialized, this.clock());
  }

  deleteValue(pluginId, key) {
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?").run(pluginId, key);
  }

  listKeys(pluginId) {
    return this.db.prepare(
      "SELECT key FROM plugin_kv WHERE plugin_id = ? ORDER BY key COLLATE BINARY",
    ).all(pluginId).map((row) => row.key);
  }

  close() {
    this.db.close();
  }
}

module.exports = { PluginDatabase, SCHEMA_VERSION };
