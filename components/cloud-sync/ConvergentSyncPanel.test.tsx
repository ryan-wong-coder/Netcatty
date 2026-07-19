import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConvergentSyncPanel } from './ConvergentSyncPanel.tsx';

const t = (key: string, values?: Record<string, string | number>) =>
  key === 'cloudSync.convergent.conflict.secretSet'
    ? 'SECRET_SET'
    : `${key}${values?.count === undefined ? '' : `:${values.count}`}`;

test('secret conflict candidates never render their value', () => {
  const markup = renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: true, initialized: true }}
      preview={null}
      busy={false}
      error={null}
      conflicts={[{
        address: { kind: 'entity-field', collection: 'keys', entityId: 'key-1', field: 'privateKey' },
        candidates: [{
          dot: { deviceId: 'device-a', counter: 1 },
          hlc: { wallTime: 1, logical: 0 },
          tombstone: false,
          value: 'PRIVATE-CONTENT-MUST-NOT-RENDER',
          selected: true,
        }],
      }]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );

  assert.equal(markup.includes('PRIVATE-CONTENT-MUST-NOT-RENDER'), false);
  assert.equal(markup.includes('SECRET_SET'), true);
  assert.match(
    markup,
    /data-testid="convergent-sync-icon"[^>]*class="[^"]*h-9[^"]*w-9[^"]*self-start/,
  );
});

test('secret fields nested inside array candidates never reach rendered markup', () => {
  const markup = renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: true, initialized: true }}
      preview={null}
      busy={false}
      error={null}
      conflicts={[{
        address: { kind: 'setting', path: ['ai', 'providers'] },
        candidates: [{
          dot: { deviceId: 'device-a', counter: 1 },
          hlc: { wallTime: 1, logical: 0 },
          tombstone: false,
          value: [{
            id: 'provider-1',
            name: 'Private provider',
            credentials: { apiKey: 'NESTED-API-KEY-MUST-NOT-RENDER' },
          }],
          selected: true,
        }],
      }]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );

  assert.equal(markup.includes('NESTED-API-KEY-MUST-NOT-RENDER'), false);
  assert.equal(markup.includes('SECRET_SET'), true);
});

test('pending setup keeps the switch on and disabled until the replica is created', () => {
  const migrationPreview = {
    schemaVersion: 2 as const,
    canInitialize: true,
    entityCounts: {},
    settingsLeafCount: 0,
    conflictCount: 0,
    conflicts: [],
    shrinkFindings: [],
    providers: [],
    oldClientCompatibility: 'materialized-v1-snapshot' as const,
    blockedReasons: [],
  };
  const renderPanel = (
    preview: typeof migrationPreview | null,
    busy = false,
  ) => renderToStaticMarkup(
    <ConvergentSyncPanel
      t={t}
      resolvedLocale="en"
      config={{ enabled: false, initialized: false }}
      preview={preview}
      busy={busy}
      error={null}
      conflicts={[]}
      onToggle={() => {}}
      onConfirmMigration={() => {}}
      onCancelMigration={() => {}}
      onResolveConflict={() => {}}
      onDowngrade={() => {}}
    />,
  );

  assert.equal(
    renderPanel(migrationPreview).includes('cloudSync.convergent.setupRequired'),
    true,
  );
  assert.match(
    renderPanel(migrationPreview),
    /role="switch"[^>]*aria-checked="true"[^>]*disabled=""/,
  );
  assert.equal(
    renderPanel(null).includes('cloudSync.convergent.setupRequired'),
    false,
  );
  assert.match(renderPanel(null), /role="switch"[^>]*aria-checked="false"/);
  assert.match(
    renderPanel(null, true),
    /role="switch"[^>]*aria-checked="true"[^>]*disabled=""/,
  );
});
