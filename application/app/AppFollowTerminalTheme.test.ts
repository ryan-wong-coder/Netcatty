import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const appViewSource = readFileSync(new URL("./AppView.tsx", import.meta.url), "utf8");

test("follow-app terminal theme selection updates the matching UI theme", () => {
  assert.match(appSource, /const update = getFollowAppTerminalThemeSelectionUpdate\(themeId\)/);
  assert.match(appSource, /setDarkUiThemeId\(update\.uiThemeId\)/);
  assert.match(appSource, /setLightUiThemeId\(update\.uiThemeId\)/);
  assert.match(appSource, /setTheme\(update\.appTheme\)/);
  assert.doesNotMatch(appSource, /customThemeStore\.getThemeById\(themeId\)/);
});

test("default terminal theme selection clears the current mode override", () => {
  assert.match(appSource, /const handleDefaultTerminalThemeChange = useCallback\(\(themeId: string\) => \{/);
  assert.match(appSource, /setTerminalThemeId\(themeId\)/);
  assert.match(appSource, /resolvedTheme === 'dark'[\s\S]*setTerminalThemeDarkId\(TERMINAL_THEME_AUTO\)/);
  assert.match(appSource, /setTerminalThemeLightId\(TERMINAL_THEME_AUTO\)/);
  assert.match(appViewSource, /onUpdateTerminalThemeId=\{handleDefaultTerminalThemeChange\}/);
});
