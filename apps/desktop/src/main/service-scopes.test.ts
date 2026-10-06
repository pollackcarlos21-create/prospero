import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureFileScope } from '@prospero/local-host';
import { ProsperoStore } from '@prospero/persistence';
import type { FileScope } from '@prospero/core';
import type { Conversation } from '../bridge';
import { DesktopService, type DesktopHost, type NativeMenuAction } from './service';

let fixture: string;
let first: string;
let second: string;
let store: ProsperoStore;
let service: DesktopService;
let menu: NativeMenuAction[];
let revealed: string[];
let copied: string[];
const nativeFileMenu = (target: string) =>
  service.showContextMenu({ kind: 'file', conversationId: 'task', path: target });
function setup(
  scopes: FileScope[],
  timeline: Conversation['timeline'] = [],
  attachments: string[] = [],
  workspace?: string,
) {
  store.saveConversation({
    id: 'task',
    title: 'File organization',
    state: 'idle',
    updatedAt: Date.now(),
    scopes,
    workspace,
    timeline,
    attachments,
    messages: [],
    streamingText: '',
  });
  const desktop: DesktopHost = {
    appearance: () => ({ dark: false, reducedMotion: false }),
    ready: () => {},
    contextMenu: (items) => {
      menu = items;
    },
    copy: (value) => {
      copied.push(value);
    },
    reveal: (target) => {
      revealed.push(target);
    },
    taskFinished: () => {},
  };
  service = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => first, files: async () => [] },
    () => {},
    '0.2.0',
    undefined,
    desktop,
  );
}
beforeEach(async () => {
  fixture = await mkdtemp(path.join(await realpath(tmpdir()), 'prospero-context-scopes-'));
  first = path.join(fixture, 'first');
  second = path.join(fixture, 'second');
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'note.txt'), 'first');
  await writeFile(path.join(second, 'copied.txt'), 'second');
  store = new ProsperoStore(':memory:');
  menu = [];
  revealed = [];
  copied = [];
});
afterEach(async () => {
  await service?.shutdown();
  store.close();
  await rm(fixture, { recursive: true, force: true });
});

test('context menus support main-owned Action Plan source/target paths across read and write roots', async () => {
  const scopes = [await captureFileScope(first, 'read'), await captureFileScope(second, 'write')];
  const source = path.join(first, 'note.txt');
  const target = path.join(second, 'copied.txt');
  setup(scopes, [
    {
      id: 'plan-tool',
      at: 1,
      type: 'tool',
      preview: {
        kind: 'plan',
        title: 'Organize',
        plan: {
          id: 'plan',
          digest: 'test-digest',
          title: 'Organize',
          createdAt: 1,
          scopeIds: scopes.map((scope) => scope.id),
          actions: [
            { id: 'copy', kind: 'copy_file', source, target, effects: ['file.read', 'file.write'] },
          ],
        },
      },
    },
  ]);
  for (const entry of [first, second, source, target]) {
    await nativeFileMenu(entry);
    expect(menu.map((item) => item.label)).toEqual(['Reveal in Finder', 'Copy Path']);
    await menu[0].action();
    await menu[1].action();
  }
  expect(revealed).toEqual([first, second, source, target]);
  expect(copied).toEqual(revealed);
  await writeFile(path.join(second, 'unrelated.txt'), 'unrelated');
  await expect(nativeFileMenu(path.join(second, 'unrelated.txt'))).rejects.toThrow('path');
});

test('scope revocation between menu open and click blocks Finder and clipboard operations', async () => {
  const scope = await captureFileScope(first, 'read');
  setup([scope]);
  await nativeFileMenu(first);
  const pending = [...menu];
  service.removeScope('task', scope.id);
  await expect(Promise.resolve().then(() => pending[0].action())).rejects.toThrow('path');
  await expect(Promise.resolve().then(() => pending[1].action())).rejects.toThrow('path');
  expect(revealed).toEqual([]);
  expect(copied).toEqual([]);
});

test('ordinary directory replacement and exact-file inode replacement invalidate context menu grants', async () => {
  const dirScope = await captureFileScope(first, 'read');
  const fileScope = await captureFileScope(path.join(second, 'copied.txt'), 'read');
  setup([dirScope, fileScope]);
  await nativeFileMenu(first);
  const rootMenu = [...menu];
  await rename(first, path.join(fixture, 'old-first'));
  await mkdir(first);
  await expect(Promise.resolve().then(() => rootMenu[0].action())).rejects.toThrow('changed');
  await nativeFileMenu(fileScope.path);
  const fileMenu = [...menu];
  await rename(fileScope.path, path.join(second, 'old-file'));
  await writeFile(fileScope.path, 'replacement');
  await expect(Promise.resolve().then(() => fileMenu[1].action())).rejects.toThrow('changed');
  expect(revealed).toEqual([]);
  expect(copied).toEqual([]);
});

test('symlink leaves and parents cannot redirect a historical Plan preview outside its selected root', async () => {
  const scope = await captureFileScope(first, 'read');
  const child = path.join(first, 'note.txt');
  setup(
    [scope],
    [{ id: 'read', at: 1, type: 'tool', preview: { kind: 'read', title: 'Read', path: child } }],
  );
  await nativeFileMenu(child);
  const pending = [...menu];
  await rm(child);
  await symlink(path.join(second, 'copied.txt'), child);
  await expect(Promise.resolve().then(() => pending[0].action())).rejects.toThrow('changed');
  expect(await readFile(path.join(second, 'copied.txt'), 'utf8')).toBe('second');
  expect(revealed).toEqual([]);
});

test('legacy workspace replacement cannot be revived through a UUID scope or a stale menu', async () => {
  const scope = { ...(await captureFileScope(first, 'write')), id: 'workspace' };
  setup([scope], [], [], first);
  await service.addScope('task', 'write');
  const replacement = service.getConversation('task').scopes?.[0];
  if (!replacement) throw new Error('Expected selected scope.');
  expect(replacement.id).not.toBe('workspace');
  await nativeFileMenu(first);
  const pending = [...menu];
  service.removeScope('task', replacement.id);
  expect(service.getConversation('task').workspace).toBeUndefined();
  await expect(Promise.resolve().then(() => pending[0].action())).rejects.toThrow('path');
});

test('v0.1 exact attachments acquire persisted file identity without granting sibling native paths', async () => {
  const attachment = path.join(second, 'copied.txt');
  setup([], [], [attachment]);
  await nativeFileMenu(attachment);
  await menu[1].action();
  const scope = store
    .conversations<Conversation>()[0]
    .scopes?.find((entry) => entry.path === attachment);
  if (!scope) throw new Error('Expected migrated file scope.');
  expect(scope.kind).toBe('file');
  expect(scope.mode).toBe('read');
  expect(scope.identity).toBeDefined();
  await expect(nativeFileMenu(second)).rejects.toThrow('path');
  const pending = [...menu];
  service.removeScope('task', scope.id);
  await expect(Promise.resolve().then(() => pending[1].action())).rejects.toThrow('path');
  expect(copied).toEqual([attachment]);
});

test('planned missing target paths can be copied while private siblings and absolute traversal remain unavailable', async () => {
  const scope = await captureFileScope(second, 'write');
  const target = path.join(second, 'planned/new.txt');
  setup(
    [scope],
    [
      {
        id: 'plan-permission',
        at: 1,
        type: 'permission',
        request: {
          requestId: 'request',
          call: { id: 'call', name: 'execute_plan', arguments: '{}' },
          permissionKey: 'plan',
          allowSession: false,
          preview: {
            kind: 'plan',
            title: 'Prepare new file',
            plan: {
              id: 'plan',
              digest: 'digest',
              title: 'Prepare',
              createdAt: 1,
              scopeIds: [scope.id],
              actions: [{ id: 'write', kind: 'write_text', target, effects: ['file.write'] }],
            },
          },
        },
      },
    ],
  );
  await nativeFileMenu(target);
  await menu[1].action();
  expect(copied).toEqual([target]);
  await expect(nativeFileMenu(`${second}/../first/note.txt`)).rejects.toThrow('path');
  await expect(nativeFileMenu(path.join(second, 'planned/unrelated.txt'))).rejects.toThrow('path');
});

test('a parent symlink and modern scopes without identity cannot authorize Finder operations', async () => {
  const scope = await captureFileScope(first, 'read');
  await mkdir(path.join(first, 'nested'));
  const target = path.join(first, 'nested/copied.txt');
  await writeFile(target, 'inside');
  setup(
    [scope],
    [{ id: 'read', at: 1, type: 'tool', preview: { kind: 'read', title: 'Read', path: target } }],
  );
  await nativeFileMenu(target);
  const pending = [...menu];
  await rename(path.join(first, 'nested'), path.join(first, 'old-nested'));
  await symlink(second, path.join(first, 'nested'));
  await expect(Promise.resolve().then(() => pending[0].action())).rejects.toThrow('changed');
  expect(revealed).toEqual([]);
  store.saveConversation({
    ...service.getConversation('task'),
    id: 'unbound',
    scopes: [
      { id: 'unbound-scope', path: second, label: 'Unbound', kind: 'directory', mode: 'read' },
    ],
  });
  const unbound = new DesktopService(
    store,
    { put: async () => {}, get: async () => undefined },
    { folder: async () => undefined, files: async () => [] },
    () => {},
    '0.2.0',
  );
  await expect(
    unbound.showContextMenu({ kind: 'file', conversationId: 'unbound', path: second }),
  ).rejects.toThrow('changed');
  await unbound.shutdown();
});
