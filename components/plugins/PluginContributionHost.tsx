import { X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  isPluginShortcutEditableEvent,
  normalizePluginKeyboardEvent,
  normalizePluginShortcut,
  resolvePluginShortcutPlatform,
} from '../../application/state/pluginKeybindings';
import {
  canRetainPluginViewInScope,
  resolvePluginRetainedViewKey,
  resolvePluginViewWindowScope,
} from '../../application/state/pluginViewScopes';
import { PLUGIN_THEME_TOKEN_NAMES } from '../../application/state/pluginContributionEnvironment';
import { usePluginContributions } from '../../application/state/usePluginContributions';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import { useActiveTabId } from '../../application/state/activeTabStore';
import {
  pluginViewTabStore,
  resolvePluginViewRequest,
  usePluginViewTabs,
} from '../../application/state/pluginViewTabStore';
import {
  consumeClosedPluginViewInstance,
  markPluginViewOpenTokensClosed,
  reconcileClosedPluginView,
  rememberClosedPluginViewInstance,
  withdrawPluginViewTab,
  type HostedPluginViewState,
} from '../../application/state/pluginViewLifecycle';
import { PluginContributionIcon } from './PluginContributionIcon';

export const OPEN_PLUGIN_VIEW_EVENT = 'netcatty:open-plugin-view';
const DEFAULT_KEYBINDING_CONTEXT = Object.freeze({ 'netcatty.surface': 'keybinding' });

interface OpenPluginViewDetail {
  viewId: string;
  context?: Record<string, unknown>;
}

type HostedPluginView = HostedPluginViewState;

export function requestOpenPluginView(detail: OpenPluginViewDetail) {
  window.dispatchEvent(new CustomEvent(OPEN_PLUGIN_VIEW_EVENT, { detail }));
}

export function PluginContributionHost({
  locale,
  theme,
  themeTokens: suppliedThemeTokens,
  keybindingContext = DEFAULT_KEYBINDING_CONTEXT,
}: {
  locale: string;
  theme: string;
  themeTokens?: Record<string, string>;
  keybindingContext?: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const [requested, setRequested] = useState<OpenPluginViewDetail | null>(null);
  const activeTabId = useActiveTabId();
  const pluginViewTabs = usePluginViewTabs();
  const activePluginTab = pluginViewTabs.find((tab) => tab.id === activeTabId) ?? null;
  const effectiveRequested = resolvePluginViewRequest(requested, activePluginTab);
  const contributions = usePluginContributions({
    locale,
    context: keybindingContext,
  });
  const viewContributions = usePluginContributions({
    locale,
    context: effectiveRequested?.context ?? { 'netcatty.surface': 'view' },
  });
  const {
    snapshot,
    executeCommand,
    openView,
    closeView,
    setViewBounds,
    setViewVisibility,
    setEnvironment,
    onViewClosed,
  } = contributions;
  const [instance, setInstance] = useState<HostedPluginView | null>(null);
  const instanceRef = useRef<HostedPluginView | null>(null);
  const retainedViewsRef = useRef(new Map<string, HostedPluginView>());
  const closedInstanceIdsRef = useRef(new Set<string>());
  const openingTokensByTabRef = useRef(new Map<string, Set<symbol>>());
  const openingTokensByViewRef = useRef(new Map<string, Set<symbol>>());
  const explicitlyClosedOpenTokensRef = useRef(new Set<symbol>());
  const closeViewRef = useRef(closeView);
  const mountRef = useRef<HTMLDivElement>(null);
  const activeView = useMemo(() => viewContributions.snapshot.plugins
    .flatMap((plugin) => plugin.views.map((view) => ({ plugin, view })))
    .find(({ view }) => view.id === effectiveRequested?.viewId && view.visible) ?? null,
  [effectiveRequested?.viewId, viewContributions.snapshot.plugins]);
  const activeViewId = activeView?.view.id;
  const viewScopeId = typeof window === 'undefined'
    ? 'window:server'
    : resolvePluginViewWindowScope(window.location);
  const retainedViewKey = activeViewId
    ? resolvePluginRetainedViewKey(activeViewId, viewScopeId)
    : null;

  useEffect(() => { closeViewRef.current = closeView; }, [closeView]);

  useEffect(() => onViewClosed((event) => {
    const next = reconcileClosedPluginView({
      current: instanceRef.current,
      retained: retainedViewsRef.current,
      instanceId: event.instanceId,
    });
    instanceRef.current = next.current;
    retainedViewsRef.current = next.retained;
    if (!next.matchedCurrent && !next.matchedRetained) {
      rememberClosedPluginViewInstance(closedInstanceIdsRef.current, event.instanceId);
    }
    if (next.matchedCurrent) {
      setInstance(null);
      setRequested(null);
    }
    if (next.closedTabId) pluginViewTabStore.close(next.closedTabId);
  }), [onViewClosed]);

  useEffect(() => pluginViewTabStore.onDidClose(({ tab }) => {
    const next = withdrawPluginViewTab({
      current: instanceRef.current,
      retained: retainedViewsRef.current,
      tabId: tab.id,
    });
    instanceRef.current = next.current;
    retainedViewsRef.current = next.retained;
    markPluginViewOpenTokensClosed(
      openingTokensByTabRef.current,
      explicitlyClosedOpenTokensRef.current,
      tab.id,
    );
    if (next.matchedCurrent) {
      setInstance(null);
      setRequested(null);
    }
    for (const instanceId of next.instanceIds) {
      void closeViewRef.current(instanceId).catch(() => {});
    }
  }), []);

  useEffect(() => {
    const bindings = snapshot.plugins.flatMap((plugin) => plugin.keybindings)
      .filter((binding) => binding.enabled)
      .sort((left, right) => `${left.command}:${left.key}`.localeCompare(`${right.command}:${right.key}`));
    const platformKey = resolvePluginShortcutPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isPluginShortcutEditableEvent(event)) return;
      const pressed = normalizePluginKeyboardEvent(event);
      if (!pressed) return;
      const binding = bindings.find((candidate) => {
        const declared = candidate[platformKey] ?? candidate.key;
        return normalizePluginShortcut(declared, platformKey) === pressed;
      });
      if (!binding) return;
      event.preventDefault();
      void executeCommand(binding.command, binding.args, keybindingContext);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [executeCommand, keybindingContext, snapshot.plugins]);

  useEffect(() => {
    const listener = (event: Event) => setRequested((event as CustomEvent<OpenPluginViewDetail>).detail);
    window.addEventListener(OPEN_PLUGIN_VIEW_EVENT, listener);
    return () => window.removeEventListener(OPEN_PLUGIN_VIEW_EVENT, listener);
  }, []);

  useEffect(() => {
    const tabViews = contributions.snapshot.plugins.flatMap((plugin) => plugin.views
      .filter((view) => view.location === 'tab')
      .map((view) => ({
        pluginId: plugin.id,
        pluginName: plugin.displayName,
        viewId: view.id,
        title: view.title,
        icon: view.icon,
      })));
    const validViewIds = new Set(tabViews.map((view) => view.viewId));
    pluginViewTabStore.retain(validViewIds);
    pluginViewTabStore.refreshMetadata(tabViews);
  }, [contributions.snapshot.plugins]);

  useEffect(() => {
    if (!requested || activeView?.view.location !== 'tab') return;
    pluginViewTabStore.open({
      pluginId: activeView.plugin.id,
      pluginName: activeView.plugin.displayName,
      viewId: activeView.view.id,
      title: activeView.view.title,
      icon: activeView.view.icon,
      context: requested.context,
    });
    setRequested(null);
  }, [activeView, requested]);

  const hideOrClose = useCallback(async (current: HostedPluginView) => {
    if (!current.retainContextWhenHidden) {
      await closeView(current.id);
      return;
    }
    const key = resolvePluginRetainedViewKey(current.viewId, current.scopeId);
    retainedViewsRef.current.set(key, current);
    try {
      await setViewVisibility(current.id, false);
    } catch {
      retainedViewsRef.current.delete(key);
      await closeView(current.id);
    }
  }, [closeView, setViewVisibility]);

  const close = useCallback(async () => {
    markPluginViewOpenTokensClosed(
      openingTokensByViewRef.current,
      explicitlyClosedOpenTokensRef.current,
      retainedViewKey,
    );
    const current = instanceRef.current;
    instanceRef.current = null;
    setInstance(null);
    setRequested(null);
    if (current) await closeView(current.id);
  }, [closeView, retainedViewKey]);

  useEffect(() => {
    for (const [key, retained] of retainedViewsRef.current) {
      if (canRetainPluginViewInScope(retained.scopeId, viewScopeId)) continue;
      retainedViewsRef.current.delete(key);
      void closeView(retained.id).catch(() => {});
    }
  }, [closeView, viewScopeId]);

  useEffect(() => {
    if (!instance) return;
    if (effectiveRequested?.viewId === instance.viewId
      && activeViewId === instance.viewId
      && instance.scopeId === viewScopeId) return;
    instanceRef.current = null;
    setInstance(null);
    if (canRetainPluginViewInScope(instance.scopeId, viewScopeId)) {
      void hideOrClose(instance);
    } else {
      void closeView(instance.id).catch(() => {});
    }
  }, [activeViewId, closeView, effectiveRequested?.viewId, hideOrClose, instance, viewScopeId]);

  useEffect(() => {
    if (!activeViewId || !retainedViewKey || !mountRef.current || instance) return;
    let cancelled = false;
    const openingToken = Symbol(activePluginTab?.id ?? activeViewId);
    const openingTabId = activePluginTab?.id;
    const openingViewKey = retainedViewKey;
    const viewTokens = openingTokensByViewRef.current.get(openingViewKey) ?? new Set<symbol>();
    viewTokens.add(openingToken);
    openingTokensByViewRef.current.set(openingViewKey, viewTokens);
    if (openingTabId) {
      const tokens = openingTokensByTabRef.current.get(openingTabId) ?? new Set<symbol>();
      tokens.add(openingToken);
      openingTokensByTabRef.current.set(openingTabId, tokens);
    }
    const bounds = mountRef.current.getBoundingClientRect();
    const nextBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    void (async () => {
      let opened = retainedViewsRef.current.get(retainedViewKey) ?? null;
      if (opened) {
        retainedViewsRef.current.delete(retainedViewKey);
        try {
          await setViewBounds(opened.id, nextBounds);
          await setViewVisibility(opened.id, true);
        } catch {
          try { await closeView(opened.id); } catch {}
          opened = null;
        }
      }
      if (!opened) {
        const result = await openView({
          viewId: activeViewId,
          scopeId: viewScopeId,
          bounds: nextBounds,
          context: effectiveRequested?.context,
        });
        opened = {
          id: result.instanceId,
          viewId: activeViewId,
          scopeId: viewScopeId,
          retainContextWhenHidden: activeView.view.retainContextWhenHidden === true,
          ...(activePluginTab ? { tabId: activePluginTab.id } : {}),
        };
      }
      if (consumeClosedPluginViewInstance(closedInstanceIdsRef.current, opened.id)) {
        throw new Error('Plugin view closed while its open response was in flight');
      }
      if (explicitlyClosedOpenTokensRef.current.has(openingToken)) {
        await closeView(opened.id);
        return;
      }
      if (cancelled) {
        await hideOrClose(opened);
        return;
      }
      instanceRef.current = opened;
      setInstance(opened);
    })().catch(() => {
      if (cancelled) return;
      if (activePluginTab) pluginViewTabStore.close(activePluginTab.id);
      else setRequested(null);
    }).finally(() => {
      explicitlyClosedOpenTokensRef.current.delete(openingToken);
      const viewTokens = openingTokensByViewRef.current.get(openingViewKey);
      viewTokens?.delete(openingToken);
      if (viewTokens?.size === 0) openingTokensByViewRef.current.delete(openingViewKey);
      if (!openingTabId) return;
      const tokens = openingTokensByTabRef.current.get(openingTabId);
      tokens?.delete(openingToken);
      if (tokens?.size === 0) openingTokensByTabRef.current.delete(openingTabId);
    });
    return () => { cancelled = true; };
  }, [
    activeView?.view.retainContextWhenHidden,
    activeViewId,
    closeView,
    hideOrClose,
    instance,
    openView,
    retainedViewKey,
    activePluginTab,
    effectiveRequested?.context,
    setViewBounds,
    setViewVisibility,
    viewScopeId,
  ]);

  useEffect(() => {
    if (!instance || !mountRef.current) return;
    const update = () => {
      const bounds = mountRef.current?.getBoundingClientRect();
      if (!bounds) return;
      void setViewBounds(instance.id, {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(mountRef.current);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [instance, setViewBounds]);

  useEffect(() => {
    if (!contributions.available) return;
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedColorsQuery = window.matchMedia('(forced-colors: active)');
    const contrastQuery = window.matchMedia('(prefers-contrast: more)');
    let frame = 0;
    const publish = () => {
      frame = 0;
      const styles = suppliedThemeTokens ? null : getComputedStyle(document.documentElement);
      const themeTokens = suppliedThemeTokens ?? Object.fromEntries(PLUGIN_THEME_TOKEN_NAMES
        .map((name) => [name, styles?.getPropertyValue(name).trim() ?? '']));
      void setEnvironment({
        locale,
        theme,
        reducedMotion: reducedMotionQuery.matches,
        highContrast: forcedColorsQuery.matches || contrastQuery.matches,
        themeTokens,
      }).catch(() => {});
    };
    const schedulePublish = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(publish);
    };
    const queries = [reducedMotionQuery, forcedColorsQuery, contrastQuery];
    for (const query of queries) query.addEventListener?.('change', schedulePublish);
    const observer = new MutationObserver(schedulePublish);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    publish();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const query of queries) query.removeEventListener?.('change', schedulePublish);
    };
  }, [contributions.available, locale, setEnvironment, suppliedThemeTokens, theme]);

  useEffect(() => () => {
    const current = instanceRef.current;
    instanceRef.current = null;
    const retained = [...retainedViewsRef.current.values()];
    retainedViewsRef.current.clear();
    closedInstanceIdsRef.current.clear();
    openingTokensByTabRef.current.clear();
    openingTokensByViewRef.current.clear();
    explicitlyClosedOpenTokensRef.current.clear();
    const ids = new Set([current?.id, ...retained.map((view) => view.id)].filter(Boolean));
    for (const id of ids) void closeViewRef.current(id as string);
  }, []);

  if (!effectiveRequested || !activeView) return null;
  const location = activeView.view.location;
  const containerClass = location === 'aside'
    ? 'absolute inset-y-0 right-0 z-40 w-[420px] border-l border-border bg-background shadow-2xl'
    : location === 'panel'
      ? 'absolute inset-x-0 bottom-0 z-40 h-[42%] border-t border-border bg-background shadow-2xl'
      : location === 'modal'
        ? 'fixed left-1/2 top-1/2 z-50 h-[70vh] w-[min(800px,85vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background shadow-2xl'
        : 'absolute inset-0 z-40 bg-background';

  if (location === 'tab') {
    return (
      <section className={`${containerClass} flex flex-col`} role="region" aria-label={activeView.view.title}>
        <div ref={mountRef} className="min-h-0 flex-1" />
      </section>
    );
  }

  return (
    <section
      className={`${containerClass} flex flex-col`}
      role={location === 'modal' ? 'dialog' : 'region'}
      aria-modal={location === 'modal' ? true : undefined}
      aria-label={activeView.view.title}
    >
      <header className="app-no-drag flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <PluginContributionIcon pluginId={activeView.plugin.id} icon={activeView.view.icon} className="shrink-0" />
          <div className="min-w-0">
          <div className="truncate text-sm font-medium">{activeView.view.title}</div>
          <div className="truncate text-[10px] text-muted-foreground">{activeView.plugin.displayName}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void close()}
          aria-label={t('common.close')}
          autoFocus={location === 'modal'}
        >
          <X size={14} />
        </Button>
      </header>
      <div ref={mountRef} className="min-h-0 flex-1" />
    </section>
  );
}
