import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProsperoStore } from './index';
import { DatabaseSync } from 'node:sqlite';
test('fresh SQLite migration, append, settings, encrypted credential, execution and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prospero-db-'));
  const path = join(dir, 'app.sqlite');
  try {
    let store = new ProsperoStore(path);
    const c = {
      id: 'one',
      title: 'Read my notes',
      updatedAt: 1,
      state: 'planning',
      messages: [{ role: 'user', content: 'hello' }],
    };
    store.saveConversation(c);
    c.messages.push({ role: 'assistant', content: 'world' });
    store.saveConversation(c);
    store.setSetting('theme', 'dark');
    store.saveProvider({ id: 'local', model: 'fake' });
    store.saveEncryptedCredential('local', new Uint8Array([1, 2, 3, 4]));
    store.saveExecution({ id: 'run', conversationId: 'one', state: 'planning', startedAt: 10 });
    store.close();
    expect(readFileSync(path).subarray(0, 15).toString()).toBe('SQLite format 3');
    store = new ProsperoStore(path);
    expect(store.getConversation<typeof c>('one')?.messages.length).toBe(2);
    expect(store.conversations().length).toBe(1);
    expect(store.getSetting('theme', 'light')).toBe('dark');
    expect(store.providers()).toEqual([{ id: 'local', model: 'fake' }]);
    expect(Array.from(store.encryptedCredential('local') ?? [])).toEqual([1, 2, 3, 4]);
    store.interruptExecutions();
    expect(store.executions('one')[0].state).toBe('interrupted');
    store.deleteProvider('local');
    expect(store.encryptedCredential('local')).toBeUndefined();
    store.deleteConversation('one');
    expect(store.executions('one')).toEqual([]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('schema version is migrated once and future versions preserve the original database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prospero-migration-'));
  const path = join(dir, 'app.sqlite');
  try {
    new ProsperoStore(path).close();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => new ProsperoStore(path)).toThrow('newer Prospero');
    const preserved = new DatabaseSync(path);
    expect(preserved.prepare('PRAGMA user_version').get()?.user_version).toBe(99);
    preserved.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
