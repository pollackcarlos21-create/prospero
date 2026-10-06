import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PermissionDecision, PermissionRequest } from '@prospero/core';
import type {
  Bootstrap,
  Conversation,
  ConversationSummary,
  DesktopBridge,
  DesktopEvent,
  ContextMenuTarget,
  ProviderConfig,
  Settings as SettingsValue,
  WebSearchConfig,
} from '../bridge';
import { ConversationStore, activeStates, statusLabel, summaryOf } from './conversation-store';
import { Settings, type SettingsTab } from './Settings';
import { Mark, Timeline } from './Timeline';
import { friendlyError } from './friendly-error';
import { ComposerDrafts } from './composer-drafts';
import { CommandPalette, ConversationSheet, type PaletteCommand } from './mac-dialogs';
import { ScopeSheet } from './ScopeSheet';
const initialSettings: SettingsValue = { theme: 'system', askBeforeReads: false, memory: [] };
export function App({ bridge = window.prospero }: { bridge?: DesktopBridge }) {
  const store = useRef(new ConversationStore()).current;
  const drafts = useRef(new ComposerDrafts()).current;
  const [data, setData] = useState<Bootstrap>({
    conversations: [],
    providers: [],
    settings: initialSettings,
    version: '0.2.0',
  });
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const [palette, setPalette] = useState(false);
  const [scopeSheet, setScopeSheet] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const desktopAction = useRef<(event: Extract<DesktopEvent, { type: 'desktop-action' }>) => void>(
    () => {},
  );
  const selection = useRef<string | undefined>(undefined);
  const restoreVersion = useRef(0);
  const upsert = useCallback(
    (conversation: Conversation, immediate = true) => {
      if (immediate) store.put(conversation);
      else store.queue(conversation);
      const summary = summaryOf(conversation);
      setData((previous) => {
        const current = previous.conversations.find((value) => value.id === conversation.id);
        // Token deltas do not rerender the sidebar or application shell.
        if (
          current &&
          current.title === summary.title &&
          current.state === summary.state &&
          current.workspace === summary.workspace &&
          current.providerId === summary.providerId
        )
          return previous;
        return {
          ...previous,
          conversations: [
            summary,
            ...previous.conversations.filter((value) => value.id !== summary.id),
          ].sort((a, b) => b.updatedAt - a.updatedAt),
        };
      });
    },
    [store],
  );
  const select = useCallback(
    async (id: string) => {
      const token = ++restoreVersion.current;
      selection.current = id;
      setSelected(id);
      setError('');
      try {
        const conversation = await bridge.getConversation(id);
        if (restoreVersion.current === token) upsert(conversation);
      } catch {
        if (restoreVersion.current === token)
          setError('Could not open this conversation. Please try again.');
      }
    },
    [bridge, upsert],
  );
  useEffect(() => {
    let mounted = true;
    if (!bridge) {
      setLoading(false);
      setError('The desktop connection is unavailable. Restart Prospero to reconnect.');
      return;
    }
    const unsubscribe = bridge.onEvent((event) => {
      if (!mounted) return;
      if (event.type === 'bootstrap') setData(event.data);
      else if (event.type === 'desktop-action') desktopAction.current(event);
      else if (event.type === 'desktop-appearance')
        setData((previous) => ({ ...previous, appearance: event.appearance }));
      else upsert(event.conversation, false);
    });
    bridge
      .bootstrap()
      .then((value) => {
        if (!mounted) return;
        setData(value);
        setLoading(false);
        const last = value.conversations[0];
        if (last && !selection.current) void select(last.id);
      })
      .catch(() => {
        if (mounted) {
          setLoading(false);
          setError('Could not load your saved data. Restart Prospero and try again.');
        }
      });
    return () => {
      mounted = false;
      unsubscribe();
      store.dispose();
    };
  }, [bridge, select, store, upsert]);
  useEffect(() => {
    document.documentElement.dataset.theme = data.settings.theme;
  }, [data.settings.theme]);
  useEffect(() => {
    if (!loading && bridge) void bridge.ready().catch(() => {});
  }, [bridge, loading]);
  useEffect(() => {
    if (!data.appearance) return;
    document.documentElement.dataset.systemAppearance = data.appearance.dark ? 'dark' : 'light';
    document.documentElement.dataset.reducedMotion = String(data.appearance.reducedMotion);
  }, [data.appearance]);
  const create = useCallback(
    async (inheritWelcomeDraft = false) => {
      setCreating(true);
      setError('');
      try {
        ++restoreVersion.current;
        const conversation = await bridge.createConversation();
        if (inheritWelcomeDraft) drafts.transferWelcome(conversation.id);
        upsert(conversation);
        selection.current = conversation.id;
        setSelected(conversation.id);
        setTimeout(() => {
          if (!document.querySelector('[aria-modal="true"]')) composer.current?.focus();
        }, 0);
        return conversation;
      } catch {
        setError('Could not create a task. Please try again.');
        return undefined;
      } finally {
        setCreating(false);
      }
    },
    [bridge, drafts, upsert],
  );
  const openSettings = useCallback((tab: SettingsTab = 'General') => {
    setPalette(false);
    setScopeSheet(false);
    setDeleting(undefined);
    setRenaming(undefined);
    setSettingsTab(tab);
  }, []);
  const newTask = useCallback(() => {
    if (creating || loading) return;
    setPalette(false);
    setScopeSheet(false);
    setSettingsTab(undefined);
    setDeleting(undefined);
    setRenaming(undefined);
    void create();
  }, [create, creating, loading]);
  const openPalette = useCallback(() => {
    setScopeSheet(false);
    setSettingsTab(undefined);
    setDeleting(undefined);
    setRenaming(undefined);
    setPalette(true);
  }, []);
  const searchTasks = useCallback(() => {
    setScopeSheet(false);
    setPalette(false);
    setSettingsTab(undefined);
    setDeleting(undefined);
    setRenaming(undefined);
    setCollapsed(false);
    setTimeout(() => search.current?.focus(), 0);
  }, []);
  const contextMenu = useCallback(
    (target: ContextMenuTarget) => {
      void bridge
        .showContextMenu(target)
        .catch(() => setError('Could not open this menu. Please try again.'));
    },
    [bridge],
  );
  const ensure = useCallback(
    async () =>
      selection.current
        ? (store.get(selection.current) ?? (await bridge.getConversation(selection.current)))
        : await create(true),
    [bridge, create, store],
  );
  const chooseWorkspace = useCallback(async () => {
    setError('');
    try {
      const conversation = await ensure();
      if (conversation) upsert(await bridge.chooseWorkspace(conversation.id));
    } catch {
      setError('Could not select this workspace. Try a folder you can access.');
    }
  }, [bridge, ensure, upsert]);
  const attachFiles = useCallback(async () => {
    setError('');
    try {
      const conversation = await ensure();
      if (conversation) upsert(await bridge.attachFiles(conversation.id));
    } catch {
      setError('Could not attach these files. Please try again.');
    }
  }, [bridge, ensure, upsert]);
  const addScope = useCallback(
    async (mode: 'read' | 'write') => {
      const conversation = await ensure();
      if (conversation) upsert(await bridge.addScope(conversation.id, mode));
    },
    [bridge, ensure, upsert],
  );
  const removeScope = useCallback(
    async (scopeId: string) => {
      const id = selection.current;
      if (id) upsert(await bridge.removeScope(id, scopeId));
    },
    [bridge, upsert],
  );
  const closeScopes = useCallback(() => {
    setScopeSheet(false);
    setTimeout(
      () => document.querySelector<HTMLButtonElement>('[aria-label="File scopes"]')?.focus(),
      0,
    );
  }, []);
  const updateSettings = useCallback(
    (settings: SettingsValue) => setData((previous) => ({ ...previous, settings })),
    [],
  );
  const updateProviders = useCallback(
    (providers: ProviderConfig[]) => setData((previous) => ({ ...previous, providers })),
    [],
  );
  const updateWebSearch = useCallback(
    (webSearch: WebSearchConfig) => setData((previous) => ({ ...previous, webSearch })),
    [],
  );
  useEffect(() => {
    desktopAction.current = (event) => {
      if (event.action === 'new-task') newTask();
      else if (event.action === 'settings') openSettings();
      else if (event.action === 'about') openSettings('About');
      else if (event.action === 'command-palette') openPalette();
      else if (event.action === 'search') searchTasks();
      else if (event.action === 'toggle-sidebar') setCollapsed((value) => !value);
      else if (event.conversationId) {
        const summary = data.conversations.find((value) => value.id === event.conversationId);
        if (!summary) return;
        setPalette(false);
        setScopeSheet(false);
        setSettingsTab(undefined);
        if (event.action === 'rename-conversation') {
          setDeleting(undefined);
          setRenaming({ id: summary.id, title: summary.title });
        } else if (event.action === 'confirm-delete-conversation') {
          setRenaming(undefined);
          setDeleting(summary.id);
        }
      }
    };
  }, [data.conversations, newTask, openSettings, openPalette, searchTasks]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!event.shiftKey && event.key.toLowerCase() === 'n') {
          event.preventDefault();
          newTask();
        }
        if (
          (!event.shiftKey && event.key.toLowerCase() === 'k') ||
          (event.shiftKey && event.key.toLowerCase() === 'p')
        ) {
          event.preventDefault();
          openPalette();
        }
        if (!event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          searchTasks();
        }
        if (!event.shiftKey && event.key === '\\') {
          event.preventDefault();
          setCollapsed((value) => !value);
        }
        if (!event.shiftKey && event.key === ',') {
          event.preventDefault();
          openSettings();
        }
      }
      if (event.key === 'Escape') {
        if (palette) {
          setPalette(false);
          event.preventDefault();
        } else if (settingsTab) {
          setSettingsTab(undefined);
          event.preventDefault();
        } else if (renaming) {
          setRenaming(undefined);
          event.preventDefault();
        } else if (deleting) {
          setDeleting(undefined);
          event.preventDefault();
        } else if (scopeSheet) {
          closeScopes();
          event.preventDefault();
        } else if (selected && activeStates.has(store.get(selected)?.state ?? '')) {
          event.preventDefault();
          void bridge
            .stopTask(selected)
            .catch(() => setError('Could not stop this task. Please try again.'));
        }
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [
    bridge,
    newTask,
    openPalette,
    openSettings,
    searchTasks,
    palette,
    renaming,
    deleting,
    selected,
    settingsTab,
    store,
    scopeSheet,
    closeScopes,
  ]);
  async function remove(id: string) {
    try {
      await bridge.deleteConversation(id);
      drafts.set(id, '');
      setData((previous) => ({
        ...previous,
        conversations: previous.conversations.filter((value) => value.id !== id),
      }));
      if (selected === id) {
        selection.current = undefined;
        setSelected(undefined);
        ++restoreVersion.current;
      }
      setDeleting(undefined);
      return true;
    } catch {
      setError('Could not delete this conversation. Stop its task and try again.');
      return false;
    }
  }
  async function rename(id: string, title: string) {
    try {
      upsert(await bridge.renameConversation(id, title));
      return true;
    } catch {
      return false;
    }
  }
  const commands: PaletteCommand[] = [
    { id: 'new', label: 'New task', shortcut: '⌘ N', run: newTask },
    { id: 'search', label: 'Search tasks', shortcut: '⌘ F', run: searchTasks },
    { id: 'settings', label: 'Open Settings', shortcut: '⌘ ,', run: () => openSettings() },
    {
      id: 'sidebar',
      label: collapsed ? 'Show sidebar' : 'Hide sidebar',
      shortcut: '⌘ \\',
      run: () => setCollapsed((value) => !value),
    },
    { id: 'workspace', label: 'Open workspace', run: () => void chooseWorkspace() },
    { id: 'files', label: 'Attach files', run: () => void attachFiles() },
    {
      id: 'composer',
      label: 'Focus composer',
      run: () => setTimeout(() => composer.current?.focus(), 0),
    },
    ...data.conversations.map((value) => ({
      id: `task:${value.id}`,
      label: value.title,
      detail: 'Saved task',
      run: () => void select(value.id),
    })),
  ];
  const modalOpen = !!(settingsTab || deleting || renaming || palette || scopeSheet);
  return (
    <div className={`desktop-app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside
        className="sidebar"
        aria-label="Conversations"
        inert={modalOpen || collapsed || undefined}
        aria-hidden={collapsed || undefined}
      >
        <div className="sidebar-title">
          <div className="brand">
            <Mark small />
            <strong>Prospero</strong>
          </div>
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>
        <button
          type="button"
          className="new-task"
          aria-label="New task"
          disabled={loading || creating}
          onClick={newTask}
        >
          <span>+</span>
          <span className="sidebar-label">{creating ? 'Creating…' : 'New task'}</span>
          <kbd>⌘ N</kbd>
        </button>
        <div
          className="sidebar-content"
          aria-hidden={collapsed || undefined}
          inert={collapsed || undefined}
        >
          <div className="sidebar-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search conversations"
              ref={search}
              placeholder="Search tasks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>⌕</kbd>
          </div>
          <ConversationList
            conversations={data.conversations}
            query={query}
            selected={selected}
            onSelect={select}
            onDelete={(id) => setDeleting(id)}
            onContextMenu={contextMenu}
          />
        </div>
        <div className="sidebar-bottom">
          <button type="button" aria-label="Open settings" onClick={() => openSettings()}>
            <span aria-hidden="true">⚙</span>
            <span className="sidebar-label">Settings</span>
            <kbd>⌘ ,</kbd>
          </button>
          {!collapsed && (
            <div className="local-label">
              <span />
              Local workspace · v{data.version}
            </div>
          )}
        </div>
      </aside>
      <main className="main-pane" inert={modalOpen || undefined}>
        {error && (
          <div className="app-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError('')}
            >
              ×
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading-state" role="status">
            <Mark />
            <p>Opening your workspace…</p>
          </div>
        ) : (
          <ConversationPane
            key={selected ?? 'welcome'}
            id={selected}
            store={store}
            drafts={drafts}
            bridge={bridge}
            providers={data.providers}
            settings={data.settings}
            webSearch={data.webSearch}
            composerRef={composer}
            onCreate={create}
            onUpdate={upsert}
            onWorkspace={chooseWorkspace}
            onFiles={attachFiles}
            onScopes={() => setScopeSheet(true)}
            onSettings={openSettings}
            onContextMenu={contextMenu}
            collapsed={collapsed}
            onExpandSidebar={() => setCollapsed(false)}
          />
        )}
      </main>
      {settingsTab && (
        <Settings
          bridge={bridge}
          initialTab={settingsTab}
          settings={data.settings}
          providers={data.providers}
          version={data.version}
          onSettings={updateSettings}
          onProviders={updateProviders}
          webSearch={data.webSearch}
          onWebSearch={updateWebSearch}
          onClose={() => setSettingsTab(undefined)}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {scopeSheet && (
        <ScopeSheet
          id={selected}
          store={store}
          onAdd={addScope}
          onRemove={removeScope}
          onClose={closeScopes}
        />
      )}
      {deleting && (
        <ConversationSheet
          mode="delete"
          onClose={() => setDeleting(undefined)}
          onSubmit={() => remove(deleting)}
        />
      )}
      {renaming && (
        <ConversationSheet
          mode="rename"
          initialTitle={renaming.title}
          onClose={() => setRenaming(undefined)}
          onSubmit={(title) => rename(renaming.id, title)}
        />
      )}
    </div>
  );
}
function groupLabel(timestamp: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - date.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}
const ConversationList = memo(function ConversationList({
  conversations,
  query,
  selected,
  onSelect,
  onDelete,
  onContextMenu,
}: {
  conversations: ConversationSummary[];
  query: string;
  selected?: string;
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  onContextMenu: (target: ContextMenuTarget) => void;
}) {
  const grouped = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations.filter((value) =>
    value.title.toLowerCase().includes(query.toLowerCase()),
  )) {
    const label = groupLabel(conversation.updatedAt);
    grouped.set(label, [...(grouped.get(label) ?? []), conversation]);
  }
  return (
    <div className="conversation-list" data-testid="conversation-list">
      {grouped.size === 0 && (
        <p className="sidebar-empty">
          {query ? 'No matching tasks' : 'Your tasks will appear here.'}
        </p>
      )}
      {[...grouped].map(([label, values]) => (
        <section key={label}>
          <h2>{label}</h2>
          {values.map((conversation) => (
            <div
              className={`conversation-row ${selected === conversation.id ? 'selected' : ''}`}
              key={conversation.id}
            >
              <button
                type="button"
                className="conversation-select"
                aria-label={`Open ${conversation.title}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu({ kind: 'conversation', conversationId: conversation.id });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    onContextMenu({ kind: 'conversation', conversationId: conversation.id });
                  }
                }}
                aria-current={selected === conversation.id ? 'page' : undefined}
                onClick={() => void onSelect(conversation.id)}
              >
                <span
                  className={`conversation-dot ${activeStates.has(conversation.state) ? 'active' : ''}`}
                  aria-hidden="true"
                />
                <span>{conversation.title}</span>
              </button>
              <button
                type="button"
                className="conversation-delete icon-button"
                aria-label={`Delete ${conversation.title}`}
                onClick={() => onDelete(conversation.id)}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
});
function ConversationPane({
  id,
  store,
  drafts,
  bridge,
  providers,
  settings,
  webSearch,
  composerRef,
  onCreate,
  onUpdate,
  onWorkspace,
  onFiles,
  onScopes,
  onSettings,
  onContextMenu,
  collapsed,
  onExpandSidebar,
}: {
  id?: string;
  store: ConversationStore;
  drafts: ComposerDrafts;
  bridge: DesktopBridge;
  providers: ProviderConfig[];
  settings: SettingsValue;
  webSearch?: WebSearchConfig;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onCreate: () => Promise<Conversation | undefined>;
  onUpdate: (value: Conversation) => void;
  onWorkspace: () => Promise<void>;
  onFiles: () => Promise<void>;
  onScopes: () => void;
  onSettings: (tab?: SettingsTab) => void;
  onContextMenu: (target: ContextMenuTarget) => void;
  collapsed: boolean;
  onExpandSidebar: () => void;
}) {
  const subscribe = useCallback(
    (listener: () => void) => (id ? store.subscribe(id, listener) : () => {}),
    [id, store],
  );
  const snapshot = useCallback(() => (id ? store.get(id) : undefined), [id, store]);
  const conversation = useSyncExternalStore(subscribe, snapshot);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const active = activeStates.has(conversation?.state ?? '');
  const providerId = conversation?.providerId ?? settings.defaultProviderId ?? '';
  const provider = providers.find((value) => value.id === providerId);
  const webSetup: { label: string; tab: SettingsTab } = !provider
    ? { label: 'Web Search: choose a model with tool calling', tab: 'Models' }
    : provider.supportsTools === false
      ? { label: 'Web Search: model tool calling is off', tab: 'Models' }
      : !webSearch?.enabled
        ? { label: 'Web Search: off', tab: 'Web Search' }
        : !webSearch.hasApiKey
          ? { label: 'Web Search: key required', tab: 'Web Search' }
          : { label: 'Web Search configured · approval required', tab: 'Web Search' };
  const decide = useCallback(
    async (request: PermissionRequest, decision: PermissionDecision) => {
      if (!id) return;
      if (request.preview.kind === 'plan') {
        const plan = request.preview.plan;
        if (!plan || decision === 'allow-session') throw new Error('Invalid plan decision');
        await bridge.decideActionPlan(id, request.requestId, plan.digest, decision);
      } else if (request.preview.kind === 'research') {
        const research = request.preview.research;
        if (!research || decision === 'allow-session') throw new Error('Invalid research decision');
        await bridge.decideResearch(id, request.requestId, research.digest, decision);
      } else await bridge.decidePermission(id, request.requestId, decision);
    },
    [bridge, id],
  );
  const send = useCallback(
    async (text: string) => {
      setError('');
      if (!provider) {
        setError('Add a model provider in Settings before starting a task.');
        onSettings('Models');
        return false;
      }
      setSending(true);
      try {
        let current = (id ? store.get(id) : undefined) ?? (await onCreate());
        if (!current) return false;
        if (current.providerId !== provider.id) {
          current = await bridge.selectProvider(current.id, provider.id);
          onUpdate(current);
        }
        await bridge.sendTask(current.id, text);
        return true;
      } catch (error) {
        setError(
          friendlyError(
            error,
            'Could not start this task. Check your model connection and try again.',
          ),
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [bridge, id, store, onCreate, onSettings, onUpdate, provider],
  );
  const stop = useCallback(async () => {
    if (!id) return;
    setStopping(true);
    setError('');
    try {
      await bridge.stopTask(id);
    } catch {
      setError('Could not stop this task. Please try again.');
    } finally {
      setStopping(false);
    }
  }, [bridge, id]);
  const chooseProvider = useCallback(
    async (value: string) => {
      if (!id) {
        try {
          const saved = await bridge.saveSettings({ ...settings, defaultProviderId: value });
          void saved;
        } catch {
          setError('Could not change the default model.');
        }
        return;
      }
      setPickerBusy(true);
      try {
        onUpdate(await bridge.selectProvider(id, value));
      } catch {
        setError('Could not switch models. Stop this task and try again.');
      } finally {
        setPickerBusy(false);
      }
    },
    [bridge, id, settings, onUpdate],
  );
  const pickWorkspace = useCallback(async () => {
    setPickerBusy(true);
    try {
      await onWorkspace();
    } finally {
      setPickerBusy(false);
    }
  }, [onWorkspace]);
  const pickFiles = useCallback(async () => {
    setPickerBusy(true);
    try {
      await onFiles();
    } finally {
      setPickerBusy(false);
    }
  }, [onFiles]);
  const modelSettings = useCallback(() => onSettings('Models'), [onSettings]);
  const messageMenu = useCallback(
    (itemId: string) => {
      if (id) onContextMenu({ kind: 'message', conversationId: id, itemId });
    },
    [id, onContextMenu],
  );
  const fileMenu = useCallback(
    (path: string) => {
      if (id) onContextMenu({ kind: 'file', conversationId: id, path });
    },
    [id, onContextMenu],
  );
  const openSource = useCallback(
    (sourceId: string) => {
      if (!id) return;
      void bridge
        .openSource(id, sourceId)
        .catch(() => setError('Could not open this source. It may no longer be available.'));
    },
    [bridge, id],
  );
  return (
    <div className="task-pane">
      <header className="task-header">
        <div className="task-context">
          {collapsed && (
            <button
              type="button"
              className="icon-button titlebar-sidebar-button"
              aria-label="Expand sidebar"
              onClick={onExpandSidebar}
            >
              ▥
            </button>
          )}
          <div>
            <h1>{conversation?.title ?? 'New task'}</h1>
            <div className="task-subtitle">
              {conversation?.workspace ? (
                <button
                  type="button"
                  className="surface-context-button"
                  title={conversation.workspace}
                  aria-label="Workspace actions"
                  onClick={() => fileMenu(conversation.workspace ?? '')}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    fileMenu(conversation.workspace ?? '');
                  }}
                >
                  ▤ {conversation.workspace.split('/').filter(Boolean).pop()}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-button"
                  disabled={active || pickerBusy}
                  onClick={() => void pickWorkspace()}
                >
                  Choose workspace
                </button>
              )}
              <span
                className={`execution-status ${active ? 'active' : ''} ${conversation?.state === 'failed' ? 'failed' : ''}`}
                role="status"
                data-testid="execution-status"
              >
                <span />
                {statusLabel(conversation?.state ?? 'idle')}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="header-model"
          onClick={() => onSettings('Models')}
          title="Manage model providers"
        >
          <span>◇</span>
          {provider?.displayName ?? 'Connect a model'}
        </button>
      </header>
      {id && !conversation ? (
        <div className="loading-state" role="status">
          Restoring conversation…
        </div>
      ) : conversation?.timeline.length ||
        active ||
        conversation?.pendingPermission ||
        conversation?.sources?.length ||
        conversation?.actionPlans?.length ||
        conversation?.researchPlans?.length ? (
        <Timeline
          items={conversation?.timeline ?? []}
          streamingText={conversation?.streamingText ?? ''}
          pending={conversation?.pendingPermission}
          onDecide={decide}
          state={conversation?.state ?? 'idle'}
          onMessageMenu={messageMenu}
          onFileMenu={fileMenu}
          sources={conversation?.sources}
          actionPlans={conversation?.actionPlans}
          researchPlans={conversation?.researchPlans}
          onOpenSource={openSource}
        />
      ) : (
        <Welcome />
      )}
      <div className="composer-region">
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        {conversation?.attachments.length ? (
          <section className="attachments" aria-label="Attached files">
            {conversation.attachments.map((path) => (
              <button
                type="button"
                className="attachment-menu"
                key={path}
                title={path}
                aria-label={`File actions for ${path.split('/').pop()}`}
                onClick={() => fileMenu(path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  fileMenu(path);
                }}
              >
                ▤ {path.split('/').pop()}
              </button>
            ))}
          </section>
        ) : null}
        <Composer
          composerRef={composerRef}
          drafts={drafts}
          draftKey={id ?? 'welcome'}
          active={active}
          busy={sending || pickerBusy || !!(id && !conversation)}
          stopping={stopping}
          providerId={providerId}
          providers={providers}
          onSend={send}
          onStop={stop}
          onWorkspace={pickWorkspace}
          onFiles={pickFiles}
          onScopes={onScopes}
          onProvider={chooseProvider}
          onSettings={modelSettings}
        />
        <p className="composer-footnote">
          <button
            type="button"
            className="text-button"
            onClick={() => onSettings(webSetup.tab)}
            title="Configure Web Search and model tool calling"
          >
            {webSetup.label}
          </button>{' '}
          · Prospero can make mistakes. Review file changes and commands before approving.
        </p>
      </div>
    </div>
  );
}
const Welcome = memo(function Welcome() {
  return (
    <section className="welcome">
      <div className="welcome-heading">
        <Mark />
        <h2>What would you like to do?</h2>
        <p>A little clarity. A task taken care of.</p>
      </div>
    </section>
  );
});
const Composer = memo(function Composer({
  composerRef,
  drafts,
  draftKey,
  active,
  busy,
  stopping,
  providerId,
  providers,
  onSend,
  onStop,
  onWorkspace,
  onFiles,
  onScopes,
  onProvider,
  onSettings,
}: {
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  drafts: ComposerDrafts;
  draftKey: string;
  active: boolean;
  busy: boolean;
  stopping: boolean;
  providerId: string;
  providers: ProviderConfig[];
  onSend: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onWorkspace: () => Promise<void>;
  onFiles: () => Promise<void>;
  onScopes: () => void;
  onProvider: (id: string) => Promise<void>;
  onSettings: () => void;
}) {
  const subscribeDraft = useCallback(
    (listener: () => void) => drafts.subscribe(draftKey, listener),
    [drafts, draftKey],
  );
  const draftSnapshot = useCallback(() => drafts.get(draftKey), [drafts, draftKey]);
  const text = useSyncExternalStore(subscribeDraft, draftSnapshot);
  async function submit() {
    if (!text.trim() || active || busy) return;
    const current = text;
    if (await onSend(current)) drafts.clearSubmitted(draftKey, current);
  }
  useEffect(() => {
    const el = composerRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(180, Math.max(58, el.scrollHeight))}px`;
    }
  }, [composerRef, text]);
  return (
    <form
      className={`composer ${active ? 'is-active' : ''}`}
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={composerRef}
        aria-label="Message Prospero"
        placeholder={
          active
            ? 'Task running — you can prepare your next message'
            : 'Ask Prospero to do something…'
        }
        value={text}
        onChange={(event) => drafts.set(draftKey, event.target.value)}
        rows={2}
        maxLength={100000}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            type="button"
            className="icon-button"
            title="Attach workspace"
            aria-label="Attach workspace"
            disabled={active || busy}
            onClick={() => void onWorkspace()}
          >
            ▤
          </button>
          <button
            type="button"
            className="icon-button"
            title="Attach files"
            aria-label="Attach files"
            disabled={active || busy}
            onClick={() => void onFiles()}
          >
            ＋
          </button>
          <span className="toolbar-divider" />
          <button
            type="button"
            className="text-button scope-control"
            aria-label="File scopes"
            disabled={active || busy}
            onClick={onScopes}
          >
            File access
          </button>
          {providers.length ? (
            <select
              className="model-selector"
              aria-label="Model provider"
              disabled={active || busy}
              value={providerId}
              onChange={(event) => void onProvider(event.target.value)}
            >
              <option value="" disabled>
                Choose a model
              </option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.model} · {provider.displayName}
                </option>
              ))}
            </select>
          ) : (
            <button type="button" className="text-button" onClick={onSettings}>
              ◇ Add a model
            </button>
          )}
        </div>
        {active ? (
          <button
            className="stop-button"
            type="button"
            aria-label="Stop task"
            disabled={stopping}
            onClick={() => void onStop()}
          >
            <span>■</span>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="Send task"
            disabled={busy || !text.trim()}
          >
            <span>{busy ? '…' : '↑'}</span>
          </button>
        )}
      </div>
    </form>
  );
});
