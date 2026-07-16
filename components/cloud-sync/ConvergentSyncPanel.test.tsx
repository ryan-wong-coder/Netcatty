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
