import { expect, test } from 'bun:test';
import type { ActionPlan, SourceRecord } from '@prospero/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore, SOURCE_RETENTION_MS } from './index';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prospero-action-db-'));
  const path = join(dir, 'app.sqlite');
  const store = new ProsperoStore(path);
  store.saveConversation({
    id: 'conversation',
    title: 'Organize notes',
    updatedAt: 1,
    state: 'planning',
  });
  return { path, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function plan(id = 'plan'): ActionPlan {
  return {
    id,
    digest: `digest-${id}`,
    title: 'Organize ordinary files',
    createdAt: 100,
    scopeIds: ['scope'],
    actions: [
      { id: 'one', kind: 'create_directory', target: '/notes/sorted', effects: ['file.write'] },
      {
        id: 'two',
        kind: 'move_file',
        source: '/notes/a.txt',
        target: '/notes/sorted/a.txt',
        effects: ['file.read', 'file.write', 'file.remove'],
        beforeHash: 'old-hash',
      },
      {
        id: 'three',
        kind: 'copy_path',
        target: '/notes/sorted/a.txt',
        effects: ['native.clipboard'],
      },
    ],
  };
}

function source(id = 'source'): SourceRecord {
  return {
    id,
    url: 'https://research.example/report',
    title: 'A public report',
    kind: 'page',
    retrievedAt: Date.now(),
    contentHash: 'sha256-source-content',
    excerpt: 'A bounded excerpt.',
  };
}

test('v1 migration preserves conversations, settings, providers, encrypted credentials and executions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prospero-v1-migration-'));
  const path = join(dir, 'app.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE credentials (id TEXT PRIMARY KEY,ciphertext BLOB NOT NULL);
      CREATE TABLE executions (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,state TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,model_turns INTEGER,tool_calls INTEGER);
      PRAGMA user_version=1;
    `);
    const conversation = {
      id: 'legacy',
      title: 'Existing history',
      updatedAt: 1,
      state: 'completed',
      messages: [{ role: 'user', content: 'Keep my history' }],
    };
    old
      .prepare('INSERT INTO conversations VALUES (?,?,?,?,?)')
      .run('legacy', conversation.title, 1, 'completed', JSON.stringify(conversation));
    old.prepare('INSERT INTO settings VALUES (?,?)').run('theme', '"dark"');
    old
      .prepare('INSERT INTO providers VALUES (?,?)')
      .run('legacy-provider', '{"id":"legacy-provider","model":"fake"}');
    old
      .prepare('INSERT INTO credentials VALUES (?,?)')
      .run('legacy-provider', new Uint8Array([9, 8, 7]));
    old
      .prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?)')
      .run('legacy-run', 'legacy', 'completed', 10, 20, 2, 1);
    old.close();
    const store = new ProsperoStore(path);
    expect(store.getConversation('legacy')).toEqual(conversation);
    expect(store.getSetting('theme', 'light')).toBe('dark');
    expect(store.providers()).toEqual([{ id: 'legacy-provider', model: 'fake' }]);
    expect([...(store.encryptedCredential('legacy-provider') ?? [])]).toEqual([9, 8, 7]);
    expect(store.executions('legacy')[0]).toMatchObject({
      id: 'legacy-run',
      state: 'completed',
      modelTurns: 2,
      toolCalls: 1,
    });
    expect(store.actionPlans('legacy')).toEqual([]);
    expect(store.sources('legacy')).toEqual([]);
    store.close();
    const migrated = new DatabaseSync(path);
    expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    migrated.close();
    new ProsperoStore(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('immutable plans, append-only journal and ordered durable running transitions', () => {
  const { path, store, cleanup } = fixture();
  try {
    const journal = store.actionJournal('conversation', 'execution');
    const batch = plan();
    journal.prepare(batch);
    journal.prepare(batch);
    expect(journal.entries(batch.id).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(() => journal.prepare({ ...batch, title: 'Changed after preview' })).toThrow(
      'immutable',
    );
    expect(() => store.actionJournal('conversation', 'other-run').entries(batch.id)).toThrow(
      'belong',
    );
    expect(() => journal.transition(batch.id, 'one', 'running')).toThrow('approval');
    journal.decision(batch.id, 'allow-once');
    expect(() => journal.prepare(batch)).toThrow('decided');
    expect(() => journal.transition(batch.id, 'two', 'running')).toThrow('dependencies');
    journal.transition(batch.id, 'one', 'running');
    const observer = new DatabaseSync(path);
    expect(
      observer
        .prepare(
          "SELECT status FROM action_journal WHERE plan_id='plan' ORDER BY sequence DESC LIMIT 1",
        )
        .get()?.status,
    ).toBe('running');
    expect(() => observer.exec("UPDATE action_plans SET payload='{}' WHERE id='plan'")).toThrow(
      'immutable',
    );
    expect(() =>
      observer.exec("UPDATE action_journal SET status='succeeded' WHERE plan_id='plan'"),
    ).toThrow('append-only');
    expect(() => observer.exec("DELETE FROM action_journal WHERE plan_id='plan'")).toThrow(
      'append-only',
    );
    observer.close();
    expect(() => journal.finish(batch.id, 'completed')).toThrow('journal');
    journal.transition(batch.id, 'one', 'succeeded');
    expect(() => journal.transition(batch.id, 'one', 'running')).toThrow('terminal');
    journal.transition(batch.id, 'two', 'running');
    journal.transition(batch.id, 'two', 'succeeded');
    journal.transition(batch.id, 'three', 'running');
    journal.transition(batch.id, 'three', 'succeeded');
    journal.finish(batch.id, 'completed');
    expect(journal.entries(batch.id).map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(store.actionPlans('conversation')[0].status).toBe('completed');
    expect(() => journal.transition(batch.id, 'two', 'failed')).toThrow('terminal');
    store.deleteConversation('conversation');
    expect(store.actionPlans('conversation')).toEqual([]);
    const deleted = new DatabaseSync(path);
    expect(deleted.prepare('SELECT COUNT(*) AS count FROM action_journal').get()?.count).toBe(0);
    deleted.close();
  } finally {
    store.close();
    cleanup();
  }
});

test('denial is atomic and cannot be approved or reused; stale and partial outcomes preserve exact statuses', () => {
  const { store, cleanup } = fixture();
  try {
    const journal = store.actionJournal('conversation', 'execution');
    journal.prepare(plan('denied'));
    journal.decision('denied', 'deny');
    journal.finish('denied', 'denied');
    expect(
      journal
        .entries('denied')
        .slice(-3)
        .map((entry) => entry.status),
    ).toEqual(['denied', 'denied', 'denied']);
    expect(() => journal.decision('denied', 'allow-once')).toThrow('approval');
    expect(() => journal.transition('denied', 'one', 'running')).toThrow('terminal');
    journal.prepare(plan('revoked'));
    journal.decision('revoked', 'allow-once');
    journal.decision('revoked', 'deny');
    journal.finish('revoked', 'denied');
    expect(() => journal.transition('revoked', 'one', 'running')).toThrow('terminal');
    journal.prepare(plan('stale'));
    journal.decision('stale', 'allow-once');
    journal.transition('stale', 'one', 'stale', 'Snapshot changed before an effect.');
    journal.transition('stale', 'two', 'skipped');
    journal.transition('stale', 'three', 'skipped');
    journal.finish('stale', 'stale');
    journal.prepare(plan('partial'));
    journal.decision('partial', 'allow-once');
    journal.transition('partial', 'one', 'running');
    journal.transition('partial', 'one', 'succeeded');
    journal.transition('partial', 'two', 'running');
    journal.transition('partial', 'two', 'stale');
    journal.transition('partial', 'three', 'skipped');
    expect(() => journal.finish('partial', 'stale')).toThrow('journal');
    journal.finish('partial', 'partial');
    expect(store.actionPlans('conversation').map((entry) => entry.status)).toEqual([
      'denied',
      'denied',
      'stale',
      'partial',
    ]);
    expect(
      journal
        .entries('partial')
        .slice(-2)
        .map((entry) => entry.status),
    ).toEqual(['stale', 'skipped']);
    journal.prepare(plan('incomplete-effect'));
    journal.decision('incomplete-effect', 'allow-once');
    journal.transition('incomplete-effect', 'one', 'running');
    journal.transition(
      'incomplete-effect',
      'one',
      'failed',
      'partial_effect: A target was created before copying failed.',
    );
    journal.transition('incomplete-effect', 'two', 'skipped');
    journal.transition('incomplete-effect', 'three', 'skipped');
    expect(() => journal.finish('incomplete-effect', 'failed')).toThrow('journal');
    journal.finish('incomplete-effect', 'partial');
  } finally {
    store.close();
    cleanup();
  }
});

test('preparation and a failed durable running insert roll back before any effect can begin', () => {
  const { path, store, cleanup } = fixture();
  try {
    const observer = new DatabaseSync(path);
    observer.exec(
      "CREATE TRIGGER fail_prepare BEFORE INSERT ON action_journal WHEN NEW.action_id='two' BEGIN SELECT RAISE(ABORT,'prepare disk failure'); END;",
    );
    const journal = store.actionJournal('conversation', 'execution');
    expect(() => journal.prepare(plan())).toThrow('prepare disk failure');
    expect(store.actionPlans('conversation')).toEqual([]);
    expect(observer.prepare('SELECT COUNT(*) AS count FROM action_journal').get()?.count).toBe(0);
    observer.exec('DROP TRIGGER fail_prepare');
    journal.prepare(plan());
    journal.decision('plan', 'allow-once');
    observer.exec(
      "CREATE TRIGGER fail_running BEFORE INSERT ON action_journal WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'journal disk failure'); END;",
    );
    let effects = 0;
    expect(() => {
      journal.transition('plan', 'one', 'running');
      effects += 1;
    }).toThrow('journal disk failure');
    expect(effects).toBe(0);
    expect(journal.entries('plan').map((entry) => entry.status)).toEqual([
      'prepared',
      'prepared',
      'prepared',
    ]);
    observer.close();
  } finally {
    store.close();
    cleanup();
  }
});

test('restart recovery preserves succeeded actions and marks running effects unknown without replay or retained approval', () => {
  const fixtureData = fixture();
  let store = fixtureData.store;
  try {
    const journal = store.actionJournal('conversation', 'execution');
    journal.prepare(plan('waiting'));
    journal.prepare(plan('approved'));
    journal.decision('approved', 'allow-once');
    journal.prepare(plan('crashed'));
    journal.decision('crashed', 'allow-once');
    journal.transition('crashed', 'one', 'running');
    journal.transition('crashed', 'one', 'succeeded');
    journal.transition('crashed', 'two', 'running');
    store.close();
    store = new ProsperoStore(fixtureData.path);
    expect(store.actionPlans('conversation').map((entry) => entry.status)).toEqual([
      'prepared',
      'approved',
      'approved',
    ]);
    expect(store.recoverActionPlans()).toBe(3);
    expect(store.recoverActionPlans()).toBe(0);
    const history = store.actionPlans('conversation');
    expect(history.every((entry) => entry.status === 'interrupted')).toBe(true);
    const last = history[2].journal;
    expect(last.filter((entry) => entry.actionId === 'one').at(-1)?.status).toBe('succeeded');
    expect(last.filter((entry) => entry.actionId === 'two').at(-1)).toMatchObject({
      status: 'interrupted',
      detail: expect.stringContaining('may have occurred'),
    });
    expect(last.filter((entry) => entry.actionId === 'three').at(-1)).toMatchObject({
      status: 'interrupted',
      detail: expect.stringContaining('Approval was not retained'),
    });
    const restarted = store.actionJournal('conversation', 'execution');
    expect(() => restarted.decision('crashed', 'allow-once')).toThrow('approval');
    expect(() => restarted.transition('crashed', 'two', 'running')).toThrow('terminal');
  } finally {
    store.close();
    fixtureData.cleanup();
  }
});

test('source-only retention projects bounded provenance, expires in seven days and supports session-only and credential removal', () => {
  const { path, store, cleanup } = fixture();
  try {
    const input = {
      ...source(),
      title: 't'.repeat(600),
      excerpt: 'e'.repeat(1800),
      body: 'FULL_BODY_SENTINEL_NEVER_STORE',
    };
    store.saveSources('conversation', [input]);
    expect(store.sources('conversation')[0]).toEqual({
      id: input.id,
      url: input.url,
      title: 't'.repeat(500),
      kind: 'page',
      retrievedAt: input.retrievedAt,
      contentHash: input.contentHash,
      excerpt: 'e'.repeat(1200),
    });
    store.saveSources('conversation', [source('ephemeral')], 'session');
    expect(store.sources('conversation')).toHaveLength(1);
    expect(() =>
      store.saveSources('conversation', [{ ...source(), url: 'https://other.example/' }]),
    ).toThrow('identity');
    expect(() =>
      store.saveSources('conversation', [
        { ...source('bad'), url: 'https://user:secret@research.example/' },
      ]),
    ).toThrow('provenance');
    store.saveSources('conversation', [
      { ...source('expired'), retrievedAt: Date.now() - SOURCE_RETENTION_MS - 1 },
    ]);
    expect(store.sources('conversation')).toHaveLength(1);
    const observer = new DatabaseSync(path);
    const row = observer.prepare('SELECT payload,expires_at FROM web_sources').get();
    expect(row?.payload).not.toContain('FULL_BODY_SENTINEL');
    expect(row?.expires_at).toBe(input.retrievedAt + SOURCE_RETENTION_MS);
    observer.exec('UPDATE web_sources SET expires_at=0');
    expect(store.sources('conversation')).toEqual([]);
    observer.close();
    store.saveEncryptedCredential('web-search-brave', new Uint8Array([1, 4, 9]));
    store.deleteCredential('web-search-brave');
    expect(store.encryptedCredential('web-search-brave')).toBeUndefined();
    store.close();
    const reopened = new ProsperoStore(path);
    expect(reopened.sources('conversation')).toEqual([]);
    const expiry = new DatabaseSync(path);
    expect(expiry.prepare('SELECT COUNT(*) AS count FROM web_sources').get()?.count).toBe(0);
    expiry.close();
    reopened.saveSources('conversation', [source('clear')]);
    reopened.clearSources('conversation');
    expect(reopened.sources('conversation')).toEqual([]);
    reopened.saveSources('conversation', [source('cascade')]);
    reopened.deleteConversation('conversation');
    expect(reopened.sources('conversation')).toEqual([]);
    reopened.close();
    expect(readFileSync(path).subarray(0, 15).toString()).toBe('SQLite format 3');
  } finally {
    // The store is already closed after testing cleanup on a reopened connection.
    cleanup();
  }
});

test('reading Sources physically deletes expired rows across conversations and startup cleans expiry without a read', () => {
  const data = fixture();
  let store = data.store;
  try {
    store.saveConversation({ id: 'other', title: 'Other task', updatedAt: 1, state: 'completed' });
    store.saveSources('conversation', [source('expired-one')]);
    store.saveSources('other', [source('expired-two')]);
    const observer = new DatabaseSync(data.path);
    try {
      observer.exec('UPDATE web_sources SET expires_at=0');
      expect(observer.prepare('SELECT COUNT(*) AS count FROM web_sources').get()?.count).toBe(2);
      expect(store.sources('conversation')).toEqual([]);
      expect(observer.prepare('SELECT COUNT(*) AS count FROM web_sources').get()?.count).toBe(0);
      store.saveSources('other', [source('startup-expired')]);
      observer.exec('UPDATE web_sources SET expires_at=0');
    } finally {
      observer.close();
    }
    store.close();
    store = new ProsperoStore(data.path);
    const startup = new DatabaseSync(data.path);
    try {
      // Query SQLite directly before sources(): deletion must already have occurred in construction.
      expect(startup.prepare('SELECT COUNT(*) AS count FROM web_sources').get()?.count).toBe(0);
    } finally {
      startup.close();
    }
  } finally {
    store.close();
    data.cleanup();
  }
});
