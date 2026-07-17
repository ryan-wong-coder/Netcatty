import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPluginPackage, validatePluginPackage } from "./archive.ts";
import { PACKAGE_LIMITS } from "./constants.ts";
import { initPlugin } from "./commands.ts";
import { readAndValidateManifest, validateManifestValue } from "./manifest.ts";
import { assertSafePackagePath, PackagePathRegistry } from "./packagePath.ts";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: "com.example.package-test",
    name: "package-test",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=1.0.0", api: "0.1.0-internal" },
    main: { browser: "dist/index.js" },
    ...overrides,
  };
}

async function createPlugin(root: string): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "netcatty.plugin.json"),
      `${JSON.stringify(manifest(), null, 2)}\n`,
    ),
    writeFile(path.join(directory, "dist/index.js"), "export default {};\n"),
    writeFile(path.join(directory, "README.md"), "# Package test\n"),
  ]);
  return directory;
}

test("path validation rejects traversal, platform aliases, and duplicates", () => {
  for (const unsafe of [
    "../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a/../b",
    "CON",
    "assets/PRN.txt",
    "file.",
    "folder/file ",
    "folder/file?.js",
    "a//b",
    "😀".repeat(129),
  ]) {
    assert.throws(() => assertSafePackagePath(unsafe));
  }
  assert.equal(assertSafePackagePath("😀".repeat(128)), "😀".repeat(128));
  const registry = new PackagePathRegistry();
  registry.add("dist/Plugin.js");
  assert.throws(() => registry.add("dist/plugin.js"), /case-colliding/);

  for (const paths of [
    ["dist", "dist/index.js"],
    ["dist/index.js", "dist"],
    ["DIST", "dist/index.js"],
    ["dist/index.js", "DIST"],
  ]) {
    const collisionRegistry = new PackagePathRegistry();
    collisionRegistry.add(paths[0]);
    assert.throws(
      () => collisionRegistry.add(paths[1]),
      /File\/directory package path collision/,
    );
  }
});

test("manifest validation reports permission and contribution mistakes", () => {
  const result = validateManifestValue(manifest({
    permissions: { required: ["network"], optional: ["network"] },
    contributes: {
      commands: [{ id: "package.run", title: "Run" }],
      menus: [{ command: "package.missing", location: "commandPalette" }],
    },
  }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /both required and optional/);
  assert.match(result.errors.join("\n"), /undeclared command/);
});

test("init creates a valid TypeScript plugin skeleton", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-init-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "created");

  await initPlugin(directory, { id: "com.example.created", name: "Created" });

  const createdManifest = await readAndValidateManifest(directory);
  assert.equal(createdManifest.id, "com.example.created");
  assert.match(await readFile(path.join(directory, "src/index.ts"), "utf8"), /definePlugin/);
});

test("init safely serializes the display name in generated TypeScript", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-init-escape-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "created");
  const displayName = 'A "quoted" \\ plugin\nnext line';

  await initPlugin(directory, { id: "com.example.escaped", name: displayName });

  const source = await readFile(path.join(directory, "src/index.ts"), "utf8");
  assert.ok(
    source.includes(`context.logger.info(${JSON.stringify(`${displayName} activated`)});`),
  );
});

test("packing is deterministic and the archive validates", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  const first = path.join(root, "first.ncpkg");
  const second = path.join(root, "second.ncpkg");

  const firstResult = await buildPluginPackage(directory, first);
  await buildPluginPackage(directory, second);
  const firstBytes = await readFile(first);
  const secondBytes = await readFile(second);

  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(
    firstResult.sha256,
    createHash("sha256").update(firstBytes).digest("hex"),
  );
  const validation = await validatePluginPackage(first);
  assert.equal(validation.manifest.id, "com.example.package-test");
  assert.equal(validation.fileCount, 3);
});

test("archive validation rejects duplicate names and CRC corruption", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-archive-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await Promise.all([
    writeFile(path.join(directory, "a.txt"), "first\n"),
    writeFile(path.join(directory, "b.txt"), "second\n"),
  ]);
  await mkdir(path.join(directory, "bbbbb"));
  await Promise.all([
    writeFile(path.join(directory, "aaaaa"), "parent-file\n"),
    writeFile(path.join(directory, "bbbbb/file"), "child-file\n"),
  ]);
  const validPath = path.join(root, "valid.ncpkg");
  await buildPluginPackage(directory, validPath);
  const validBytes = await readFile(validPath);

  const duplicateBytes = Buffer.from(validBytes);
  const originalName = Buffer.from("b.txt");
  const duplicateName = Buffer.from("a.txt");
  let replacements = 0;
  for (let offset = duplicateBytes.indexOf(originalName); offset !== -1;) {
    duplicateName.copy(duplicateBytes, offset);
    replacements += 1;
    offset = duplicateBytes.indexOf(originalName, offset + originalName.byteLength);
  }
  assert.equal(replacements, 2, "ZIP should contain the local and central entry names");
  const duplicatePath = path.join(root, "duplicate.ncpkg");
  await writeFile(duplicatePath, duplicateBytes);
  await assert.rejects(validatePluginPackage(duplicatePath), /Duplicate or case-colliding/);

  const prefixCollisionBytes = Buffer.from(validBytes);
  let prefixReplacements = 0;
  for (const [source, target] of [
    [Buffer.from("aaaaa"), Buffer.from("distx")],
    [Buffer.from("bbbbb/file"), Buffer.from("distx/file")],
  ]) {
    for (let offset = prefixCollisionBytes.indexOf(source); offset !== -1;) {
      target.copy(prefixCollisionBytes, offset);
      prefixReplacements += 1;
      offset = prefixCollisionBytes.indexOf(source, offset + source.byteLength);
    }
  }
  assert.equal(prefixReplacements, 4, "ZIP should contain both local and central names");
  const prefixCollisionPath = path.join(root, "prefix-collision.ncpkg");
  await writeFile(prefixCollisionPath, prefixCollisionBytes);
  await assert.rejects(
    validatePluginPackage(prefixCollisionPath),
    /File\/directory package path collision/,
  );

  const corruptedBytes = Buffer.from(validBytes);
  const content = Buffer.from("# Package test\n");
  const contentOffset = corruptedBytes.indexOf(content);
  assert.notEqual(contentOffset, -1);
  corruptedBytes[contentOffset] ^= 0x01;
  const corruptedPath = path.join(root, "corrupted.ncpkg");
  await writeFile(corruptedPath, corruptedBytes);
  await assert.rejects(validatePluginPackage(corruptedPath), /integrity check failed/);
});

test("packer rejects symbolic links and undeclared executables", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-safety-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await assert.rejects(
    buildPluginPackage(directory, path.join(root, "wrong-extension.zip")),
    /\.ncpkg extension/,
  );
  if (process.platform !== "win32") {
    await symlink("README.md", path.join(directory, "linked-readme"));
    await assert.rejects(
      buildPluginPackage(directory, path.join(root, "symlink.ncpkg")),
      /Symbolic links/,
    );
    await rm(path.join(directory, "linked-readme"));
  }
  await mkdir(path.join(directory, "bin"));
  const executablePath = path.join(directory, "bin/tool.exe");
  await writeFile(executablePath, "not-a-real-executable\n");
  await assert.rejects(
    buildPluginPackage(directory, path.join(root, "executable.ncpkg")),
    /not declared as a companion/,
  );
});

test("packer ignores root dev artifacts without dropping nested runtime dependencies", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-runtime-deps-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createPlugin(root);
  await Promise.all([
    mkdir(path.join(directory, "node_modules/dev-only"), { recursive: true }),
    mkdir(path.join(directory, "dist/node_modules/runtime-dependency"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(directory, "node_modules/dev-only/index.js"), "dev only\n"),
    writeFile(
      path.join(directory, "dist/node_modules/runtime-dependency/index.js"),
      "export const runtime = true;\n",
    ),
  ]);
  const packagePath = path.join(root, "runtime-deps.ncpkg");

  const build = await buildPluginPackage(directory, packagePath);
  const validation = await validatePluginPackage(packagePath);

  assert.equal(build.fileCount, 4);
  assert.equal(validation.fileCount, 4);
});

test("manifest byte limit is enforced before JSON parsing", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "netcatty-plugin-limit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "netcatty.plugin.json"),
    `{"padding":"${"x".repeat(PACKAGE_LIMITS.manifestBytes)}"}`,
  );
  await assert.rejects(readAndValidateManifest(root), /manifest exceeds/);
});
