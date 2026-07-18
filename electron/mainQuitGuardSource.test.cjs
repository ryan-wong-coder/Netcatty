const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test("before-quit dirty editor guard queries only registered editor-owner windows", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const queryableIndex = source.indexOf("const queryableWebContents", beforeQuitIndex);
  const queryCallIndex = source.indexOf("queryDirtyEditors", queryableIndex);
  const guardSetup = source.slice(beforeQuitIndex, queryCallIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(queryableIndex, -1);
  assert.match(guardSetup, /getDirtyEditorWindows/);
  assert.match(guardSetup, /const queryableWindows = mainWindows\.filter/);
  assert.match(source.slice(queryableIndex, queryCallIndex), /queryableWindows\s*\n?\s*\.map\(\(candidate\) => candidate\.webContents\)/);
  assert.doesNotMatch(guardSetup, /isVisible|isMinimized/);
});

test("before-quit dirty editor guard foregrounds dirty windows through the focus recovery helper", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const dirtyResultsIndex = source.indexOf(".then((dirtyResults) => {", beforeQuitIndex);
  const loopIndex = source.indexOf("for (const win of dirtyWindows)", dirtyResultsIndex);
  const hasDirtyCommentIndex = source.indexOf("// hasDirty:", loopIndex);
  const foregroundBlock = source.slice(loopIndex, hasDirtyCommentIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(dirtyResultsIndex, -1);
  assert.notEqual(loopIndex, -1);
  assert.notEqual(hasDirtyCommentIndex, -1);
  assert.match(foregroundBlock, /wm\.showAndFocusMainWindow\?\.\(win\)/);
  assert.match(foregroundBlock, /try\s*\{[\s\S]*wm\.showAndFocusMainWindow\?\.\(win\);[\s\S]*\}\s*catch\s*\{/);
  assert.doesNotMatch(foregroundBlock, /commitQuit\(\)/);
  assert.doesNotMatch(foregroundBlock, /win\.show\(\)/);
  assert.doesNotMatch(foregroundBlock, /win\.focus\(\)/);
});

test("before-quit keeps the original event cancelled while plugin shutdown runs without a renderer", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const noRendererIndex = source.indexOf("if (queryableWebContents.length === 0)");
  const noRendererEnd = source.indexOf("return;", noRendererIndex);
  const noRendererBlock = source.slice(noRendererIndex, noRendererEnd);

  assert.notEqual(noRendererIndex, -1);
  assert.match(noRendererBlock, /event\.preventDefault\(\)/);
  assert.match(noRendererBlock, /commitQuit\(\)/);
  assert.ok(
    noRendererBlock.indexOf("event.preventDefault()") < noRendererBlock.indexOf("commitQuit()"),
    "the original quit must be cancelled before asynchronous plugin shutdown starts",
  );
});

test("all app content windows use the WindowManager-level last-window close handler", () => {
  const mainSource = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const windowSource = readFileSync(path.join(
    __dirname,
    "bridges",
    "windowManager",
    "mainWindow.cjs",
  ), "utf8");
  const createWindowIndex = mainSource.indexOf("async function createWindow()");
  const setHandlerIndex = mainSource.indexOf("setAppContentWindowClosedHandler", createWindowIndex);
  const managerCreateIndex = mainSource.indexOf("windowManager.createWindow", createWindowIndex);

  assert.notEqual(setHandlerIndex, -1);
  assert.notEqual(managerCreateIndex, -1);
  assert.ok(setHandlerIndex < managerCreateIndex);
  const closedIndex = windowSource.indexOf("win.on('closed'");
  const appContentBranchIndex = windowSource.indexOf("if (registerAsAppContentWindow)", closedIndex);
  const notifyIndex = windowSource.indexOf("notifyAppContentWindowClosed(win)", appContentBranchIndex);
  assert.notEqual(closedIndex, -1);
  assert.notEqual(appContentBranchIndex, -1);
  assert.notEqual(notifyIndex, -1);
});
