"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { PluginDatabase, SCHEMA_VERSION } = require("./database.cjs");

function createDatabase(context, clock = () => 1_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PluginDatabase(path.join(root, "plugins.sqlite"), { clock });
}

function manifest(id = "com.example.test", version = "1.0.0") {
  return {
    manifestVersion: 1,
    id,
    name: "test",
    version,
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/index.js" },
  };
}

test("plugin database initializes atomically and rejects newer schemas", (context) => {
  const database = createDatabase(context);
  assert.equal(database.db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(database.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  database.close();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-newer-db-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins.sqlite");
  const newer = new DatabaseSync(file);
  newer.exec("PRAGMA user_version = 99");
  newer.close();
  assert.throws(() => new PluginDatabase(file), /newer than supported/);
});

test("initial schema scopes runtime and crash state to immutable plugin versions", (context) => {
  const database = createDatabase(context);
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_crashes)").all().map(({ name }) => name),
    ["plugin_id", "plugin_version", "crashed_at"],
  );
  assert.deepEqual(
    database.db.prepare("PRAGMA table_info(plugin_runtime_state)").all().map(({ name }) => name),
    [
      "plugin_id",
      "plugin_version",
      "status",
      "runtime_kind",
      "last_error",
      "quarantined_at",
      "updated_at",
    ],
  );
  database.close();
});

test("version activation and namespaced key/value writes are transactional", (context) => {
  const database = createDatabase(context);
  const pluginManifest = manifest();
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.test/1.0.0/package",
  }, { enable: true });

  const installed = database.getActivePlugin(pluginManifest.id);
  assert.equal(installed.enabled, true);
  assert.equal(installed.activeVersion, "1.0.0");
  assert.deepEqual(installed.manifest, pluginManifest);

  database.setValue(pluginManifest.id, "greeting", { text: "hello" });
  database.setValue(pluginManifest.id, "count", 2);
  assert.deepEqual(database.getValue(pluginManifest.id, "greeting"), { text: "hello" });
  assert.deepEqual(database.listKeys(pluginManifest.id), ["count", "greeting"]);
  database.deleteValue(pluginManifest.id, "count");
  assert.equal(database.getValue(pluginManifest.id, "count"), undefined);
  database.close();
});

test("database transactions reject async callbacks before committing", (context) => {
  const database = createDatabase(context);
  assert.throws(() => database.transaction(async () => {
    database.db.prepare(`
      INSERT INTO plugins(id, enabled, active_version, installed_at, updated_at)
      VALUES ('com.example.async', 0, NULL, 1, 1)
    `).run();
  }), /must be synchronous/);
  assert.equal(database.getActivePlugin("com.example.async"), null);
  database.close();
});

test("recovered versions can atomically replace an enabled version while staying disabled", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  }, { enable: true });
  const second = manifest(first.id, "2.0.0");
  database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  }, { forceDisabled: true });

  const recovered = database.getActivePlugin(first.id);
  assert.equal(recovered.activeVersion, "2.0.0");
  assert.equal(recovered.enabled, false);
  assert.throws(() => database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  }, { enable: true, forceDisabled: true }), /cannot be enabled and force-disabled/);
  database.close();
});

test("active version rollback is compare-and-set and keeps version state isolated", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  const second = manifest(first.id, "2.0.0");
  for (const [pluginManifest, archive] of [[first, "a"], [second, "b"]]) {
    database.installVersion({
      pluginId: pluginManifest.id,
      version: pluginManifest.version,
      manifest: pluginManifest,
      archiveSha256: archive.repeat(64),
      packageRelativePath: `${pluginManifest.id}/${pluginManifest.version}/package`,
    }, { enable: true });
  }
  database.setRuntimeState(first.id, "error", {
    pluginVersion: second.version,
    error: "new version failed",
  });

  const restored = database.setActiveVersion(first.id, first.version, {
    enabled: true,
    expectedActiveVersion: second.version,
  });
  assert.equal(restored.activeVersion, first.version);
  assert.equal(restored.enabled, true);
  assert.equal(restored.runtime.status, "stopped");
  assert.equal(database.getVersion(first.id, second.version).version, second.version);
  assert.throws(() => database.setActiveVersion(first.id, second.version, {
    enabled: true,
    expectedActiveVersion: "3.0.0",
  }), /changed before it could be restored/);
  assert.throws(() => database.setActiveVersion(first.id, "9.0.0"), /version is not installed/);
  database.close();
});

test("three crashes inside five minutes quarantine until explicit recovery", (context) => {
  let now = 10_000;
  const database = createDatabase(context, () => now);
  const pluginManifest = manifest();
  database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.test/1.0.0/package",
  });

  assert.deepEqual(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3), {
    count: 1, quarantined: false, quarantinedAt: null,
  });
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3).quarantined, false);
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, pluginManifest.version, 300_000, 3).quarantined, true);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "quarantined");

  database.clearQuarantine(pluginManifest.id);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.quarantinedAt, null);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "stopped");
  database.close();
});

test("activating a new version resets runtime quarantine without forgiving the same version", (context) => {
  const database = createDatabase(context);
  const first = manifest();
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  }, { enable: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    database.recordCrash(first.id, first.version, 300_000, 3);
  }
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");

  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  });
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");

  const second = manifest(first.id, "2.0.0");
  database.installVersion({
    pluginId: second.id,
    version: second.version,
    manifest: second,
    archiveSha256: "b".repeat(64),
    packageRelativePath: `${second.id}/${second.version}/package`,
  });
  const active = database.getActivePlugin(first.id);
  assert.equal(active.activeVersion, "2.0.0");
  assert.equal(active.runtime.status, "stopped");
  assert.equal(active.runtime.lastError, null);
  assert.equal(active.runtime.quarantinedAt, null);
  assert.deepEqual(database.recordCrash(second.id, second.version, 300_000, 3), {
    count: 1,
    quarantined: false,
    quarantinedAt: null,
  });
  assert.deepEqual(database.recordCrash(first.id, first.version, 300_000, 3), {
    count: 4,
    quarantined: true,
    quarantinedAt: 1_000,
  });
  database.clearQuarantine(second.id);
  assert.equal(Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM plugin_crashes
    WHERE plugin_id = ? AND plugin_version = ?
  `).get(first.id, first.version).count), 4);
  assert.equal(Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM plugin_crashes
    WHERE plugin_id = ? AND plugin_version = ?
  `).get(second.id, second.version).count), 0);
  database.installVersion({
    pluginId: first.id,
    version: first.version,
    manifest: first,
    archiveSha256: "a".repeat(64),
    packageRelativePath: `${first.id}/${first.version}/package`,
  });
  assert.equal(database.getActivePlugin(first.id).runtime.status, "quarantined");
  assert.equal(database.getActivePlugin(first.id).runtime.quarantinedAt, 1_000);
  database.close();
});
