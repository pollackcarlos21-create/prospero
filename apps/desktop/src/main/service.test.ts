import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, DesktopEvent } from '../bridge';
import { ProsperoStore } from '@prospero/persistence';
import {
  closeIncompleteTools,
  DesktopService,
  type DesktopHost,
  type NativeMenuAction,
} from './service';
test('interrupted conversation restores with paired tool results, no permission or hidden memory', () => {
  const store = new ProsperoStore(':memory:');
  store.saveConversation({
    id: 'old',
    title: 'Interrupted',
    updatedAt: 1,
    state: 'waiting-permission',
    attachments: [],
    streamingText: 'temporary',
    pendingPermission: {},
    messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'shell', arguments: '{}' }] },
    ],
    timeline: [],
  });
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
  );
  const c = service.getConversation('old');
  expect(c.state).toBe('interrupted');
  expect(c.pendingPermission).toBeUndefined();
  expect(c.streamingText).toBe('');
  expect(c.messages[1].role).toBe('tool');
  expect(c.messages[1].toolCallId).toBe('a');
  expect(service.bootstrap().settings.memory).toEqual([]);
  store.close();
});
test('restart repair preserves completed results in multi-call response without repeating tools', () => {
  const messages = closeIncompleteTools([
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'read_file', arguments: '{}' },
        { id: 'b', name: 'shell', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: 'done' },
    { role: 'user', content: 'continue' },
  ]);
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
  expect(messages[2].content).toBe('done');
  expect(messages[3].content).toContain('interrupted');
});
test('a saved credential cannot be redirected to an arbitrary endpoint through renderer metadata', async () => {
  const store = new ProsperoStore(':memory:');
  store.saveProvider({
    id: 'saved',
    displayName: 'Saved',
    baseUrl: 'https://trusted.example/v1',
    model: 'm',
    timeoutMs: 60000,
    supportsTools: true,
    hasApiKey: true,
  });
  store.saveEncryptedCredential('saved', new Uint8Array([1, 2, 3]));
  let reads = 0;
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: async () => {
        reads++;
        return 'test-only-marker';
      },
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
  );
  const hostile = {
    id: 'saved',
    displayName: 'Saved',
    baseUrl: 'https://untrusted.example/v1',
    model: 'm',
  };
  await expect(service.testProvider(hostile)).rejects.toThrow('Re-enter');
  await expect(service.saveProvider(hostile)).rejects.toThrow('Re-enter');
  expect(reads).toBe(0);
  expect(service.bootstrap().providers[0].baseUrl).toBe('https://trusted.example/v1');
  store.close();
});
test('provider mutation reserves credentials across awaits and blocks tasks, tests and deletion', async () => {
  const store = new ProsperoStore(':memory:');
  store.saveProvider({
    id: 'saved',
    displayName: 'Saved',
    baseUrl: 'https://trusted.example/v1',
    model: 'm',
    timeoutMs: 60000,
    supportsTools: true,
    hasApiKey: true,
  });
  let release: (() => void) | undefined;
  const service = new DesktopService(
    store,
    {
      put: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      get: async () => undefined,
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
  );
  const c = service.createConversation();
  service.selectProvider(c.id, 'saved');
  const update = service.saveProvider({
    id: 'saved',
    displayName: 'Saved',
    baseUrl: 'https://other.example/v1',
    model: 'm',
    apiKey: 'test-marker',
  });
  await expect(service.sendTask(c.id, 'task')).rejects.toThrow('busy');
  await expect(
    service.testProvider({
      id: 'saved',
      displayName: 'Saved',
      baseUrl: 'https://trusted.example/v1',
      model: 'm',
    }),
  ).rejects.toThrow('busy');
  expect(() => service.deleteProvider('saved')).toThrow('busy');
  expect(service.getConversation(c.id).state).toBe('idle');
  release?.();
  await update;
  expect(service.bootstrap().providers[0].baseUrl).toBe('https://other.example/v1');
  store.close();
});
test('development credential fallback is bound to its configured endpoint', () => {
  const store = new ProsperoStore(':memory:');
  store.saveProvider({
    id: 'trusted',
    displayName: 'Trusted',
    baseUrl: 'https://trusted.example/v1',
    model: 'm',
  });
  store.saveProvider({
    id: 'local',
    displayName: 'Local',
    baseUrl: 'http://127.0.0.1:1234',
    model: 'm',
  });
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
    { apiKey: 'test-marker', baseUrl: 'https://trusted.example/v1' },
  );
  expect(service.bootstrap().providers.find((p) => p.id === 'trusted')?.hasApiKey).toBe(true);
  expect(service.bootstrap().providers.find((p) => p.id === 'local')?.hasApiKey).toBe(false);
  store.close();
});
test('permission policy cannot change while an active task holds an older host policy', async () => {
  const store = new ProsperoStore(':memory:');
  store.saveProvider({
    id: 'local',
    displayName: 'Local',
    baseUrl: 'http://127.0.0.1:1234',
    model: 'm',
    supportsTools: true,
  });
  let release: ((value: string | undefined) => void) | undefined;
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
  );
  const c = service.createConversation();
  service.selectProvider(c.id, 'local');
  await service.sendTask(c.id, 'read files');
  expect(() =>
    service.saveSettings({ ...service.bootstrap().settings, askBeforeReads: true }),
  ).toThrow('Stop the active task');
  const stopping = service.stopTask(c.id);
  release?.(undefined);
  await stopping;
  expect(
    service.saveSettings({ ...service.bootstrap().settings, askBeforeReads: true }).askBeforeReads,
  ).toBe(true);
  store.close();
});
test('bootstrap default settings are isolated from caller mutation and other data stores', async () => {
  const firstStore = new ProsperoStore(':memory:');
  const secondStore = new ProsperoStore(':memory:');
  const make = (store: ProsperoStore) =>
    new DesktopService(
      store,
      { put: async () => {}, get: async () => undefined },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      '0.1.0',
    );
  const first = make(firstStore);
  const second = make(secondStore);
  first.bootstrap().settings.memory.push({ id: 'external', text: 'should not be stored' });
  await first.saveProvider({ displayName: 'First', baseUrl: 'http://127.0.0.1:1234', model: 'm' });
  expect(first.bootstrap().settings.memory).toEqual([]);
  expect(second.bootstrap().settings.defaultProviderId).toBeUndefined();
  expect(second.createConversation().providerId).toBeUndefined();
  firstStore.close();
  secondStore.close();
});
function hostFixture() {
  const copies: string[] = [];
  const revealed: string[] = [];
  let items: NativeMenuAction[] = [];
  const host: DesktopHost = {
    appearance: () => ({ dark: false, reducedMotion: true }),
    ready: () => {},
    contextMenu: (value) => {
      items = value;
    },
    copy: (value) => {
      copies.push(value);
    },
    reveal: (value) => revealed.push(value),
    taskFinished: () => {},
  };
  return { host, copies, revealed, items: () => items };
}
test('native task menu emits confirmation actions and rename persists without executing tools', async () => {
  const store = new ProsperoStore(':memory:');
  const events: DesktopEvent[] = [];
  const desktop = hostFixture();
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    (event) => events.push(event),
    '0.1.0',
    undefined,
    desktop.host,
  );
  const c = service.createConversation();
  await service.showContextMenu({ kind: 'conversation', conversationId: c.id });
  expect(desktop.items().map((item) => item.label)).toEqual(['Rename…', 'Delete…']);
  await desktop.items()[0].action();
  await desktop.items()[1].action();
  expect(events.filter((event) => event.type === 'desktop-action')).toEqual([
    { type: 'desktop-action', action: 'rename-conversation', conversationId: c.id },
    { type: 'desktop-action', action: 'confirm-delete-conversation', conversationId: c.id },
  ]);
  expect(service.getConversation(c.id).title).toBe('New task');
  expect(service.renameConversation(c.id, '  A   useful task ').title).toBe('A useful task');
  expect(store.conversations<Conversation>()[0].title).toBe('A useful task');
  expect(() => service.renameConversation(c.id, 'bad\nname')).toThrow('title');
  expect(() => service.renameConversation(c.id, 'x'.repeat(121))).toThrow('title');
  expect(service.bootstrap().appearance).toEqual({ dark: false, reducedMotion: true });
  store.close();
});
test('message Copy uses main-owned content and file menus enforce exact authorized paths at click time', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'prospero-native-')));
  const workspace = join(dir, 'workspace');
  const attachment = join(dir, 'attached.txt');
  const known = join(workspace, 'known.txt');
  await mkdir(workspace);
  await writeFile(attachment, 'external');
  await writeFile(known, 'known');
  await writeFile(join(workspace, 'other.txt'), 'other');
  const store = new ProsperoStore(':memory:');
  const desktop = hostFixture();
  store.saveConversation({
    id: 'task',
    title: 'Task',
    state: 'idle',
    updatedAt: 1,
    workspace,
    attachments: [attachment],
    messages: [],
    streamingText: '',
    timeline: [
      {
        id: 'message',
        at: 1,
        type: 'message',
        message: { role: 'assistant', content: 'actual saved content' },
      },
      { id: 'preview', at: 1, type: 'tool', preview: { kind: 'read', title: 'Read', path: known } },
    ],
  });
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
    undefined,
    desktop.host,
  );
  try {
    await service.showContextMenu({ kind: 'message', conversationId: 'task', itemId: 'message' });
    await desktop.items()[0].action();
    expect(desktop.copies).toEqual(['actual saved content']);
    await expect(
      service.showContextMenu({ kind: 'message', conversationId: 'task', itemId: 'preview' }),
    ).rejects.toThrow('message');
    for (const path of [
      join(dir, 'outside.txt'),
      join(workspace, 'other.txt'),
      join(workspace, '..', 'outside.txt'),
    ])
      await expect(
        service.showContextMenu({ kind: 'file', conversationId: 'task', path }),
      ).rejects.toThrow('path');
    for (const path of [workspace, attachment, known]) {
      await service.showContextMenu({ kind: 'file', conversationId: 'task', path });
      expect(desktop.items().map((item) => item.label)).toEqual(['Reveal in Finder', 'Copy Path']);
      await desktop.items()[0].action();
      await desktop.items()[1].action();
    }
    expect(desktop.revealed).toEqual([workspace, attachment, known]);
    await service.showContextMenu({ kind: 'file', conversationId: 'task', path: known });
    await rm(known);
    await symlink(attachment, known);
    await expect(Promise.resolve().then(() => desktop.items()[0].action())).rejects.toThrow(
      'changed',
    );
    expect(desktop.revealed).toHaveLength(3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('closing window blocks new runs immediately and waits for cancellation before becoming idle', async () => {
  const store = new ProsperoStore(':memory:');
  store.saveProvider({
    id: 'local',
    displayName: 'Local',
    baseUrl: 'http://127.0.0.1:1234',
    model: 'm',
    supportsTools: true,
  });
  let release: ((value: undefined) => void) | undefined;
  const service = new DesktopService(
    store,
    {
      put: async () => {},
      get: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
  );
  const c = service.createConversation();
  service.selectProvider(c.id, 'local');
  await service.sendTask(c.id, 'task');
  const closing = service.suspendWindow();
  await expect(service.sendTask(c.id, 'hidden task')).rejects.toThrow('Reopen');
  await closing;
  expect(service.getConversation(c.id).state).toBe('cancelled');
  await expect(service.sendTask(c.id, 'hidden task')).rejects.toThrow('Reopen');
  service.resumeWindow();
  // Resuming restores explicit user execution; no run is automatically started.
  expect(
    service.getConversation(c.id).messages.filter((message) => message.role === 'user'),
  ).toHaveLength(1);
  expect(service.getConversation(c.id).state).toBe('cancelled');
  await service.shutdown();
  store.close();
  // Native reply can arrive after close; it must not start a provider or access the closed store.
  release?.(undefined);
  await Promise.resolve();
});
test('clipboard IPC waits for the native write and propagates failure without storing its content', async () => {
  const store = new ProsperoStore(':memory:');
  const desktop = hostFixture();
  let release: (() => void) | undefined;
  desktop.host.copy = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.1.0',
    undefined,
    desktop.host,
  );
  let finished = false;
  const copying = service.copyText('temporary clipboard text').then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release?.();
  await copying;
  expect(finished).toBe(true);
  desktop.host.copy = async () => {
    throw new Error('Native clipboard unavailable');
  };
  await expect(service.copyText('temporary clipboard text')).rejects.toThrow('unavailable');
  expect(service.bootstrap().conversations).toEqual([]);
  store.close();
});
