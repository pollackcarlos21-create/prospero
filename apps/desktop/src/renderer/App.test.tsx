import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type {
  ActionPlan,
  PermissionDecision,
  PermissionRequest,
  SourceRecord,
  ResearchPlan,
} from '@prospero/core';
import type {
  Bootstrap,
  ConnectionResult,
  ContextMenuTarget,
  Conversation,
  DesktopBridge,
  DesktopEvent,
  ProviderInput,
  Settings,
  WebSearchInput,
  WebSearchTestInput,
} from '../bridge';

const dom = new Window({ url: 'http://localhost' });
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLTextAreaElement',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? dom : dom[name],
  });
}
Object.defineProperty(globalThis, 'getComputedStyle', {
  configurable: true,
  value: dom.getComputedStyle.bind(dom),
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import(
  '@testing-library/react'
);
const { App } = await import('./App');
const provider = {
  id: 'provider-1',
  displayName: 'Local model',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'test-model',
  timeoutMs: 60000,
  supportsTools: true,
  hasApiKey: true,
};
function conversation(id = 'task-1'): Conversation {
  return {
    id,
    title: 'New task',
    updatedAt: Date.now(),
    state: 'idle',
    providerId: provider.id,
    timeline: [],
    messages: [],
    attachments: [],
    streamingText: '',
  };
}
function permission(allowSession = false): PermissionRequest {
  return {
    requestId: 'request-1',
    call: { id: 'call-1', name: 'write_file', arguments: '{}' },
    preview: {
      kind: 'write',
      title: 'Update notes.md',
      path: '/workspace/notes.md',
      diff: '--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-before\n+after\n',
    },
    permissionKey: 'write:notes',
    allowSession,
  };
}
class FakeBridge implements DesktopBridge {
  listeners = new Set<(event: DesktopEvent) => void>();
  data: Bootstrap = {
    conversations: [],
    providers: [provider],
    settings: { theme: 'light', askBeforeReads: false, memory: [], defaultProviderId: provider.id },
    version: '0.2.0',
    webSearch: { provider: 'brave', enabled: false, hasApiKey: false, retention: 'session' },
  };
  conversations = new Map<string, Conversation>();
  count = 0;
  ready = mock(async () => {});
  renameConversation = mock(async (id: string, title: string) => this.update(id, { title }));
  showContextMenu = mock(async (_target: ContextMenuTarget) => {});
  copyText = mock(async (_text: string) => {});
  bootstrap = mock(async () => structuredClone(this.data));
  createConversation = mock(async () => {
    const value = conversation(`task-${++this.count}`);
    this.conversations.set(value.id, value);
    this.data.conversations.unshift(value);
    return structuredClone(value);
  });
  getConversation = mock(async (id: string) => {
    const value = this.conversations.get(id);
    if (!value) throw new Error('Missing');
    return structuredClone(value);
  });
  deleteConversation = mock(async (id: string) => {
    this.conversations.delete(id);
  });
  selectProvider = mock(async (id: string, providerId: string) => this.update(id, { providerId }));
  chooseWorkspace = mock(async (id: string) => this.update(id, { workspace: '/workspace' }));
  attachFiles = mock(async (id: string) =>
    this.update(id, { attachments: ['/workspace/notes.md'] }),
  );
  addScope = mock(async (id: string, mode: 'read' | 'write') =>
    this.update(id, {
      scopes: [
        ...(this.requireConversation(id).scopes ?? []),
        {
          id: `scope-${mode}`,
          path: mode === 'read' ? '/research' : '/organized',
          label: mode === 'read' ? 'Research' : 'Organized',
          kind: 'directory',
          mode,
        },
      ],
    }),
  );
  removeScope = mock(async (id: string, scopeId: string) =>
    this.update(id, {
      scopes: this.requireConversation(id).scopes?.filter((scope) => scope.id !== scopeId),
    }),
  );
  openSource = mock(async (_id: string, _sourceId: string) => {});
  saveWebSearch = mock(async (input: WebSearchInput) => {
    const selectedProvider = input.provider ?? this.data.webSearch?.provider ?? 'brave';
    const value = {
      provider: selectedProvider,
      enabled: input.enabled,
      retention: input.retention,
      hasApiKey: input.clearApiKey
        ? false
        : !!input.apiKey ||
          (this.data.webSearch?.provider === selectedProvider && !!this.data.webSearch.hasApiKey),
    };
    this.data.webSearch = value;
    this.emit({ type: 'bootstrap', data: this.data });
    return value;
  });
  testWebSearch = mock(
    async (_input: WebSearchTestInput): Promise<ConnectionResult> => ({
      status: 'connected',
      message: 'Connected to Brave Search.',
    }),
  );
  sendTask = mock(async (id: string, text: string) => {
    const value = this.requireConversation(id);
    this.update(id, {
      title: text,
      state: 'model-request',
      messages: [{ role: 'user', content: text }],
      timeline: [
        ...value.timeline,
        { id: 'user-1', at: Date.now(), type: 'message', message: { role: 'user', content: text } },
      ],
    });
  });
  stopTask = mock(async (id: string) => {
    this.update(id, { state: 'cancelled', streamingText: '' });
  });
  decidePermission = mock(async (id: string, requestId: string, decision: PermissionDecision) => {
    const value = this.requireConversation(id);
    this.update(id, {
      state: 'model-continuation',
      pendingPermission: undefined,
      timeline: value.timeline.map((item) =>
        item.request?.requestId === requestId ? { ...item, decision } : item,
      ),
    });
  });
  decideActionPlan = mock(
    async (id: string, requestId: string, _digest: string, decision: 'allow-once' | 'deny') => {
      const value = this.requireConversation(id);
      this.update(id, {
        state: 'model-continuation',
        pendingPermission: undefined,
        timeline: value.timeline.map((item) =>
          item.request?.requestId === requestId ? { ...item, decision } : item,
        ),
      });
    },
  );
  decideResearch = mock(
    async (id: string, requestId: string, _digest: string, decision: 'allow-once' | 'deny') => {
      const value = this.requireConversation(id);
      this.update(id, {
        state: 'model-continuation',
        pendingPermission: undefined,
        timeline: value.timeline.map((item) =>
          item.request?.requestId === requestId ? { ...item, decision } : item,
        ),
      });
    },
  );
  saveProvider = mock(async (input: ProviderInput) => {
    const value = {
      ...provider,
      id: input.id ?? 'provider-2',
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      model: input.model,
      hasApiKey: !!input.apiKey,
    };
    this.data.providers = [...this.data.providers.filter((item) => item.id !== value.id), value];
    this.emit({ type: 'bootstrap', data: this.data });
    return value;
  });
  deleteProvider = mock(async (id: string) => {
    this.data.providers = this.data.providers.filter((value) => value.id !== id);
  });
  testProvider = mock(async (_input: ProviderInput) => ({
    status: 'connected' as const,
    message: 'Connected',
  }));
  saveSettings = mock(async (settings: Settings) => {
    this.data.settings = settings;
    this.emit({ type: 'bootstrap', data: this.data });
    return settings;
  });
  onEvent = (listener: (event: DesktopEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(event: DesktopEvent) {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
  requireConversation(id: string) {
    const value = this.conversations.get(id);
    if (!value) throw new Error('Missing conversation');
    return value;
  }
  update(id: string, patch: Partial<Conversation>) {
    const value = { ...this.requireConversation(id), ...patch };
    this.conversations.set(id, value);
    this.emit({ type: 'conversation', conversation: value });
    return structuredClone(value);
  }
  restore(value: Conversation) {
    this.conversations.set(value.id, value);
    this.data.conversations = [value];
  }
}
afterEach(() => {
  cleanup();
});
async function mount(bridge = new FakeBridge()) {
  render(<App bridge={bridge} />);
  await screen.findByTestId('composer');
  return bridge;
}
async function newTask(bridge = new FakeBridge()) {
  await mount(bridge);
  fireEvent.click(screen.getByRole('button', { name: 'New task' }));
  await waitFor(() => expect(bridge.createConversation).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open New task' })).toBeTruthy());
  return bridge;
}
async function send(text = 'Inspect these files') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
  await screen.findByRole('button', { name: 'Stop task' });
}
async function showPermission(bridge: FakeBridge, allowSession = false) {
  const request = permission(allowSession);
  await act(async () => {
    bridge.update('task-1', {
      state: 'waiting-permission',
      pendingPermission: request,
      timeline: [{ id: 'permission-1', at: Date.now(), type: 'permission', request }],
    });
  });
  await screen.findByTestId('permission-card');
  return request;
}
describe('desktop renderer with typed bridge', () => {
  test('welcomes a fresh user and creates a real conversation', async () => {
    const bridge = await mount();
    expect(screen.getByText('What would you like to do?')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    await waitFor(() => expect(bridge.createConversation).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Open New task' });
  });
  test('welcome keeps advanced tools out of the empty content flow', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /Understand a workspace/ })).toBeNull();
    expect(screen.getByText('What would you like to do?')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message Prospero' })).toBeTruthy();
  });
  test('sends user text, streams snapshots and stops a task', async () => {
    const bridge = await newTask();
    await send();
    expect(bridge.sendTask).toHaveBeenCalledWith('task-1', 'Inspect these files');
    await act(async () => {
      bridge.update('task-1', { streamingText: 'I will inspect the workspace.' });
    });
    expect(await screen.findByTestId('streaming-text')).toBeTruthy();
    expect(screen.getByText('I will inspect the workspace.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(bridge.stopTask).toHaveBeenCalledWith('task-1'));
    await waitFor(() =>
      expect(screen.getByTestId('execution-status').textContent).toContain('Stopped'),
    );
  });
  test('renders tool output, errors and exit status', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', {
        state: 'completed',
        timeline: [
          {
            id: 'user-1',
            at: Date.now(),
            type: 'message',
            message: { role: 'user', content: 'Run a check' },
          },
          {
            id: 'tool-1',
            at: Date.now(),
            type: 'tool',
            call: { id: 'call', name: 'shell', arguments: '{}' },
            preview: {
              kind: 'shell',
              title: 'Run check',
              command: 'printf hello',
              cwd: '/workspace',
            },
            result: { content: 'hello', exitCode: 0 },
            durationMs: 15,
          },
        ],
      });
    });
    const card = await screen.findByTestId('tool-card');
    expect(within(card).getByText('Done')).toBeTruthy();
    fireEvent.click(within(card).getByText('Run check'));
    expect(within(card).getByText('hello')).toBeTruthy();
    expect(within(card).getByText('Exit code: 0')).toBeTruthy();
  });
  for (const [label, decision] of [
    ['Allow once', 'allow-once'],
    ['Allow for this session', 'allow-session'],
    ['Deny', 'deny'],
  ] as const)
    test(`permission decision: ${decision}`, async () => {
      const bridge = await newTask();
      await showPermission(bridge, true);
      expect(screen.getByRole('region', { name: 'File change diff' })).toBeTruthy();
      expect(screen.getByText('before')).toBeTruthy();
      expect(screen.getByText('after')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() =>
        expect(bridge.decidePermission).toHaveBeenCalledWith('task-1', 'request-1', decision),
      );
    });
  test('does not offer session approval when host disallows it', async () => {
    const bridge = await newTask();
    await showPermission(bridge);
    expect(screen.queryByRole('button', { name: 'Allow for this session' })).toBeNull();
  });
  test('missing provider opens model settings without sending', async () => {
    const bridge = new FakeBridge();
    bridge.data.providers = [];
    bridge.data.settings.defaultProviderId = undefined;
    await newTask(bridge);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByText('No providers yet')).toBeTruthy();
    expect(bridge.sendTask).not.toHaveBeenCalled();
  });
  test('attaches workspace and files through the bridge', async () => {
    const bridge = await newTask();
    fireEvent.click(screen.getByRole('button', { name: 'Attach workspace' }));
    await waitFor(() => expect(bridge.chooseWorkspace).toHaveBeenCalledWith('task-1'));
    await screen.findByTitle('/workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    await waitFor(() => expect(bridge.attachFiles).toHaveBeenCalledWith('task-1'));
    await screen.findByTitle('/workspace/notes.md');
  });
  test('restores a saved conversation and searches the sidebar', async () => {
    const bridge = new FakeBridge();
    bridge.restore({
      ...conversation(),
      title: 'Saved research',
      state: 'completed',
      timeline: [
        {
          id: 'saved',
          at: Date.now(),
          type: 'message',
          message: { role: 'assistant', content: 'Your saved answer.' },
        },
      ],
    });
    await mount(bridge);
    expect(await screen.findByText('Your saved answer.')).toBeTruthy();
    expect(bridge.getConversation).toHaveBeenCalledWith('task-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search conversations' }), {
      target: { value: 'unmatched' },
    });
    expect(screen.getByText('No matching tasks')).toBeTruthy();
  });
  test('handles a rejected task without exposing bridge diagnostics', async () => {
    const bridge = await newTask();
    bridge.sendTask.mockRejectedValueOnce(new Error('secret internal transport body'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
    expect(
      await screen.findByText(
        'Could not start this task. Check your model connection and try again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('secret internal transport body')).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
    ).toBe('Hello');
  });
  test('shows safe task failure details from host events', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', {
        state: 'failed',
        timeline: [
          { id: 'u', at: Date.now(), type: 'message', message: { role: 'user', content: 'Hello' } },
          { id: 'e', at: Date.now(), type: 'error', text: 'Provider authentication failed.' },
        ],
      });
    });
    expect(await screen.findByText('Provider authentication failed.')).toBeTruthy();
  });
  test('edits providers with an empty password field and tests connection', async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Local model' }));
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    fireEvent.change(screen.getByLabelText('Provider name'), {
      target: { value: 'Renamed model' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connected');
    expect(bridge.testProvider.mock.calls[0]?.[0].apiKey).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await screen.findByText('Renamed model');
    expect(bridge.saveProvider).toHaveBeenCalled();
  });
  test('settings save themes, read policy and explicit memories', async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Appearance' }), {
      target: { value: 'dark' },
    });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Ask before reading files/ }));
    await waitFor(() => expect(bridge.data.settings.askBeforeReads).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory text' }), {
      target: { value: 'Prefer concise answers.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    await screen.findByText('Prefer concise answers.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory text' }), {
      target: { value: 'Prefer metric units.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    await screen.findByText('Prefer metric units.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
    await waitFor(() => expect(bridge.data.settings.memory).toEqual([]));
  });
  test('macOS shortcuts create, open palette/settings and stop', async () => {
    const bridge = await mount();
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    await waitFor(() => expect(bridge.createConversation).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await screen.findByRole('dialog', { name: 'Command palette' });
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search commands' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'Hello' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      key: 'Enter',
      metaKey: true,
    });
    await screen.findByRole('button', { name: 'Stop task' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(bridge.stopTask).toHaveBeenCalled());
  });
  test('full approved diff remains inspectable past 500 lines', async () => {
    const bridge = await newTask();
    const request = permission();
    request.preview.diff = `--- a/notes.md\n+++ b/notes.md\n@@ -0,0 +1,600 @@\n${Array.from({ length: 600 }, (_, i) => `+change-${i + 1}`).join('\n')}`;
    await act(async () => {
      bridge.update('task-1', {
        state: 'waiting-permission',
        pendingPermission: request,
        timeline: [{ id: 'large-permission', type: 'permission', at: Date.now(), request }],
      });
    });
    expect(await screen.findByText('change-600')).toBeTruthy();
    expect(screen.getByText('600')).toBeTruthy();
  });
  test('stopped undecided approval is never labeled approved', async () => {
    const bridge = await newTask();
    await showPermission(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(bridge.stopTask).toHaveBeenCalled());
    await act(async () => {
      bridge.update('task-1', { pendingPermission: undefined });
    });
    expect(await screen.findByText('Not executed')).toBeTruthy();
    expect(screen.queryByText('Approved by you')).toBeNull();
  });
  test('failed memory saves retain the user draft', async () => {
    const bridge = await mount();
    bridge.saveSettings.mockRejectedValueOnce(new Error('private diagnostics'));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory text' }), {
      target: { value: 'Keep this unsaved preference.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    expect(await screen.findByText('Could not save settings. Please try again.')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Memory text' }) as HTMLTextAreaElement).value,
    ).toBe('Keep this unsaved preference.');
  });
  test('sends directly from the welcome screen without needing New task first', async () => {
    const bridge = await mount();
    await send('My first task');
    expect(bridge.createConversation).toHaveBeenCalledTimes(1);
    expect(bridge.sendTask).toHaveBeenCalledWith('task-1', 'My first task');
  });
  test('workspace picker failures release disabled controls', async () => {
    const bridge = await newTask();
    bridge.chooseWorkspace.mockRejectedValueOnce(new Error('private path error'));
    fireEvent.click(screen.getByRole('button', { name: 'Attach workspace' }));
    expect(
      await screen.findByText('Could not select this workspace. Try a folder you can access.'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Attach workspace' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  test('About identifies the actual repository and desktop architecture', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    expect(
      screen.getByText('Repository: Prospero (local checkout; remote not configured).'),
    ).toBeTruthy();
    expect(
      screen.getByText('Electron host · Isolated React UI · Local SQLite persistence.'),
    ).toBeTruthy();
  });
  for (const message of [
    'A secure OS credential store is required.',
    'The OS credential store is unavailable. Unlock it and try again.',
    'New provider creation is busy. Wait for its secure credential operation to finish.',
  ])
    test(`provider save explains credential storage: ${message}`, async () => {
      const bridge = await mount();
      bridge.saveProvider.mockRejectedValueOnce(
        new Error(`Error invoking remote method: Error: ${message}`),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Models' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit Local model' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    });
  test('unexpected provider-save failures show safe credential guidance', async () => {
    const bridge = await mount();
    bridge.saveProvider.mockRejectedValueOnce(new Error('private credential diagnostic'));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Local model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(
      await screen.findByText(
        'Could not save this provider. Check the URL, required fields, and OS credential storage.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('private credential diagnostic')).toBeNull();
  });
  for (const label of ['Attach workspace', 'Attach files'])
    test(`welcome draft survives ${label}`, async () => {
      const bridge = await mount();
      fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
        target: { value: 'Draft before attaching local context.' },
      });
      fireEvent.click(screen.getByRole('button', { name: label }));
      await screen.findByRole('button', { name: 'Open New task' });
      await waitFor(() =>
        expect(
          (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
        ).toBe('Draft before attaching local context.'),
      );
      expect(bridge.createConversation).toHaveBeenCalledTimes(1);
    });
  test('drafts survive switching conversations and New task starts fresh', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', { title: 'First task' });
    });
    await screen.findByRole('button', { name: 'Open First task' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'First task draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    await screen.findByRole('button', { name: 'Open New task' });
    expect(
      (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
    ).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'Second task draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open First task' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
      ).toBe('First task draft'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open New task' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
      ).toBe('Second task draft'),
    );
  });
  test('a submitted conversation draft stays cleared after switching away and back', async () => {
    const bridge = await newTask();
    await send('Accepted task');
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
      ).toBe(''),
    );
    await act(async () => {
      bridge.update('task-1', { state: 'completed' });
    });
    await waitFor(() =>
      expect(screen.getByTestId('execution-status').textContent).toContain('Completed'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    await screen.findByRole('button', { name: 'Open New task' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Accepted task' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
      ).toBe(''),
    );
  });
  test('a late send acknowledgement preserves a newly typed draft', async () => {
    const bridge = await newTask();
    let acknowledge: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    bridge.sendTask.mockImplementationOnce(async (id, text) => {
      bridge.update(id, {
        title: text,
        state: 'model-request',
        timeline: [
          { id: 'sent', at: Date.now(), type: 'message', message: { role: 'user', content: text } },
        ],
      });
      await pending;
    });
    await send('Accepted task');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'My next unsent task' },
    });
    await act(async () => {
      acknowledge();
      await pending;
    });
    expect(
      (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
    ).toBe('My next unsent task');
  });
  test('explicit New task does not inherit or discard the separate welcome draft', async () => {
    const bridge = await mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'A separate welcome draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    await screen.findByRole('button', { name: 'Open New task' });
    expect(
      (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Delete New task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(bridge.deleteConversation).toHaveBeenCalledWith('task-1'));
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
      ).toBe('A separate welcome draft'),
    );
  });
  test('palette filters tasks, navigates with arrows, executes and restores focus', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', { title: 'Research notes' });
    });
    const composer = screen.getByRole('textbox', { name: 'Message Prospero' });
    composer.focus();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'Research' } });
    expect(
      screen.getByRole('option', { name: /Research notes/ }).getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledWith('task-1'));
    fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true });
    const second = await screen.findByRole('combobox', { name: 'Search commands' });
    fireEvent.change(second, { target: { value: 'zzzzz' } });
    expect(screen.getByText('No matching commands or tasks')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const third = await screen.findByRole('combobox', { name: 'Search commands' });
    fireEvent.keyDown(third, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Search tasks/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(third, { key: 'Enter' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search conversations' }),
    );
  });
  test('Cmd F expands and focuses task search; Cmd backslash toggles sidebar', async () => {
    await mount();
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    expect(document.querySelector('.desktop-app')?.classList.contains('sidebar-collapsed')).toBe(
      true,
    );
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search conversations' }),
    );
    expect(document.querySelector('.desktop-app')?.classList.contains('sidebar-collapsed')).toBe(
      false,
    );
  });
  test('native fullscreen and modified Command keys are not intercepted by app shortcuts', async () => {
    const bridge = await mount();
    const composer = screen.getByRole('textbox', { name: 'Message Prospero' });
    composer.focus();
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    fireEvent.keyDown(window, { key: 'f', metaKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'f', metaKey: true, altKey: true });
    fireEvent.keyDown(window, { key: 'n', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    fireEvent.change(composer, { target: { value: 'Preserve this draft' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true, ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(composer);
    expect(document.querySelector('.desktop-app')?.classList.contains('sidebar-collapsed')).toBe(
      true,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.createConversation).not.toHaveBeenCalled();
    expect(bridge.sendTask).not.toHaveBeenCalled();
  });
  test('macOS primary commands do not treat Ctrl as Command', async () => {
    const bridge = await mount();
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(bridge.createConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  test('native menu actions open a trapped rename sheet and persist its title', async () => {
    const bridge = await newTask();
    const invoker = screen.getByRole('button', { name: 'Open New task' });
    invoker.focus();
    fireEvent.contextMenu(invoker);
    await waitFor(() =>
      expect(bridge.showContextMenu).toHaveBeenCalledWith({
        kind: 'conversation',
        conversationId: 'task-1',
      }),
    );
    await act(async () => {
      bridge.emit({
        type: 'desktop-action',
        action: 'rename-conversation',
        conversationId: 'task-1',
      });
    });
    const sheet = await screen.findByRole('dialog', { name: 'Rename conversation' });
    const input = within(sheet).getByRole('textbox', { name: 'Conversation title' });
    expect(document.activeElement).toBe(input);
    const save = within(sheet).getByRole('button', { name: 'Save name' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Renamed task' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(bridge.renameConversation).toHaveBeenCalledWith('task-1', 'Renamed task'),
    );
    await screen.findByRole('button', { name: 'Open Renamed task' });
    expect(screen.getByRole('heading', { name: 'Renamed task', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Rename conversation' })).toBeNull();
  });
  test('delete and Settings sheets trap focus, close contextually and restore invoker', async () => {
    const bridge = await newTask();
    const invoker = screen.getByRole('button', { name: 'Delete New task' });
    invoker.focus();
    fireEvent.click(invoker);
    const sheet = await screen.findByRole('dialog', { name: 'Delete conversation' });
    const cancel = within(sheet).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      within(sheet).getByRole('button', { name: 'Delete conversation' }),
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(invoker));
    expect(bridge.deleteConversation).not.toHaveBeenCalled();
    const settings = screen.getByRole('button', { name: 'Open settings' });
    settings.focus();
    fireEvent.click(settings);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const first = within(dialog).getByRole('button', { name: 'General' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('combobox', { name: 'Default provider' }),
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(settings));
  });
  test('messages and attached paths request only canonical native context targets', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', {
        workspace: '/workspace',
        attachments: ['/workspace/notes.md'],
        timeline: [
          {
            id: 'answer-1',
            at: Date.now(),
            type: 'message',
            message: { role: 'assistant', content: 'Answer to copy' },
          },
        ],
      });
    });
    fireEvent.contextMenu(await screen.findByText('Answer to copy'));
    await waitFor(() =>
      expect(bridge.showContextMenu).toHaveBeenCalledWith({
        kind: 'message',
        conversationId: 'task-1',
        itemId: 'answer-1',
      }),
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Workspace actions' }));
    await waitFor(() =>
      expect(bridge.showContextMenu).toHaveBeenCalledWith({
        kind: 'file',
        conversationId: 'task-1',
        path: '/workspace',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'File actions for notes.md' }));
    await waitFor(() =>
      expect(bridge.showContextMenu).toHaveBeenCalledWith({
        kind: 'file',
        conversationId: 'task-1',
        path: '/workspace/notes.md',
      }),
    );
  });
  test('native Help switches an already open General settings pane to About', async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('heading', { name: 'General', level: 2 });
    await act(async () => {
      bridge.emit({ type: 'desktop-action', action: 'about' });
    });
    await screen.findByRole('heading', { name: 'About', level: 2 });
    expect(screen.getByText('A personal agent for the work on your computer.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Appearance' })).toBeNull();
    expect(screen.getAllByRole('dialog', { name: 'Settings' }).length).toBe(1);
  });
  test('native appearance and menu events update UI without conversation casts', async () => {
    const bridge = await mount();
    await waitFor(() => expect(bridge.ready).toHaveBeenCalled());
    await act(async () => {
      bridge.emit({ type: 'desktop-appearance', appearance: { dark: true, reducedMotion: true } });
    });
    expect(document.documentElement.dataset.systemAppearance).toBe('dark');
    expect(document.documentElement.dataset.reducedMotion).toBe('true');
    await act(async () => {
      bridge.emit({ type: 'desktop-action', action: 'about' });
    });
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByText('A personal agent for the work on your computer.')).toBeTruthy();
  });
});

const testPlan: ActionPlan = {
  id: 'plan-1',
  digest: 'a'.repeat(64),
  title: 'Organize selected files',
  createdAt: Date.now(),
  scopeIds: ['scope-read', 'scope-write'],
  actions: [
    {
      id: 'action-copy',
      kind: 'copy_file',
      source: '/research/report.txt',
      target: '/organized/report.txt',
      effects: ['file.read', 'file.write'],
      bytes: 24,
      beforeHash: 'b'.repeat(64),
    },
    {
      id: 'action-write',
      kind: 'write_text',
      target: '/organized/summary.txt',
      effects: ['file.write'],
      bytes: 8,
      afterHash: 'c'.repeat(64),
      diff: '--- /dev/null\n+++ /organized/summary.txt\n@@ -0,0 +1 @@\n+Research\n',
    },
  ],
};
const testSource: SourceRecord = {
  id: 'src_abcdefabcdefabcdefabcdef',
  url: 'https://example.org/evidence',
  title: 'Research evidence',
  kind: 'page',
  retrievedAt: Date.now(),
  contentHash: 'd'.repeat(64),
  excerpt: 'A short verified retrieval excerpt.',
};
async function showPlan(bridge: FakeBridge) {
  const request: PermissionRequest = {
    requestId: 'plan-request',
    call: { id: 'plan-call', name: 'action_plan', arguments: '{}' },
    preview: { kind: 'plan', title: testPlan.title, plan: testPlan },
    permissionKey: 'plan:1',
    // Even a malformed host flag must never create plan session approval in the UI.
    allowSession: true,
  };
  await act(async () => {
    bridge.update('task-1', {
      state: 'waiting-permission',
      pendingPermission: request,
      timeline: [{ id: 'plan-permission', at: Date.now(), type: 'permission', request }],
    });
  });
  await screen.findByRole('button', { name: 'Allow plan' });
  return request;
}
describe('v0.2 Sources, plans and file scopes', () => {
  for (const [label, decision] of [
    ['Allow plan', 'allow-once'],
    ['Deny', 'deny'],
  ] as const)
    test(`approves the exact rendered immutable batch: ${decision}`, async () => {
      const bridge = await newTask();
      await showPlan(bridge);
      expect(screen.getByRole('region', { name: 'Action Plan preview' })).toBeTruthy();
      expect(screen.getByText('/research/report.txt')).toBeTruthy();
      expect(screen.getByText('/organized/summary.txt')).toBeTruthy();
      expect(screen.getByText('24 bytes')).toBeTruthy();
      expect(screen.getByText('Research')).toBeTruthy();
      expect(screen.getByText(testPlan.digest)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Allow for this session' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() =>
        expect(bridge.decideActionPlan).toHaveBeenCalledWith(
          'task-1',
          'plan-request',
          testPlan.digest,
          decision,
        ),
      );
      expect(bridge.decidePermission).not.toHaveBeenCalled();
    });
  test('missing plan data cannot be approved and explains how to cancel safely', async () => {
    const bridge = await newTask();
    const request = await showPlan(bridge);
    await act(async () => {
      bridge.update('task-1', {
        pendingPermission: { ...request, preview: { kind: 'plan', title: 'Unavailable plan' } },
        timeline: [],
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Allow plan' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(
      screen.getByText('Plan preview is unavailable. Stop this task to cancel the request.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Stop task' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  test('partial execution shows durable per-action status without claiming completion or rollback', async () => {
    const bridge = await newTask();
    await act(async () => {
      bridge.update('task-1', {
        state: 'completed',
        actionPlans: [
          {
            plan: testPlan,
            status: 'partial',
            executionId: 'execution-1',
            journal: [
              {
                planId: testPlan.id,
                actionId: 'action-copy',
                sequence: 1,
                status: 'running',
                at: Date.now(),
              },
              {
                planId: testPlan.id,
                actionId: 'action-copy',
                sequence: 2,
                status: 'succeeded',
                at: Date.now(),
              },
              {
                planId: testPlan.id,
                actionId: 'action-write',
                sequence: 3,
                status: 'failed',
                at: Date.now(),
                detail: 'Destination is no longer available.',
              },
            ],
          },
        ],
      });
    });
    const journal = await screen.findByTestId('plan-journal');
    fireEvent.click(within(journal).getByText('Organize selected files'));
    expect(within(journal).getByText('Partially completed')).toBeTruthy();
    expect(
      within(journal).getByText(
        'Some actions completed before the plan stopped. Completed actions were not rolled back.',
      ),
    ).toBeTruthy();
    expect(within(journal).getByText('Destination is no longer available.')).toBeTruthy();
    expect(journal.classList.contains('completed')).toBe(false);
    expect(within(journal).queryByText('Completed', { exact: true })).toBeNull();
  });
  for (const [status, label] of [
    ['denied', 'Denied'],
    ['stale', 'Changed since preview'],
    ['cancelled', 'Stopped'],
    ['interrupted', 'Interrupted'],
  ] as const)
    test(`restored plans preserve ${status} without autoapproval`, async () => {
      const bridge = new FakeBridge();
      bridge.restore({
        ...conversation(),
        state: 'interrupted',
        actionPlans: [{ plan: testPlan, status, executionId: 'saved-execution', journal: [] }],
      });
      await mount(bridge);
      const journal = await screen.findByTestId('plan-journal');
      expect(within(journal).getByText(label)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Allow plan' })).toBeNull();
      expect(bridge.decideActionPlan).not.toHaveBeenCalled();
      expect(bridge.sendTask).not.toHaveBeenCalled();
    });
  test('only known source citations open through main; unknown sources stay unverified text', async () => {
    const bridge = new FakeBridge();
    bridge.restore({
      ...conversation(),
      state: 'completed',
      sources: [testSource],
      timeline: [
        {
          id: 'research-answer',
          type: 'message',
          at: Date.now(),
          message: {
            role: 'assistant',
            content: `Supported fact [source:${testSource.id}]. Unsupported claim [source:src_missing].`,
          },
        },
      ],
    });
    await mount(bridge);
    const answer = await screen.findByText(/Supported fact/);
    const citation = within(answer).getByRole('button', { name: 'Open source: Research evidence' });
    fireEvent.click(citation);
    await waitFor(() => expect(bridge.openSource).toHaveBeenCalledWith('task-1', testSource.id));
    expect(screen.getByText('(Unverified source)')).toBeTruthy();
    expect(document.querySelectorAll('a[href]').length).toBe(0);
    expect(bridge.openSource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Sources', { exact: false, selector: 'summary' }));
    expect(await screen.findByText('A short verified retrieval excerpt.')).toBeTruthy();
    expect(screen.getByText(testSource.contentHash)).toBeTruthy();
    expect(screen.getByText('Page text')).toBeTruthy();
  });
  test('source-open errors expose safe guidance without host or network diagnostics', async () => {
    const bridge = new FakeBridge();
    bridge.openSource.mockRejectedValueOnce(new Error('private URL diagnostic'));
    bridge.restore({ ...conversation(), sources: [testSource] });
    await mount(bridge);
    fireEvent.click(await screen.findByText('Sources', { exact: false, selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open source: Research evidence' }));
    expect(
      await screen.findByText('Could not open this source. It may no longer be available.'),
    ).toBeTruthy();
    expect(screen.queryByText('private URL diagnostic')).toBeNull();
  });
  test('chooses explicit read/write roots and revokes a scope through narrow picker methods', async () => {
    const bridge = await newTask();
    fireEvent.click(screen.getByRole('button', { name: 'File scopes' }));
    const sheet = await screen.findByRole('dialog', { name: 'File scopes' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add read folder' }));
    await waitFor(() => expect(bridge.addScope).toHaveBeenCalledWith('task-1', 'read'));
    expect(await within(sheet).findByText('/research')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add writable folder' }));
    await waitFor(() => expect(bridge.addScope).toHaveBeenCalledWith('task-1', 'write'));
    expect(await within(sheet).findByText('Read & write')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove scope Research' }));
    await waitFor(() => expect(bridge.removeScope).toHaveBeenCalledWith('task-1', 'scope-read'));
    await waitFor(() => expect(within(sheet).queryByText('/research')).toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'File scopes' })).toBeNull();
    expect(bridge.chooseWorkspace).not.toHaveBeenCalled();
  });
  test('scope picker preserves welcome drafts and disables changes while a task is active', async () => {
    const bridge = await mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Prospero' }), {
      target: { value: 'Organize these files later.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'File scopes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add read folder' }));
    await waitFor(() => expect(bridge.addScope).toHaveBeenCalledWith('task-1', 'read'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      (screen.getByRole('textbox', { name: 'Message Prospero' }) as HTMLTextAreaElement).value,
    ).toBe('Organize these files later.');
    await act(async () => {
      bridge.update('task-1', { state: 'model-request' });
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'File scopes' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(bridge.sendTask).not.toHaveBeenCalled();
  });
  test('Web Search stores a password without retrieval or a network test and clears it after save', async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    const input = screen.getByLabelText('Search API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'offline-search-key' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Web Search' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Source retention' }), {
      target: { value: 'sources' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Web Search' }));
    await screen.findByText('Web Search settings saved.');
    expect(bridge.saveWebSearch).toHaveBeenCalledWith({
      provider: 'brave',
      enabled: true,
      retention: 'sources',
      apiKey: 'offline-search-key',
    });
    expect(input.value).toBe('');
    expect(screen.queryByText('offline-search-key')).toBeNull();
    expect(bridge.testProvider).not.toHaveBeenCalled();
    expect(bridge.testWebSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove search key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await screen.findByText('Search key removed. Web search is disabled.');
    expect(bridge.saveWebSearch).toHaveBeenLastCalledWith({
      provider: 'brave',
      enabled: false,
      retention: 'sources',
      clearApiKey: true,
    });
  });
  test('stored search keys remain empty while settings preserve them on ordinary saves', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    };
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    expect((screen.getByLabelText('Search API key') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save Web Search' }));
    await waitFor(() =>
      expect(bridge.saveWebSearch).toHaveBeenCalledWith({
        provider: 'brave',
        enabled: true,
        retention: 'session',
      }),
    );
    expect(screen.getByText(/Full page text is temporary and is not saved/)).toBeTruthy();
  });
  test('search connection testing requires a draft or stored key and does not save settings', async () => {
    const bridge = await mount();
    const previousConfig = structuredClone(bridge.data.webSearch);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    const button = screen.getByRole('button', {
      name: 'Test search connection',
    }) as HTMLButtonElement;
    const input = screen.getByLabelText('Search API key') as HTMLInputElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/may use your Brave Search API quota/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'short' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'offline-search-key' } });
    fireEvent.click(button);
    await screen.findByText('Connected to Brave Search. The test used one search request.');
    expect(bridge.testWebSearch).toHaveBeenCalledTimes(1);
    expect(bridge.testWebSearch).toHaveBeenCalledWith({
      provider: 'brave',
      apiKey: 'offline-search-key',
    });
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
    expect(bridge.testProvider).not.toHaveBeenCalled();
    expect(input.value).toBe('offline-search-key');
    expect(bridge.data.webSearch).toEqual(previousConfig);
  });
  test('tests the stored search key without retrieving it or enabling web search', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'brave',
      enabled: false,
      hasApiKey: true,
      retention: 'session',
    };
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    await screen.findByText('Connected to Brave Search. The test used one search request.');
    expect(bridge.testWebSearch).toHaveBeenCalledWith({ provider: 'brave' });
    expect((screen.getByLabelText('Search API key') as HTMLInputElement).value).toBe('');
    expect(bridge.data.webSearch.enabled).toBe(false);
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
  });
  test('switching search providers clears a draft key, test result and pending removal without reusing the other stored key', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    };
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    const input = screen.getByLabelText('Search API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'offline-brave-draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    await screen.findByText('Connected to Brave Search. The test used one search request.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove search key' }));
    expect(screen.getByText('Remove the stored Brave Search key?')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search provider' }), {
      target: { value: 'tavily' },
    });
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Enter a Tavily key');
    expect(screen.getByText('No key stored')).toBeTruthy();
    expect(
      screen.queryByText('Connected to Brave Search. The test used one search request.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove search key' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Test search connection' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Save Web Search' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(bridge.testWebSearch).toHaveBeenCalledTimes(1);
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'offline-tavily-draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    await screen.findByText('Connected to Tavily. The test used one search request.');
    expect(bridge.testWebSearch).toHaveBeenLastCalledWith({
      provider: 'tavily',
      apiKey: 'offline-tavily-draft',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Web Search' }));
    await screen.findByText('Web Search settings saved.');
    expect(bridge.saveWebSearch).toHaveBeenCalledWith({
      provider: 'tavily',
      enabled: true,
      retention: 'session',
      apiKey: 'offline-tavily-draft',
    });
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Leave blank to keep stored key');
    expect(bridge.data.webSearch?.provider).toBe('tavily');
  });
  test('stored Tavily credentials test and remove through the explicitly selected provider', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'tavily',
      enabled: false,
      hasApiKey: true,
      retention: 'sources',
    };
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    expect(
      (screen.getByRole('combobox', { name: 'Search provider' }) as HTMLSelectElement).value,
    ).toBe('tavily');
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    await screen.findByText('Connected to Tavily. The test used one search request.');
    expect(bridge.testWebSearch).toHaveBeenCalledWith({ provider: 'tavily' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove search key' }));
    expect(screen.getByText('Remove the stored Tavily key?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await screen.findByText('Search key removed. Web search is disabled.');
    expect(bridge.saveWebSearch).toHaveBeenCalledWith({
      provider: 'tavily',
      enabled: false,
      retention: 'sources',
      clearApiKey: true,
    });
    expect(bridge.testProvider).not.toHaveBeenCalled();
  });
  test('Tavily connection errors identify the selected provider without displaying response content', async () => {
    const bridge = await mount();
    bridge.testWebSearch.mockResolvedValueOnce({ status: 'auth', message: 'private Tavily body' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search provider' }), {
      target: { value: 'tavily' },
    });
    fireEvent.change(screen.getByLabelText('Search API key'), {
      target: { value: 'offline-tavily-draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    expect(
      await screen.findByText(
        'The search credential was rejected. Enter or replace the Tavily key.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('private Tavily body')).toBeNull();
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
  });
  for (const [status, message] of [
    ['auth', 'The search credential was rejected. Enter or replace the Brave Search key.'],
    ['rate-limit', 'Brave Search rate limit reached. Wait before testing again.'],
    ['server', 'Brave Search is temporarily unavailable. Try again later.'],
    ['incompatible', 'Brave Search returned an incompatible response.'],
    ['network', 'Could not connect securely to Brave Search. Check the connection and try again.'],
    ['timeout', 'The Brave Search connection test timed out.'],
    ['cancelled', 'The Brave Search connection test was cancelled.'],
  ] as const)
    test(`search connection ${status} displays a fixed safe result`, async () => {
      const bridge = await mount();
      bridge.testWebSearch.mockResolvedValueOnce({ status, message: 'private server body' });
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
      fireEvent.change(screen.getByLabelText('Search API key'), {
        target: { value: 'offline-search-key' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText('private server body')).toBeNull();
      expect(bridge.saveWebSearch).not.toHaveBeenCalled();
    });
  for (const [status, message] of [
    ['auth', 'Unlock secure credential storage and try again.'],
    ['auth', 'This saved credential does not match its provider endpoint. Re-enter the API key.'],
    [
      'timeout',
      'Secure credential operation timed out. Unlock the OS credential store and try again.',
    ],
  ] as const)
    test(`stored search key reports the main-owned recovery instruction: ${message}`, async () => {
      const bridge = new FakeBridge();
      bridge.data.webSearch = {
        provider: 'brave',
        enabled: true,
        hasApiKey: true,
        retention: 'session',
      };
      bridge.testWebSearch.mockResolvedValueOnce({
        status,
        message: `OFFLINE_PRIVATE_KEY ${message}`,
      });
      await mount(bridge);
      fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
      fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByText(/OFFLINE_PRIVATE_KEY/)).toBeNull();
      expect(
        screen.queryByText(
          'The search credential was rejected. Enter or replace the Brave Search key.',
        ),
      ).toBeNull();
      expect(bridge.testWebSearch).toHaveBeenCalledWith({ provider: 'brave' });
      expect(bridge.saveWebSearch).not.toHaveBeenCalled();
      expect((screen.getByLabelText('Search API key') as HTMLInputElement).value).toBe('');
    });
  test('Tavily retains main-owned credential recovery guidance instead of blaming the API key', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'tavily',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    };
    const recovery =
      'This saved credential does not match its provider endpoint. Re-enter the API key.';
    bridge.testWebSearch.mockResolvedValueOnce({
      status: 'auth',
      message: `OFFLINE_PRIVATE_KEY ${recovery}`,
    });
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    expect(await screen.findByText(recovery)).toBeTruthy();
    expect(screen.queryByText(/OFFLINE_PRIVATE_KEY/)).toBeNull();
    expect(
      screen.queryByText('The search credential was rejected. Enter or replace the Tavily key.'),
    ).toBeNull();
    expect(bridge.testWebSearch).toHaveBeenCalledWith({ provider: 'tavily' });
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
  });
  test('search test holds controls until completion and safely handles unexpected failures', async () => {
    const bridge = new FakeBridge();
    bridge.data.webSearch = {
      provider: 'brave',
      enabled: false,
      hasApiKey: true,
      retention: 'session',
    };
    let rejectTest = (_error: Error) => {};
    bridge.testWebSearch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTest = reject;
        }),
    );
    await mount(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test search connection' }));
    expect((screen.getByRole('button', { name: 'Testing…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Save Web Search' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Remove search key' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText('Search API key') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('combobox', { name: 'Search provider' }) as HTMLSelectElement).disabled,
    ).toBe(true);
    await act(async () => rejectTest(new Error('private transport body')));
    expect(
      await screen.findByText(
        'Could not test Web Search. Check the key, connection, and OS credential storage.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('private transport body')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Test search connection' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
  });
});

function researchSnapshot(): ResearchPlan {
  return {
    version: 1,
    id: 'research-snapshot-1',
    digest: 'e'.repeat(64),
    conversationId: 'task-1',
    executionId: 'research-execution-1',
    title: 'Research AI papers',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    queries: [
      { query: 'AI recommender systems October 2026', maxResults: 2 },
      { query: 'LLM self evolution papers', maxResults: 3 },
    ],
    maxSearches: 2,
    maxFetches: 4,
    maxResponseBytes: 512_000,
  };
}
async function showResearch(bridge: FakeBridge, snapshot = researchSnapshot()) {
  const request: PermissionRequest = {
    requestId: 'research-request-1',
    call: { id: 'research-call-1', name: 'research_plan', arguments: '{}' },
    preview: { kind: 'research', title: snapshot.title, research: snapshot },
    permissionKey: `research:${snapshot.digest}`,
    allowSession: true,
  };
  await act(async () => {
    bridge.update('task-1', {
      state: 'waiting-permission',
      pendingPermission: request,
      timeline: [{ id: 'research-permission-1', at: Date.now(), type: 'permission', request }],
    });
  });
  await screen.findByRole('button', { name: 'Allow research' });
  return { request, snapshot };
}

describe('Web Search readiness in chat', () => {
  function expectNoExecution(bridge: FakeBridge) {
    expect(bridge.testWebSearch).not.toHaveBeenCalled();
    expect(bridge.testProvider).not.toHaveBeenCalled();
    expect(bridge.sendTask).not.toHaveBeenCalled();
    expect(bridge.selectProvider).not.toHaveBeenCalled();
    expect(bridge.saveProvider).not.toHaveBeenCalled();
    expect(bridge.saveSettings).not.toHaveBeenCalled();
    expect(bridge.decideResearch).not.toHaveBeenCalled();
  }
  async function expectSettingsTab(tab: 'Models' | 'Web Search') {
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('heading', { name: tab })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: tab }).getAttribute('aria-current')).toBe(
      'page',
    );
  }
  for (const [label, enabled, hasApiKey] of [
    ['Web Search: off', false, true],
    ['Web Search: key required', true, false],
    ['Web Search configured · approval required', true, true],
  ] as const)
    test(`${label} opens Web Search settings without testing or changing configuration`, async () => {
      const bridge = new FakeBridge();
      bridge.data.webSearch = { provider: 'brave', enabled, hasApiKey, retention: 'session' };
      const before = structuredClone(bridge.data);
      await mount(bridge);
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await expectSettingsTab('Web Search');
      expect(bridge.data).toEqual(before);
      expect(bridge.saveWebSearch).not.toHaveBeenCalled();
      expectNoExecution(bridge);
    });
  test('a missing model opens Models without creating or sending a task', async () => {
    const bridge = new FakeBridge();
    bridge.data.providers = [];
    bridge.data.settings.defaultProviderId = undefined;
    bridge.data.webSearch = {
      provider: 'brave',
      enabled: true,
      hasApiKey: true,
      retention: 'session',
    };
    await mount(bridge);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Web Search: choose a model with tool calling' }),
    );
    await expectSettingsTab('Models');
    expect(bridge.createConversation).not.toHaveBeenCalled();
    expect(bridge.saveWebSearch).not.toHaveBeenCalled();
    expectNoExecution(bridge);
  });
  for (const selectedSupportsTools of [false, true])
    test(`readiness uses the conversation model tool setting (${selectedSupportsTools}) instead of the default model`, async () => {
      const bridge = new FakeBridge();
      const selectedProvider = {
        ...provider,
        id: 'selected-provider',
        supportsTools: selectedSupportsTools,
      };
      const defaultProvider = {
        ...provider,
        id: 'default-provider',
        supportsTools: !selectedSupportsTools,
      };
      bridge.data.providers = [defaultProvider, selectedProvider];
      bridge.data.settings.defaultProviderId = defaultProvider.id;
      bridge.data.webSearch = {
        provider: 'brave',
        enabled: true,
        hasApiKey: true,
        retention: 'session',
      };
      bridge.restore({ ...conversation(), providerId: selectedProvider.id });
      await mount(bridge);
      fireEvent.click(
        await screen.findByRole('button', {
          name: selectedSupportsTools
            ? 'Web Search configured · approval required'
            : 'Web Search: model tool calling is off',
        }),
      );
      await expectSettingsTab(selectedSupportsTools ? 'Web Search' : 'Models');
      expect(bridge.data.settings.defaultProviderId).toBe(defaultProvider.id);
      expect(bridge.requireConversation('task-1').providerId).toBe(selectedProvider.id);
      expect(bridge.saveWebSearch).not.toHaveBeenCalled();
      expectNoExecution(bridge);
    });
  test('saving Web Search immediately updates the chat status without a connection test', async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Web Search: off' }));
    await expectSettingsTab('Web Search');
    fireEvent.change(screen.getByLabelText('Search API key'), {
      target: { value: 'offline-readiness-key' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Web Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Web Search' }));
    await screen.findByText('Web Search settings saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(
      await screen.findByRole('button', { name: 'Web Search configured · approval required' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Web Search: off' })).toBeNull();
    expect(bridge.saveWebSearch).toHaveBeenCalledTimes(1);
    expectNoExecution(bridge);
  });
});

describe('controlled research approval UI', () => {
  for (const [label, decision] of [
    ['Allow research', 'allow-once'],
    ['Deny', 'deny'],
  ] as const)
    test(`sends the exact research digest for ${decision} through the narrow bridge`, async () => {
      const bridge = await newTask();
      const { snapshot } = await showResearch(bridge);
      const preview = screen.getByRole('region', { name: 'Research approval preview' });
      for (const entry of snapshot.queries)
        expect(within(preview).getByText(entry.query)).toBeTruthy();
      expect(within(preview).getByText('Maximum results: 2')).toBeTruthy();
      expect(within(preview).getByText('Maximum results: 3')).toBeTruthy();
      expect(within(preview).getByText(/Maximum searches:/).textContent).toContain('2');
      expect(within(preview).getByText(/Maximum searches:/).textContent).toContain('4');
      expect(within(preview).getByText('512000 bytes')).toBeTruthy();
      expect(preview.querySelector('time')?.getAttribute('datetime')).toBe(
        new Date(snapshot.expiresAt).toISOString(),
      );
      expect(within(preview).getByText(snapshot.digest)).toBeTruthy();
      expect(
        within(preview).getByText(/Only pages returned by these searches can be fetched/),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Allow for this session' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() =>
        expect(bridge.decideResearch).toHaveBeenCalledWith(
          'task-1',
          'research-request-1',
          snapshot.digest,
          decision,
        ),
      );
      expect(bridge.decidePermission).not.toHaveBeenCalled();
      expect(bridge.decideActionPlan).not.toHaveBeenCalled();
    });
  test('missing research data cannot be approved and leaves Stop available', async () => {
    const bridge = await newTask();
    const { request } = await showResearch(bridge);
    await act(async () => {
      bridge.update('task-1', {
        pendingPermission: {
          ...request,
          preview: { kind: 'research', title: 'Unavailable research' },
        },
        timeline: [],
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Allow research' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(
      screen.getByText('Research preview is unavailable. Stop this task to cancel the request.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Stop task' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(bridge.decideResearch).not.toHaveBeenCalled();
  });
  test('expired research cannot be approved but can be denied', async () => {
    const bridge = await newTask();
    const snapshot = { ...researchSnapshot(), expiresAt: Date.now() - 1 };
    await showResearch(bridge, snapshot);
    expect(
      (screen.getByRole('button', { name: 'Allow research' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Research approval has expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(bridge.decideResearch).toHaveBeenCalledWith(
        'task-1',
        'research-request-1',
        snapshot.digest,
        'deny',
      ),
    );
  });
  test('approval expires while its preview remains open', async () => {
    const bridge = await newTask();
    await showResearch(bridge, { ...researchSnapshot(), expiresAt: Date.now() + 80 });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Allow research' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(bridge.decideResearch).not.toHaveBeenCalled();
  });
  test('renders queries as inert text and does not launch URLs or native actions', async () => {
    const bridge = await newTask();
    const snapshot = researchSnapshot();
    const query = '<img src=x onerror=alert(1)> https://example.org/';
    await showResearch(bridge, { ...snapshot, queries: [{ query, maxResults: 1 }] });
    const preview = screen.getByRole('region', { name: 'Research approval preview' });
    expect(within(preview).getByText(query)).toBeTruthy();
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('a')).toBeNull();
    expect(bridge.openSource).not.toHaveBeenCalled();
    expect(bridge.showContextMenu).not.toHaveBeenCalled();
  });
  test('restored research history displays recorded status without approving or rerunning it', async () => {
    const bridge = new FakeBridge();
    const snapshot = researchSnapshot();
    bridge.restore({
      ...conversation(),
      state: 'completed',
      researchPlans: [
        {
          snapshot,
          events: [
            {
              sequence: 1,
              at: Date.now(),
              snapshotId: snapshot.id,
              digest: snapshot.digest,
              type: 'decision',
              status: 'denied',
              decision: 'deny',
            },
          ],
        },
      ],
    });
    await mount(bridge);
    const history = await screen.findByRole('region', { name: 'Research history' });
    expect(within(history).getByText('Denied')).toBeTruthy();
    expect(within(history).getByText(snapshot.title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow research' })).toBeNull();
    expect(bridge.decideResearch).not.toHaveBeenCalled();
    expect(bridge.sendTask).not.toHaveBeenCalled();
  });
  test('research history distinguishes approval, request results, revocation, and scope closure', async () => {
    const bridge = new FakeBridge();
    const snapshot = researchSnapshot();
    bridge.restore({
      ...conversation(),
      state: 'completed',
      researchPlans: [
        {
          snapshot,
          events: [
            { type: 'decision', status: 'approved' },
            { type: 'reserved', status: 'approved' },
            { type: 'started', status: 'approved' },
            { type: 'completed', status: 'approved' },
            { type: 'failed', status: 'approved' },
            { type: 'revoked', status: 'revoked' },
            { type: 'closed', status: 'closed' },
          ].map((event, index) => ({
            ...event,
            sequence: index + 1,
            at: Date.now(),
            snapshotId: snapshot.id,
            digest: snapshot.digest,
          })),
        },
      ],
    });
    await mount(bridge);
    const history = await screen.findByRole('region', { name: 'Research history' });
    const summary = history.querySelector('summary');
    expect(summary?.textContent).toContain('Scope closed');
    fireEvent.click(within(history).getByText(snapshot.title));
    const events = within(history).getByRole('list', { name: 'Research events' });
    expect(events.textContent).toContain('Snapshot approved');
    expect(events.textContent).toContain('Reserved');
    expect(events.textContent).toContain('Request dispatched');
    expect(events.textContent).toContain('Response received');
    expect(events.textContent).toContain('Failed');
    expect(events.textContent).toContain('Revoked');
    expect(events.textContent).toContain('Scope closed');
    expect(events.textContent).not.toContain('Completed');
    expect(bridge.decideResearch).not.toHaveBeenCalled();
    expect(bridge.sendTask).not.toHaveBeenCalled();
  });
});
