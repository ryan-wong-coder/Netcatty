import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSftpColumnTemplate,
  DEFAULT_SFTP_COLUMN_VISIBILITY,
  normalizeSftpColumnVisibility,
  type ColumnWidths,
} from './utils.ts';

const widths: ColumnWidths = {
  name: 56,
  modified: 28,
  size: 7,
  type: 9,
};

test('normalizes missing and invalid SFTP column preferences to all columns', () => {
  assert.deepEqual(normalizeSftpColumnVisibility(null), DEFAULT_SFTP_COLUMN_VISIBILITY);
  assert.deepEqual(normalizeSftpColumnVisibility('invalid'), DEFAULT_SFTP_COLUMN_VISIBILITY);
});

test('keeps the name column visible while restoring optional column preferences', () => {
  assert.deepEqual(
    normalizeSftpColumnVisibility({ name: false, modified: false, size: true, type: false }),
    { name: true, modified: false, size: true, type: false },
  );
});

test('builds a grid containing only visible SFTP columns', () => {
  const template = buildSftpColumnTemplate(widths, {
    name: true,
    modified: false,
    size: true,
    type: false,
  });

  assert.equal(template, 'minmax(140px, 56fr) minmax(52px, 7fr)');
});

test('can reduce the SFTP file list to only the name column', () => {
  assert.equal(
    buildSftpColumnTemplate(widths, {
      name: true,
      modified: false,
      size: false,
      type: false,
    }),
    'minmax(140px, 56fr)',
  );
});
