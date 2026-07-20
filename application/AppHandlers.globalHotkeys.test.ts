import assert from 'node:assert/strict';
import test from 'node:test';

import { executeHotkeyActionImpl, getLogHostVisualSnapshot, handleGlobalHotkeyKeyDownImpl } from './app/AppHandlers.ts';
import { matchesKeyBinding } from '../domain/models.ts';
import { DEFAULT_KEY_BINDINGS } from '../domain/models/keyBindings.ts';

class FakeInputHTMLElement {
  tagName = 'INPUT';
  isContentEditable = false;

  closest(): FakeInputHTMLElement | null {
    return null;
  }
}

class FakeHTMLElement {
  tagName = 'TEXTAREA';
  isContentEditable = false;
  classList = {
    contains: (className: string) => className === 'xterm-helper-textarea',
  };

  closest(selector: string): FakeHTMLElement | null {
    return selector.includes('xterm') ? this : null;
  }

  hasAttribute(name: string): boolean {
    return name === 'data-session-id';
  }
}

const previousHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = FakeHTMLElement as unknown as typeof HTMLElement;

test.after(() => {
  globalThis.HTMLElement = previousHTMLElement;
});

test('global hotkey handler lets terminal font size shortcuts reach xterm', () => {
  const target = new FakeHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  let stopped = false;
  const event = {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, []);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});

test('global hotkey handler routes quick switch through focused search inputs', () => {
  const target = new FakeInputHTMLElement();
  const handledActions: string[] = [];
  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, ['quickSwitch']);
});

test('quick switch hotkey toggles the quick switcher open state', () => {
  let isQuickSwitcherOpen = false;
  const setIsQuickSwitcherOpen = (next: boolean) => {
    isQuickSwitcherOpen = next;
  };
  const noop = () => {};
  const baseCtx = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => 'vault' },
    addConnectionLogRef: { current: noop },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isQuickSwitcherOpen,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    workspaces: [],
  };

  const event = {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent;

  executeHotkeyActionImpl(() => baseCtx, 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, true);

  executeHotkeyActionImpl(() => ({ ...baseCtx, isQuickSwitcherOpen: true }), 'quickSwitch', event);
  assert.equal(isQuickSwitcherOpen, false);
});

test('close tab hotkey routes native plugin view tabs through their owner', () => {
  let closedTabId = '';
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  const noop = () => {};

  executeHotkeyActionImpl(() => ({
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => pluginTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: (tabId: string) => { closedTabId = tabId; },
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: [pluginTabId],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: noop,
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  }), 'closeTab', { key: 'w', metaKey: true } as KeyboardEvent);

  assert.equal(closedTabId, pluginTabId);
});

test('next, previous, and number shortcuts include native plugin view tabs', () => {
  const pluginTabId = 'plugin-view:com.example.view:com.example.view.panel';
  let activeTabId = 'session-1';
  const selected: string[] = [];
  const noop = () => {};
  const context = {
    IS_DEV: false,
    MOVE_FOCUS_DEBOUNCE_MS: 0,
    activeTabStore: { getActiveTabId: () => activeTabId },
    addConnectionLogRef: { current: noop },
    closePluginViewTab: noop,
    closeSession: noop,
    closeTabInFlightRef: { current: false },
    closeWorkspace: noop,
    collectSessionIds: () => [],
    confirmIfBusyLocalTerminal: async () => true,
    createLocalTerminalWithCurrentShell: noop,
    editorTabs: [],
    fromEditorTabId: () => null,
    handleOpenSettingsRef: { current: noop },
    handleRequestCloseEditorTabRef: { current: noop },
    isEditorTabId: () => false,
    isPluginViewTabId: (tabId: string) => tabId.startsWith('plugin-view:'),
    isQuickSwitcherOpen: false,
    lastMoveFocusTimeRef: { current: 0 },
    moveFocusInWorkspace: noop,
    orderedTabs: ['session-1', pluginTabId, 'session-2'],
    resolveCloseIntent: () => ({ kind: 'noop' }),
    resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
    sessions: [],
    setActiveTabId: (id: string) => { activeTabId = id; selected.push(id); },
    setAddToWorkspaceDialog: noop,
    setIsQuickSwitcherOpen: noop,
    setNavigateToSection: noop,
    settings: { showSftpTab: false, shellOnlyTabNumberShortcuts: false },
    splitSessionWithCurrentShell: noop,
    systemInfoRef: { current: { username: 'user', hostname: 'host' } },
    toEditorTabId: (id: string) => `editor:${id}`,
    toggleBroadcast: noop,
    toggleScriptsSidePanelRef: { current: noop },
    toggleSidePanelRef: { current: noop },
    toggleWorkspaceViewMode: noop,
    workspaces: [],
  };

  executeHotkeyActionImpl(() => context, 'nextTab', { key: 'Tab', ctrlKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  executeHotkeyActionImpl(() => context, 'prevTab', { key: 'Tab', ctrlKey: true, shiftKey: true } as KeyboardEvent);
  assert.equal(activeTabId, 'session-1');
  executeHotkeyActionImpl(() => context, 'switchToTab', { key: '3', metaKey: true } as KeyboardEvent);
  assert.equal(activeTabId, pluginTabId);
  assert.deepEqual(selected, [pluginTabId, 'session-1', pluginTabId]);
});

test('next tab includes pinned tabs when shell-only shortcut mode is disabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: false },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'sftp');
});

test('next tab skips pinned tabs when shell-only shortcut mode is enabled', () => {
  let activeTabId = '';
  const noop = () => {};

  executeHotkeyActionImpl(
    () => ({
      IS_DEV: false,
      MOVE_FOCUS_DEBOUNCE_MS: 0,
      activeTabStore: { getActiveTabId: () => 'vault' },
      addConnectionLogRef: { current: noop },
      closeSession: noop,
      closeTabInFlightRef: { current: false },
      closeWorkspace: noop,
      collectSessionIds: () => [],
      confirmIfBusyLocalTerminal: async () => true,
      createLocalTerminalWithCurrentShell: noop,
      editorTabs: [{ id: 'editor-1' }],
      fromEditorTabId: () => null,
      handleOpenSettingsRef: { current: noop },
      handleRequestCloseEditorTabRef: { current: noop },
      isEditorTabId: () => false,
      isQuickSwitcherOpen: false,
      lastMoveFocusTimeRef: { current: 0 },
      moveFocusInWorkspace: noop,
      orderedTabs: ['session-1'],
      resolveCloseIntent: () => ({ kind: 'noop' }),
      resolveSnippetsShortcutIntent: () => ({ kind: 'noop' }),
      sessions: [],
      setActiveTabId: (id: string) => { activeTabId = id; },
      setAddToWorkspaceDialog: noop,
      setIsQuickSwitcherOpen: noop,
      setNavigateToSection: noop,
      settings: { showSftpTab: true, shellOnlyTabNumberShortcuts: true },
      splitSessionWithCurrentShell: noop,
      systemInfoRef: { current: { username: 'user', hostname: 'host' } },
      toEditorTabId: (id: string) => `editor:${id}`,
      toggleBroadcast: noop,
      toggleScriptsSidePanelRef: { current: noop },
      toggleSidePanelRef: { current: noop },
      toggleWorkspaceViewMode: noop,
      workspaces: [],
    }),
    'nextTab',
    { key: 'Tab', ctrlKey: true } as KeyboardEvent,
  );

  assert.equal(activeTabId, 'session-1');
});

test('connection log host snapshot includes custom host icon fields', () => {
  assert.deepEqual(
    getLogHostVisualSnapshot({
      id: 'host-1',
      label: 'Database',
      hostname: 'db.example.com',
      username: 'root',
      tags: [],
      os: 'linux',
      distro: 'ubuntu',
      iconMode: 'custom',
      iconId: 'database',
      iconColor: 'blue',
    }),
    {
      hostOs: 'linux',
      hostDistro: 'ubuntu',
      hostIconMode: 'custom',
      hostIconId: 'database',
      hostIconColorMode: 'manual',
      hostIconColor: 'blue',
    },
  );
});
