import { useEffect, useState } from 'react';
import type {
  DesktopBridge,
  ProviderConfig,
  ProviderInput,
  Settings as SettingsValue,
  WebSearchConfig,
  WebSearchInput,
  WebSearchProvider,
} from '../bridge';
import { Mark } from './Timeline';
import { friendlyError } from './friendly-error';
import { useDialogFocus } from './dialog-focus';
export type SettingsTab = 'General' | 'Models' | 'Web Search' | 'Permissions' | 'Memory' | 'About';
const tabs: SettingsTab[] = ['General', 'Models', 'Web Search', 'Permissions', 'Memory', 'About'];
const blankProvider: ProviderInput = {
  displayName: '',
  baseUrl: 'https://api.example.com/v1',
  model: '',
  apiKey: '',
  timeoutMs: 60000,
  supportsTools: true,
};
export function Settings({
  bridge,
  initialTab,
  settings,
  providers,
  version,
  onSettings,
  onProviders,
  webSearch,
  onWebSearch,
  onClose,
}: {
  bridge: DesktopBridge;
  initialTab: SettingsTab;
  settings: SettingsValue;
  providers: ProviderConfig[];
  version: string;
  onSettings: (settings: SettingsValue) => void;
  onProviders: (providers: ProviderConfig[]) => void;
  webSearch?: WebSearchConfig;
  onWebSearch: (webSearch: WebSearchConfig) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { ref: dialog, trap } = useDialogFocus();
  useEffect(() => {
    setTab(initialTab);
    setError('');
  }, [initialTab]);
  async function save(value: SettingsValue) {
    setBusy(true);
    setError('');
    try {
      onSettings(await bridge.saveSettings(value));
      return true;
    } catch {
      setError('Could not save settings. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={dialog}
        onKeyDown={trap}
      >
        <aside className="settings-nav">
          <div className="settings-title">
            <Mark small />
            <strong>Settings</strong>
          </div>
          <nav aria-label="Settings sections">
            {tabs.map((value) => (
              <button
                type="button"
                key={value}
                className={tab === value ? 'selected' : ''}
                aria-current={tab === value ? 'page' : undefined}
                onClick={() => {
                  setTab(value);
                  setError('');
                }}
              >
                {value}
              </button>
            ))}
          </nav>
          <div className="settings-version">Prospero {version}</div>
        </aside>
        <div className="settings-main">
          <header className="settings-heading">
            <h2>{tab}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close settings"
              onClick={onClose}
            >
              ×
            </button>
          </header>
          <div className="settings-content">
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            {tab === 'General' && (
              <>
                <p className="section-description">Make Prospero feel at home on your computer.</p>
                <div className="setting-row">
                  <div>
                    <strong>Appearance</strong>
                    <p>Choose a theme, or follow your system.</p>
                  </div>
                  <select
                    aria-label="Appearance"
                    disabled={busy}
                    value={settings.theme}
                    onChange={(event) =>
                      void save({
                        ...settings,
                        theme: event.target.value as SettingsValue['theme'],
                      })
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Default model</strong>
                    <p>Used for new conversations.</p>
                  </div>
                  <select
                    aria-label="Default provider"
                    disabled={busy}
                    value={settings.defaultProviderId ?? ''}
                    onChange={(event) =>
                      void save({ ...settings, defaultProviderId: event.target.value || undefined })
                    }
                  >
                    <option value="">Choose a provider</option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName} · {provider.model}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="shortcut-list">
                  <strong>Keyboard shortcuts</strong>
                  <div>
                    <span>New task</span>
                    <kbd>⌘ N</kbd>
                  </div>
                  <div>
                    <span>Command palette</span>
                    <kbd>⌘ K</kbd>
                  </div>
                  <div>
                    <span>Search tasks</span>
                    <kbd>⌘ F</kbd>
                  </div>
                  <div>
                    <span>Toggle sidebar</span>
                    <kbd>⌘ \</kbd>
                  </div>
                  <div>
                    <span>Close window</span>
                    <kbd>⌘ W</kbd>
                  </div>
                  <div>
                    <span>Settings</span>
                    <kbd>⌘ ,</kbd>
                  </div>
                  <div>
                    <span>Send task</span>
                    <kbd>⌘ ↵</kbd>
                  </div>
                  <div>
                    <span>Stop task / close dialog</span>
                    <kbd>Esc</kbd>
                  </div>
                </div>
              </>
            )}
            {tab === 'Models' && (
              <ProviderSettings
                bridge={bridge}
                providers={providers}
                settings={settings}
                onProviders={onProviders}
                onSettings={onSettings}
              />
            )}
            {tab === 'Web Search' && (
              <WebSearchSettings bridge={bridge} config={webSearch} onSave={onWebSearch} />
            )}
            {tab === 'Permissions' && (
              <>
                <p className="section-description">
                  You stay in control of actions on this computer.
                </p>
                <label className="setting-row checkbox-row">
                  <div>
                    <strong>Ask before reading files</strong>
                    <p>Require approval for read, list, and search tools.</p>
                  </div>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={settings.askBeforeReads}
                    onChange={(event) =>
                      void save({ ...settings, askBeforeReads: event.target.checked })
                    }
                  />
                </label>
                <div className="policy-card">
                  <span className="tool-symbol">✓</span>
                  <div>
                    <strong>File changes and shell commands always ask</strong>
                    <p>
                      Review the full file preview, Action Plan, or command before approving. A
                      batch approval covers only its immutable plan. Session approval is available
                      only for reads when the host permits it.
                    </p>
                  </div>
                </div>
                <p className="muted">
                  Session permissions are cleared when the app restarts. File tools remain inside
                  your explicitly selected file scopes.
                </p>
              </>
            )}
            {tab === 'Memory' && (
              <MemorySettings
                entries={settings.memory}
                busy={busy}
                onSave={(memory) => save({ ...settings, memory })}
              />
            )}
            {tab === 'About' && (
              <div className="about">
                <Mark />
                <h3>Prospero</h3>
                <p>A personal agent for the work on your computer.</p>
                <span className="badge">Version {version}</span>
                <div className="about-details">
                  <p>
                    Conversations and personal context stay on this computer. Your configured model
                    provider receives the context required to complete each task.
                  </p>
                  <p>OpenAI-compatible Chat Completions · Local tools · Explicit permissions</p>
                  <p>Repository: Prospero (local checkout; remote not configured).</p>
                  <p>Electron host · Isolated React UI · Local SQLite persistence.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WebSearchSettings({
  bridge,
  config,
  onSave,
}: {
  bridge: DesktopBridge;
  config?: WebSearchConfig;
  onSave: (config: WebSearchConfig) => void;
}) {
  const [provider, setProvider] = useState<WebSearchProvider>(config?.provider ?? 'brave');
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [retention, setRetention] = useState<WebSearchConfig['retention']>(
    config?.retention ?? 'session',
  );
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [testing, setTesting] = useState(false);
  const providerName = provider === 'tavily' ? 'Tavily' : 'Brave Search';
  const hasStoredKey = config?.provider === provider && !!config?.hasApiKey;
  const canTest = apiKey ? /^[\x21-\x7e]{8,4096}$/.test(apiKey) : hasStoredKey;
  useEffect(() => {
    setProvider(config?.provider ?? 'brave');
    setEnabled(config?.enabled ?? false);
    setRetention(config?.retention ?? 'session');
  }, [config]);
  async function save(clearApiKey = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    const input: WebSearchInput = {
      provider,
      enabled: clearApiKey ? false : enabled,
      retention,
      ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}),
    };
    try {
      onSave(await bridge.saveWebSearch(input));
      setApiKey('');
      setConfirmRemoval(false);
      setMessage(
        clearApiKey ? 'Search key removed. Web search is disabled.' : 'Web Search settings saved.',
      );
    } catch (error) {
      setError(
        friendlyError(
          error,
          'Could not save Web Search settings. Check the key and OS credential storage.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function testConnection() {
    if (busy || !canTest) return;
    setBusy(true);
    setTesting(true);
    setError('');
    setMessage('');
    try {
      const result = await bridge.testWebSearch({ provider, ...(apiKey ? { apiKey } : {}) });
      const messages = {
        connected: `Connected to ${providerName}. The test used one search request.`,
        auth: `The search credential was rejected. Enter or replace the ${providerName} key.`,
        'rate-limit': `${providerName} rate limit reached. Wait before testing again.`,
        server: `${providerName} is temporarily unavailable. Try again later.`,
        incompatible: `${providerName} returned an incompatible response.`,
        network: `Could not connect securely to ${providerName}. Check the connection and try again.`,
        timeout: `The ${providerName} connection test timed out.`,
        cancelled: `The ${providerName} connection test was cancelled.`,
      };
      if (result.status === 'connected') setMessage(messages.connected);
      else
        setError(
          friendlyError(
            new Error(result.message),
            messages[result.status] ?? `Could not test the ${providerName} connection.`,
          ),
        );
    } catch (error) {
      setError(
        friendlyError(
          error,
          'Could not test Web Search. Check the key, connection, and OS credential storage.',
        ),
      );
    } finally {
      setBusy(false);
      setTesting(false);
    }
  }
  return (
    <form
      className="web-search-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="section-description">
        Search the public web with {providerName}. Saving settings does not make a search request.
      </p>
      <label className="setting-row checkbox-row">
        <div>
          <strong>Enable Web Search</strong>
          <p>
            Search queries are sent to {providerName}. Local file access requires separate approval.
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Enable Web Search"
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <div className="search-provider-row">
        <label>
          Search provider
          <select
            aria-label="Search provider"
            value={provider}
            disabled={busy}
            onChange={(event) => {
              setProvider(event.target.value as WebSearchProvider);
              setApiKey('');
              setMessage('');
              setError('');
              setConfirmRemoval(false);
            }}
          >
            <option value="brave">Brave Search</option>
            <option value="tavily">Tavily</option>
          </select>
        </label>
        <span className="badge">{hasStoredKey ? 'Key stored securely' : 'No key stored'}</span>
      </div>
      <label className="web-key-field">
        Search API key
        <input
          type="password"
          aria-label="Search API key"
          autoComplete="new-password"
          maxLength={4096}
          disabled={busy}
          value={apiKey}
          placeholder={
            hasStoredKey ? 'Leave blank to keep stored key' : `Enter a ${providerName} key`
          }
          onChange={(event) => {
            setApiKey(event.target.value);
            setMessage('');
            setError('');
          }}
        />
        <span className="field-hint">
          The stored key is never returned or shown. Authentication stays in the main process and
          uses the macOS credential store.
        </span>
      </label>
      <label className="setting-row">
        <div>
          <strong>Source retention</strong>
          <p>Choose how long source metadata and short excerpts remain available.</p>
        </div>
        <select
          aria-label="Source retention"
          disabled={busy}
          value={retention}
          onChange={(event) => setRetention(event.target.value as WebSearchConfig['retention'])}
        >
          <option value="session">This session</option>
          <option value="sources">7 days</option>
        </select>
      </label>
      <p className="muted">
        Full page text is temporary and is not saved. A retrieved source is external evidence, never
        an instruction or permission.
      </p>
      <p className="field-hint">
        {`Testing sends the fixed query “Prospero web search” once for one result and may use your ${providerName} API quota. It does not save the key, settings, or sources.`}
      </p>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="inline-success">
          {message}
        </div>
      )}
      <div className="form-actions">
        {hasStoredKey && (
          <button
            type="button"
            className="text-button danger-text"
            disabled={busy}
            onClick={() => setConfirmRemoval(true)}
          >
            Remove search key
          </button>
        )}
        <button type="button" disabled={busy || !canTest} onClick={() => void testConnection()}>
          {testing ? 'Testing…' : 'Test search connection'}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || (enabled && !hasStoredKey && !apiKey.trim())}
        >
          {busy && !testing ? 'Saving…' : 'Save Web Search'}
        </button>
      </div>
      {confirmRemoval && (
        <div className="delete-confirm">
          <span>Remove the stored {providerName} key?</span>
          <button type="button" disabled={busy} onClick={() => setConfirmRemoval(false)}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void save(true)}>
            Remove key
          </button>
        </div>
      )}
    </form>
  );
}
function ProviderSettings({
  bridge,
  providers,
  settings,
  onProviders,
  onSettings,
}: {
  bridge: DesktopBridge;
  providers: ProviderConfig[];
  settings: SettingsValue;
  onProviders: (providers: ProviderConfig[]) => void;
  onSettings: (settings: SettingsValue) => void;
}) {
  const [draft, setDraft] = useState<ProviderInput | undefined>();
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string>();
  function edit(provider?: ProviderConfig) {
    setDraft(
      provider
        ? {
            id: provider.id,
            displayName: provider.displayName,
            baseUrl: provider.baseUrl,
            model: provider.model,
            apiKey: '',
            timeoutMs: provider.timeoutMs,
            supportsTools: provider.supportsTools,
          }
        : { ...blankProvider },
    );
    setStored(!!provider?.hasApiKey);
    setMessage('');
    setError('');
    setDeleting(undefined);
  }
  const valid = !!draft?.displayName.trim() && !!draft?.baseUrl.trim() && !!draft?.model.trim();
  async function submit() {
    if (!draft || !valid) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const provider = await bridge.saveProvider({ ...draft, apiKey: draft.apiKey || undefined });
      onProviders([...providers.filter((value) => value.id !== provider.id), provider]);
      setDraft(undefined);
    } catch (error) {
      setError(
        friendlyError(
          error,
          'Could not save this provider. Check the URL, required fields, and OS credential storage.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    if (!draft || !valid) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await bridge.testProvider({ ...draft, apiKey: draft.apiKey || undefined });
      if (result.status === 'connected') setMessage(result.message || 'Connected');
      else setError(result.message || 'Connection failed. Check your provider settings.');
    } catch (error) {
      setError(friendlyError(error, 'Could not connect. Check the endpoint and try again.'));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await bridge.deleteProvider(id);
      const refreshed = await bridge.bootstrap();
      onProviders(refreshed.providers);
      onSettings(refreshed.settings);
      setDeleting(undefined);
    } catch {
      setError('Could not delete this provider. Stop its active tasks first.');
    } finally {
      setBusy(false);
    }
  }
  async function makeDefault(id: string) {
    setBusy(true);
    setError('');
    try {
      onSettings(await bridge.saveSettings({ ...settings, defaultProviderId: id }));
    } catch {
      setError('Could not change the default provider.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="section-description">
        Connect any OpenAI-compatible API. Keys are stored securely on this computer.
      </p>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="inline-success">
          {message}
        </div>
      )}
      {!draft && (
        <>
          <div className="section-actions">
            <strong>Your providers</strong>
            <button type="button" onClick={() => edit()} className="small-button">
              + Add provider
            </button>
          </div>
          <div className="provider-list" data-testid="provider-list">
            {providers.length === 0 && (
              <div className="settings-empty">
                <span className="empty-symbol">◇</span>
                <strong>No providers yet</strong>
                <p>Add a provider to start your first task.</p>
                <button type="button" className="primary" onClick={() => edit()}>
                  Add provider
                </button>
              </div>
            )}
            {providers.map((provider) => (
              <article className="provider-card" key={provider.id}>
                <div className="provider-top">
                  <span className="provider-icon">◇</span>
                  <div>
                    <strong>{provider.displayName}</strong>
                    <span>{provider.model}</span>
                  </div>
                  {settings.defaultProviderId === provider.id && (
                    <span className="badge">Default</span>
                  )}
                  <button
                    type="button"
                    className="small-button"
                    aria-label={`Edit ${provider.displayName}`}
                    onClick={() => edit(provider)}
                  >
                    Edit
                  </button>
                </div>
                <div className="provider-url">{provider.baseUrl}</div>
                <div className="provider-footer">
                  <span>
                    {provider.hasApiKey ? '•••••••• · Key stored securely' : 'No API key stored'}
                  </span>
                  <div>
                    {settings.defaultProviderId !== provider.id && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void makeDefault(provider.id)}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button danger-text"
                      disabled={busy}
                      onClick={() => setDeleting(provider.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {deleting === provider.id && (
                  <div className="delete-confirm">
                    <span>Remove this provider? Saved conversations will remain.</span>
                    <button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void remove(provider.id)}
                    >
                      Delete provider
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {draft && (
        <form
          className="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="form-heading">
            <strong>{draft.id ? 'Edit provider' : 'Add provider'}</strong>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setError('');
                setMessage('');
              }}
            >
              Cancel
            </button>
          </div>
          <label>
            Provider name
            <input
              aria-label="Provider name"
              maxLength={80}
              required
              value={draft.displayName}
              placeholder="My provider"
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              aria-label="Base URL"
              maxLength={2048}
              required
              type="url"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            <span className="field-hint">The API root for a Chat Completions endpoint.</span>
          </label>
          <label>
            API key
            <input
              aria-label="API key"
              maxLength={8192}
              type="password"
              autoComplete="new-password"
              value={draft.apiKey ?? ''}
              placeholder={
                stored
                  ? '•••••••• · Leave blank to keep stored key'
                  : 'Enter API key (optional for local endpoints)'
              }
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <span className="field-hint">A stored key is never shown again.</span>
          </label>
          <label>
            Model
            <input
              aria-label="Model"
              maxLength={200}
              required
              value={draft.model}
              placeholder="example-model"
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={draft.supportsTools ?? true}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, supportsTools: event.target.checked })}
            />
            This model supports tool calling
          </label>
          <div className="form-actions">
            <button type="button" disabled={!valid || busy} onClick={() => void test()}>
              {busy ? 'Working…' : 'Test connection'}
            </button>
            <button className="primary" type="submit" disabled={!valid || busy}>
              {busy ? 'Working…' : 'Save provider'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
function MemorySettings({
  entries,
  busy,
  onSave,
}: {
  entries: SettingsValue['memory'];
  busy: boolean;
  onSave: (entries: SettingsValue['memory']) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string>();
  async function submit() {
    if (!text.trim()) return;
    const id = editing ?? crypto.randomUUID();
    const saved = await onSave(
      editing
        ? entries.map((entry) => (entry.id === id ? { id, text: text.trim() } : entry))
        : [...entries, { id, text: text.trim() }],
    );
    if (saved) {
      setText('');
      setEditing(undefined);
    }
  }
  return (
    <>
      <p className="section-description">
        Personal context you explicitly choose to share with your agent. Prospero never adds
        memories silently.
      </p>
      <div className="memory-list">
        {entries.length === 0 && (
          <div className="memory-empty">
            No saved memories. Add a preference or a useful detail below.
          </div>
        )}
        {entries.map((entry) => (
          <article className="memory-card" key={entry.id}>
            <div className="memory-entry-text">
              <p>{entry.text}</p>
              <span className="memory-source">Saved by you</span>
            </div>
            <div>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                aria-label="Edit memory"
                onClick={() => {
                  setEditing(entry.id);
                  setText(entry.text);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-button danger-text"
                aria-label="Delete memory"
                disabled={busy}
                onClick={() => void onSave(entries.filter((value) => value.id !== entry.id))}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="memory-text">{editing ? 'Edit memory' : 'Add a memory'}</label>
        <textarea
          id="memory-text"
          aria-label="Memory text"
          rows={3}
          maxLength={4000}
          disabled={busy}
          value={text}
          placeholder="For example: I prefer concise answers and metric units."
          onChange={(event) => setText(event.target.value)}
        />
        <div className="form-actions">
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(undefined);
                setText('');
              }}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="primary"
            disabled={busy || !text.trim() || (!editing && entries.length >= 50)}
          >
            {busy ? 'Saving…' : editing ? 'Save memory' : 'Add memory'}
          </button>
        </div>
      </form>
    </>
  );
}
