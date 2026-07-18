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

test("plugin database migrates atomically and rejects newer schemas", (context) => {
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

  assert.deepEqual(database.recordCrash(pluginManifest.id, 300_000, 3), {
    count: 1, quarantined: false, quarantinedAt: null,
  });
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, 300_000, 3).quarantined, false);
  now += 1_000;
  assert.equal(database.recordCrash(pluginManifest.id, 300_000, 3).quarantined, true);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "quarantined");

  database.clearQuarantine(pluginManifest.id);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.quarantinedAt, null);
  assert.equal(database.getActivePlugin(pluginManifest.id).runtime.status, "stopped");
  database.close();
});
