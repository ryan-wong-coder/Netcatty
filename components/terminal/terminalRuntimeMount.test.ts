import assert from 'node:assert/strict';
import test from 'node:test';

import { applyTerminalKeywordHighlightRules } from './terminalKeywordHighlightRules.ts';

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
      patterns: Object.freeze(['\\berror\\b']),
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
