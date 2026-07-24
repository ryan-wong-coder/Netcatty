import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ImportVaultDialog.tsx', import.meta.url), 'utf8');

test('closing the importer dialog invalidates, cancels, and clears an active plugin request', () => {
  assert.match(source, /pluginImportGenerationRef\.current \+= 1;/u);
  assert.match(source, /const requestId = activePluginImportRequestRef\.current;[\s\S]*activePluginImportRequestRef\.current = null;[\s\S]*pluginExtensionBridge\.cancelRequest\(requestId\)/u);
  assert.match(source, /setPluginPreview\(null\);[\s\S]*setPluginProgress\(null\);[\s\S]*setPluginBusy\(false\);/u);
});

test('late plugin importer results cannot repopulate state after close or replacement', () => {
  assert.match(source, /const generation = \+\+pluginImportGenerationRef\.current;/u);
  assert.match(source, /const isCurrent = \(\) => pluginImportGenerationRef\.current === generation;/u);
  assert.match(source, /if \(!selection \|\| !isCurrent\(\)\) return;/u);
  assert.match(source, /if \(isCurrent\(\)\) setPluginPreview\(preview\);/u);
  assert.match(source, /if \(isCurrent\(\)\) setPluginError/u);
  assert.match(source, /if \(selection && !consumed\)[\s\S]*releaseImporterFile\(selection\.selectionToken\)/u);
});

test('importer detection is cancellable before awaiting provider work', () => {
  assert.match(
    source,
    /requestId = crypto\.randomUUID\(\);[\s\S]*activePluginImportRequestRef\.current = requestId;[\s\S]*await pluginExtensionBridge\.detectImporter\(\{\s*requestId,/u,
  );
});
