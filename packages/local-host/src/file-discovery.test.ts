import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolHost } from '@prospero/core';
import { captureFileScope, createLocalToolHost, TOOL_LIMITS } from './index';

let fixture: string;
let workspace: string;
let host: ToolHost;
const signal = () => new AbortController().signal;
const run = async (name: string, args: object, targetHost = host) => {
  const prepared = await targetHost.prepare(
    { id: 'discovery', name, arguments: JSON.stringify(args) },
    signal(),
  );
  return prepared.execute(signal());
};
interface Page {
  entries: {
    name: string;
    type: string;
    sizeBytes: number | null;
    modifiedAt: string;
    createdAt: string | null;
  }[];
  nextCursor: string | null;
  hasMore: boolean;
  timeBasis: string;
}
beforeEach(async () => {
  fixture = await mkdtemp(path.join(await realpath(tmpdir()), 'prospero-discovery-'));
  workspace = path.join(fixture, 'workspace');
  await mkdir(workspace);
  host = createLocalToolHost({ workspace });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test('binary metadata includes exact size and explicit filesystem time, without a text read', async () => {
  const file = path.join(workspace, 'paper.pdf');
  await writeFile(file, Buffer.alloc(TOOL_LIMITS.fileBytes + 1));
  const modified = new Date('2026-09-15T08:00:00.000Z');
  await utimes(file, modified, modified);
  const info = JSON.parse((await run('get_file_info', { path: 'paper.pdf' })).content);
  expect(info).toMatchObject({
    name: 'paper.pdf',
    type: 'file',
    sizeBytes: TOOL_LIMITS.fileBytes + 1,
    modifiedAt: modified.toISOString(),
  });
  expect(info.timeBasis).toContain('not download dates');
  await expect(run('read_file', { path: 'paper.pdf' })).rejects.toThrow('exceeds');
  const page: Page = JSON.parse((await run('list_directory', {})).content);
  expect(page.entries[0]).toMatchObject({
    modifiedAt: modified.toISOString(),
    sizeBytes: TOOL_LIMITS.fileBytes + 1,
  });
  expect(page.nextCursor).toBeNull();
});

test('exact attachments and file scopes allow metadata but never sibling discovery', async () => {
  const file = path.join(fixture, 'external.pdf');
  await writeFile(file, Buffer.from([0, 1, 2]));
  const attached = createLocalToolHost({ attachments: [file] });
  expect(JSON.parse((await run('get_file_info', { path: file }, attached)).content).sizeBytes).toBe(
    3,
  );
  const scope = await captureFileScope(file, 'read');
  const scoped = createLocalToolHost({ scopes: [scope] });
  expect(
    JSON.parse((await run('get_file_info', { scopeId: scope.id, path: '.' }, scoped)).content).type,
  ).toBe('file');
  await expect(run('list_directory', { scopeId: scope.id }, scoped)).rejects.toThrow('exact-file');
  await expect(
    run('get_file_info', { scopeId: scope.id, path: '../sibling' }, scoped),
  ).rejects.toThrow('traversal');
  await expect(run('get_file_info', { path: fixture }, attached)).rejects.toThrow('workspace');
});

test('paged discovery returns every one of 1001 files once, in deterministic order', async () => {
  const names = Array.from(
    { length: 1001 },
    (_, index) => `paper-${String(index).padStart(4, '0')}.pdf`,
  );
  for (let index = 0; index < names.length; index += 50)
    await Promise.all(
      names
        .slice(index, index + 50)
        .map((name) => writeFile(path.join(workspace, name), '%PDF-1.7')),
    );
  const observed: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await run('list_directory', { maxEntries: 137, ...(cursor ? { cursor } : {}) });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
    const page: Page = JSON.parse(result.content);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThanOrEqual(137);
    expect(page.hasMore).toBe(Boolean(result.truncated));
    observed.push(...page.entries.map((entry) => entry.name));
    cursor = page.nextCursor;
  } while (cursor);
  expect(observed).toEqual(names);
  expect(new Set(observed).size).toBe(names.length);
});

test('UTF-8 output pressure produces valid JSON and a cursor rather than cutting an entry', async () => {
  const names = Array.from(
    { length: 100 },
    (_, index) => `${String(index).padStart(3, '0')}-${'中'.repeat(70)}.pdf`,
  );
  await Promise.all(names.map((name) => writeFile(path.join(workspace, name), 'x')));
  const first = await run('list_directory', { maxEntries: 500 });
  expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(TOOL_LIMITS.outputBytes);
  const page: Page = JSON.parse(first.content);
  expect(page.hasMore).toBe(true);
  expect(page.entries.length).toBeLessThan(names.length);
  const second: Page = JSON.parse(
    (await run('list_directory', { cursor: page.nextCursor })).content,
  );
  expect([...page.entries, ...second.entries].map((entry) => entry.name)).toEqual(names);
  expect(second.nextCursor).toBeNull();
});

test('changed directories, foreign-directory cursors and malformed cursors fail closed', async () => {
  await writeFile(path.join(workspace, 'a'), 'a');
  await writeFile(path.join(workspace, 'b'), 'b');
  const first: Page = JSON.parse((await run('list_directory', { maxEntries: 1 })).content);
  await mkdir(path.join(fixture, 'other'));
  const otherHost = createLocalToolHost({ workspace: path.join(fixture, 'other') });
  await expect(run('list_directory', { cursor: first.nextCursor }, otherHost)).rejects.toThrow(
    'cursor',
  );
  await expect(run('list_directory', { cursor: 'abc' })).rejects.toThrow('cursor');
  await writeFile(path.join(workspace, 'c'), 'c');
  await expect(run('list_directory', { cursor: first.nextCursor })).rejects.toThrow('stale');
  expect(JSON.parse((await run('list_directory', {})).content).entries).toHaveLength(3);
});

test('symlinks are labeled without following their target; metadata inspection rejects them', async () => {
  await symlink(path.join(fixture, 'missing-private-target'), path.join(workspace, 'alias'));
  const page: Page = JSON.parse((await run('list_directory', {})).content);
  expect(page.entries[0]).toMatchObject({ name: 'alias', type: 'symlink', sizeBytes: null });
  expect(JSON.parse((await run('get_file_info', { path: '.' })).content).type).toBe('directory');
  await expect(run('get_file_info', { path: 'alias' })).rejects.toThrow('Symlink');
  await expect(run('get_file_info', { path: '../outside' })).rejects.toThrow('traversal');
});
