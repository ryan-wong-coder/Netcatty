import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SettingsTerminalTab.tsx", import.meta.url), "utf8");

test("terminal settings hide terminal theme pickers while following app theme", () => {
  assert.match(source, /\{!followAppTerminalTheme && \(/);
  assert.doesNotMatch(source, /settings\.terminal\.theme\.followingTheme/);
});

test("terminal settings expose host key verification toggle", () => {
  assert.match(source, /settings\.terminal\.connection\.verifyHostKeys/);
  assert.match(source, /checked=\{terminalSettings\.verifyHostKeys\}/);
  assert.match(source, /updateTerminalSetting\("verifyHostKeys", v\)/);
});
