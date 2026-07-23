import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalLayerEffects.ts", import.meta.url), "utf8");

test("theme preview DOM effects were removed in favor of ThemeRuntime injection", () => {
  assert.doesNotMatch(source, /themePreview/);
  assert.doesNotMatch(source, /applyTerminalPreviewVars/);
  assert.doesNotMatch(source, /clearHostTreePreviewVars/);
  assert.doesNotMatch(source, /applyTopTabsPreviewVars/);
  assert.doesNotMatch(source, /themeCommitTimerRef/);
});

test("terminal activity filter stays in sync before notification guards", () => {
  const subscriptionIndex = source.indexOf("return onSessionData(session.id, (chunk) => {");
  const filterIndex = source.indexOf("const hasNotifiableOutput = hasNotifiableTerminalOutput(filter, chunk);", subscriptionIndex);
  const visibleGuardIndex = source.indexOf("if (!shouldMarkSessionActivity(activeTabIdRef.current, session))", subscriptionIndex);
  const alreadyActiveGuardIndex = source.indexOf("if (sessionActivityStore.getSnapshot()[session.id])", subscriptionIndex);

  assert.notEqual(subscriptionIndex, -1);
  assert.notEqual(filterIndex, -1);
  assert.notEqual(visibleGuardIndex, -1);
  assert.notEqual(alreadyActiveGuardIndex, -1);
  assert.ok(filterIndex < visibleGuardIndex);
  assert.ok(filterIndex < alreadyActiveGuardIndex);
});

test("side panel layout changes remeasure workspace before paint", () => {
  assert.match(source, /import \{ useCallback, useEffect, useLayoutEffect, useRef \} from 'react';/);

  const commentIndex = source.indexOf("Discrete layout changes (side panel toggle");
  const layoutEffectIndex = source.indexOf("useLayoutEffect(() => {", commentIndex);
  const shellWidthDependencyIndex = source.indexOf("sidePanelShellWidth,", layoutEffectIndex);

  assert.notEqual(commentIndex, -1);
  assert.notEqual(layoutEffectIndex, -1);
  assert.notEqual(shellWidthDependencyIndex, -1);
  assert.ok(commentIndex < layoutEffectIndex);
});

test("transfer navigation helper is used for open-target and resume routing", () => {
  assert.match(source, /resolveSftpTransferNavigationTarget/);
  assert.match(source, /resolveSftpTransferNavigationPath/);
  assert.match(source, /pickHostForTransferNavigation/);
  assert.match(source, /isTransferNavigationTerminalTabId/);
  assert.match(source, /navigation\.kind === 'local-copy-panel'/);
  assert.match(source, /navigation\.kind === 'local-path'/);
  // No terminal tab → connect host then open SFTP at target path.
  assert.match(source, /onConnectToHost/);
  assert.match(source, /openHostThenSftp/);
  assert.match(source, /allowLiveUploadFallback/);
});
