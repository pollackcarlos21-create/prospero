import { afterEach, beforeEach, expect, test } from 'bun:test';
import type {
  FileScope,
  NativeActionAdapter,
  PreparedTool,
  StructuredAction,
} from '@prospero/core';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureFileScope, createLocalToolHost } from '../../local-host/src/index';
import { ProsperoStore } from './index';

let directory: string;
let first: string;
let second: string;
let scopes: FileScope[];
let store: ProsperoStore;
const signal = () => new AbortController().signal;
const reference = (index: number, file: string) => ({ scopeId: scopes[index].id, path: file });

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'prospero-action-integration-')));
  first = path.join(directory, 'first');
  second = path.join(directory, 'second');
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'original.txt'), 'Approved content\n');
  scopes = [await captureFileScope(first, 'write'), await captureFileScope(second, 'write')];
  store = new ProsperoStore(path.join(directory, 'app.sqlite'));
  store.saveConversation({
    id: 'conversation',
    title: 'Organize files',
    updatedAt: 1,
    state: 'planning',
  });
  store.saveExecution({
    id: 'execution',
    conversationId: 'conversation',
    state: 'planning',
    startedAt: 1,
  });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function prepared(actions: StructuredAction[], native?: NativeActionAdapter) {
  const host = createLocalToolHost({
    scopes,
    native,
    workspace: first,
    journal: store.actionJournal('conversation', 'execution'),
  });
  const tool = await host.prepare(
    {
      id: 'tool-call',
      name: 'execute_plan',
      arguments: JSON.stringify({ title: 'Organize files', actions }),
    },
    signal(),
  );
  return { host, tool };
}

async function approve(tool: PreparedTool) {
  await tool.onDecision?.('allow-once');
}

function latest() {
  const entry = store.actionPlans('conversation')[0];
  const statuses = new Map<string, string>();
  for (const row of entry.journal) statuses.set(row.actionId, row.status);
  return { entry, statuses: [...statuses.values()] };
}

test('SQLite journal and host agree on projected cross-root mkdir/move/copy-path success', async () => {
  const clipboard: string[] = [];
  const native: NativeActionAdapter = {
    reveal: () => {},
    trash: async () => {},
    copyPath: (file) => {
      clipboard.push(file);
    },
  };
  const { tool } = await prepared(
    [
      { kind: 'create_directory', target: reference(1, 'sorted') },
      {
        kind: 'move_file',
        source: reference(0, 'original.txt'),
        target: reference(1, 'sorted/moved.txt'),
      },
      { kind: 'copy_path', target: reference(1, 'sorted/moved.txt') },
    ],
    native,
  );
  const previewPlan = tool.preview.plan;
  if (!previewPlan) throw new Error('Expected an immutable Action Plan preview.');
  expect(store.actionPlans('conversation')[0].plan).toEqual(previewPlan);
  expect(latest().statuses).toEqual(['prepared', 'prepared', 'prepared']);
  await approve(tool);
  const result = await tool.execute(signal());
  expect(result.planOutcome?.status).toBe('completed');
  expect(latest().entry.status).toBe('completed');
  expect(latest().statuses).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(latest().entry.journal.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(await readFile(path.join(second, 'sorted/moved.txt'), 'utf8')).toBe('Approved content\n');
  await expect(stat(path.join(first, 'original.txt'))).rejects.toThrow();
  expect(clipboard).toEqual([path.join(second, 'sorted/moved.txt')]);
});

test('SQLite denial and revocation prevent plan effects and conversion to legacy shell/write', async () => {
  const { host, tool } = await prepared([
    { kind: 'copy_file', source: reference(0, 'original.txt'), target: reference(1, 'never.txt') },
  ]);
  await approve(tool);
  const denied = await host.prepare(
    {
      id: 'denied-write',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'denied.txt', content: 'no' }),
    },
    signal(),
  );
  await denied.onDecision?.('deny');
  expect((await tool.execute(signal())).planOutcome?.status).toBe('denied');
  expect(latest().entry.status).toBe('denied');
  expect(latest().statuses).toEqual(['denied']);
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
  await expect(
    host.prepare({ id: 'convert', name: 'shell', arguments: '{"command":"true"}' }, signal()),
  ).rejects.toThrow('denied');
  await expect(
    host.prepare(
      { id: 'convert-write', name: 'write_file', arguments: '{"path":"never.txt","content":"no"}' },
      signal(),
    ),
  ).rejects.toThrow('denied');
});

test('SQLite stale result stops the batch, preserving changed source and terminalizing later actions', async () => {
  const { tool } = await prepared([
    { kind: 'move_file', source: reference(0, 'original.txt'), target: reference(1, 'never.txt') },
    { kind: 'write_text', target: reference(1, 'also-never.txt'), content: 'no' },
  ]);
  await approve(tool);
  await writeFile(path.join(first, 'original.txt'), 'External edit must survive');
  expect((await tool.execute(signal())).planOutcome?.status).toBe('stale');
  expect(latest().entry.status).toBe('stale');
  expect(latest().statuses).toEqual(['stale', 'skipped']);
  expect(await readFile(path.join(first, 'original.txt'), 'utf8')).toBe(
    'External edit must survive',
  );
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
});

test('SQLite partial result preserves prior copy and records uncertain native effects without leaking native errors', async () => {
  const native: NativeActionAdapter = {
    reveal: () => {
      throw new Error('PRIVATE_NATIVE_ERROR');
    },
    copyPath: () => {},
    trash: async () => {},
  };
  const { tool } = await prepared(
    [
      {
        kind: 'copy_file',
        source: reference(0, 'original.txt'),
        target: reference(1, 'copied.txt'),
      },
      { kind: 'reveal_in_finder', target: reference(1, 'copied.txt') },
      { kind: 'write_text', target: reference(1, 'never.txt'), content: 'no' },
    ],
    native,
  );
  await approve(tool);
  const result = await tool.execute(signal());
  expect(result.planOutcome?.status).toBe('partial');
  expect(latest().entry.status).toBe('partial');
  expect(latest().statuses).toEqual(['succeeded', 'failed', 'skipped']);
  expect(result.content).not.toContain('PRIVATE_NATIVE_ERROR');
  expect(latest().entry.journal.at(-2)?.detail).toBe('partial_effect:action_failed');
  expect(await readFile(path.join(second, 'copied.txt'), 'utf8')).toBe('Approved content\n');
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
});

test('SQLite Stop preserves a completed native action and cancels remaining work without reusing approval', async () => {
  const controller = new AbortController();
  const native: NativeActionAdapter = {
    reveal: () => {
      controller.abort();
    },
    copyPath: () => {},
    trash: async () => {},
  };
  const { tool } = await prepared(
    [
      { kind: 'reveal_in_finder', target: reference(0, 'original.txt') },
      {
        kind: 'copy_file',
        source: reference(0, 'original.txt'),
        target: reference(1, 'never.txt'),
      },
    ],
    native,
  );
  await approve(tool);
  expect((await tool.execute(controller.signal)).planOutcome?.status).toBe('partial');
  expect(latest().entry.status).toBe('partial');
  expect(latest().statuses).toEqual(['succeeded', 'cancelled']);
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
  expect((await tool.execute(signal())).isError).toBe(true);
});

test('SQLite failed running commit prevents every filesystem effect and completes a truthful failed journal', async () => {
  const { tool } = await prepared([
    { kind: 'copy_file', source: reference(0, 'original.txt'), target: reference(1, 'never.txt') },
    { kind: 'write_text', target: reference(1, 'also-never.txt'), content: 'no' },
  ]);
  await approve(tool);
  const observer = new DatabaseSync(path.join(directory, 'app.sqlite'));
  try {
    observer.exec(
      "CREATE TRIGGER simulate_storage_failure BEFORE INSERT ON action_journal WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'PRIVATE_DB_ERROR'); END;",
    );
    const result = await tool.execute(signal());
    expect(result.planOutcome?.status).toBe('failed');
    expect(latest().entry.status).toBe('failed');
    expect(latest().statuses).toEqual(['failed', 'skipped']);
    expect(result.content).not.toContain('PRIVATE_DB_ERROR');
    await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
    await expect(stat(path.join(second, 'also-never.txt'))).rejects.toThrow();
  } finally {
    observer.close();
  }
});

test('SQLite onSkipped fails the first prepared action and skips remaining actions before approval', async () => {
  const { tool } = await prepared([
    { kind: 'write_text', target: reference(1, 'never.txt'), content: 'no' },
    { kind: 'write_text', target: reference(1, 'also-never.txt'), content: 'no' },
  ]);
  await tool.onSkipped?.('failed');
  expect(latest().entry.status).toBe('failed');
  expect(latest().statuses).toEqual(['failed', 'skipped']);
  await expect(stat(path.join(second, 'never.txt'))).rejects.toThrow();
  await expect(stat(path.join(second, 'also-never.txt'))).rejects.toThrow();
});
