import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyTerminalKeywordHighlightRules } from './terminalKeywordHighlightRules.ts';

const effectsSource = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');

test('hibernate runtime keyword setup restores plugin decoration rules', () => {
  let applied: { rules: unknown[]; enabled: boolean } | undefined;
  const runtime = {
    keywordHighlighter: {
      setRules(rules: unknown[], enabled: boolean) {
        applied = { rules, enabled };
      },
    },
  };
  applyTerminalKeywordHighlightRules(
    runtime as never,
    { current: { keywordHighlightEnabled: false, keywordHighlightRules: [] } } as never,
    { keywordHighlightEnabled: false, keywordHighlightRules: [] } as never,
    [{
      id: 'com.example.decorations:error',
      label: 'Error',
      patterns: ['\\berror\\b'],
      color: '#ff0000',
      enabled: true,
    }],
  );
  assert.deepEqual(applied, {
    enabled: true,
    rules: [{
      id: 'com.example.decorations:error',
      label: 'Error',
      patterns: ['\\berror\\b'],
      color: '#ff0000',
      enabled: true,
    }],
  });
});

test('cwd-triggered plugin decoration refresh reads the live connection status', () => {
  assert.match(
    effectsSource,
    /if \(!pluginTerminalRegistry \|\| statusRef\.current !== 'connected'\)/,
  );
  assert.match(
    effectsSource,
    /void refreshPluginDecorationRules\('session-state'\);\s*\n\s*}, \[refreshPluginDecorationRules, status\]\);/,
  );
});
