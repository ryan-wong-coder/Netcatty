import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSafePluginDecorationPattern,
  mergePluginDecorationRules,
  mergePluginCompletionItems,
  normalizePluginCompletionResult,
  normalizePluginDecorationResult,
} from './pluginTerminalProviders.ts';

test('plugin completion results are bounded, normalized, ranked, and deduplicated', () => {
  const alpha = normalizePluginCompletionResult('alpha', {
    items: [
      { text: 'git status', displayText: 'status', score: 10 },
      { text: '', score: 100 },
    ],
  });
  const beta = normalizePluginCompletionResult('beta', {
    items: [
      { text: 'git status', score: 20 },
      { text: 'git stash', description: 'Stash changes', score: 5 },
    ],
  });
  assert.deepEqual(mergePluginCompletionItems([alpha, beta], 10).map((item) => item.text), [
    'git status',
    'git stash',
  ]);
  assert.equal(alpha[0]?.displayText, 'git status');
  assert.deepEqual(normalizePluginCompletionResult('transparent', {
    items: [{
      text: 'rm -rf -- /important-data',
      displayText: 'Refresh project index',
      score: 100,
    }],
  }), [{
    text: 'rm -rf -- /important-data',
    displayText: 'rm -rf -- /important-data',
    score: 100,
    providerId: 'transparent',
  }]);
  assert.deepEqual(normalizePluginCompletionResult('unsafe', {
    items: [{ text: 'echo safe\nrm -rf /', score: 100 }, { text: 'safe', displayText: '\u202eevil' }],
  }), [{
    text: 'safe',
    displayText: 'safe',
    score: 0,
    providerId: 'unsafe',
  }]);
});

test('plugin decoration results reject unsafe expressions and namespace rule identity', () => {
  assert.equal(isSafePluginDecorationPattern('\\berror\\b'), true);
  assert.equal(isSafePluginDecorationPattern('^(a+)+$'), false);
  assert.equal(isSafePluginDecorationPattern('a*a*a*a*a*a*a*a*a*a*b'), false);
  assert.equal(isSafePluginDecorationPattern('[a-z]*[m-z]*missing'), false);
  assert.equal(isSafePluginDecorationPattern('[a-f]*[0-9]*value'), true);
  assert.equal(isSafePluginDecorationPattern('\\berror\\s+\\d+\\b'), true);
  assert.equal(isSafePluginDecorationPattern('['), false);
  assert.deepEqual(normalizePluginDecorationResult('com.example.decoration', {
    rules: [{ id: 'error', label: 'Error', patterns: ['\\berror\\b'], color: '#ff0000' }],
  }), [{
    id: 'com.example.decoration:error',
    label: 'Error',
    patterns: ['\\berror\\b'],
    color: '#ff0000',
    enabled: true,
    providerId: 'com.example.decoration',
  }]);
  assert.deepEqual(normalizePluginDecorationResult('com.example.decoration', {
    rules: [{ id: 'unsafe', label: 'Unsafe', patterns: ['^(a+)+$'], color: '#ff0000' }],
  }), []);
  const groups = Array.from({ length: 3 }, (_, group) => normalizePluginDecorationResult(
    `com.example.decoration${group}`,
    { rules: Array.from({ length: 32 }, (_, index) => ({
      id: `rule${index}`,
      label: `Rule ${index}`,
      patterns: [`value-${group}-${index}`],
      color: '#ff0000',
    })) },
  ));
  assert.equal(mergePluginDecorationRules(groups).length, 64);
});
