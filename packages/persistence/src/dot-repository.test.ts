import { describe, expect, test } from 'bun:test';
import { DotError, type Dot, type DotRunChange } from '@prospero/dots';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DotRepositoryError, ProsperoStore } from './index';

type Repository = ReturnType<ProsperoStore['dots']>;
type RepositoryCode = DotRepositoryError['code'];
const processFixture = join(import.meta.dir, 'fixtures', 'dot-repository-process.ts');
const goal = { text: 'Maintain an evolving research brief.' };

async function fixture(
  body: (f: {
    path: string;
    open(): ProsperoStore;
    close(store: ProsperoStore): void;
  }) => unknown | Promise<unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'prospero-dot-repository-'));
  const path = join(dir, 'app.sqlite');
  const stores = new Set<ProsperoStore>();
  try {
    await body({
      path,
      open: () => {
        const store = new ProsperoStore(path);
        stores.add(store);
        return store;
      },
      close: (store) => {
        store.close();
        stores.delete(store);
      },
    });
  } finally {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function inspect<T>(path: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function create(repo: Repository, id = 'dot-1', createdAt = 10): Dot {
  return repo.create({ id, name: 'Researcher', goal, createdAt });
}

function expectRepositoryError(action: () => unknown, code: RepositoryCode) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DotRepositoryError);
    if (!(error instanceof DotRepositoryError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error('Expected a repository error.');
}

function expectDomainError(action: () => unknown, code: DotError['code']) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DotError);
    if (!(error instanceof DotError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error('Expected a domain error.');
}

const legacyV1 = [
  'CREATE TABLE conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);',
  'CREATE TABLE settings (key TEXT PRIMARY KEY,payload TEXT NOT NULL);',
  'CREATE TABLE providers (id TEXT PRIMARY KEY,payload TEXT NOT NULL);',
  'CREATE TABLE credentials (id TEXT PRIMARY KEY,ciphertext BLOB NOT NULL);',
  'CREATE TABLE executions (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,state TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,model_turns INTEGER,tool_calls INTEGER);',
].join('\n');
const legacyV2 = [
  "CREATE TABLE action_plans (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,execution_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','approved','completed','denied','stale','partial','failed','cancelled','interrupted')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);",
  "CREATE TABLE action_journal (plan_id TEXT NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,action_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','stale','denied','cancelled','skipped','interrupted')),at INTEGER NOT NULL,detail TEXT,PRIMARY KEY(plan_id,sequence));",
  'CREATE INDEX action_plans_conversation ON action_plans(conversation_id,created_at);',
  'CREATE INDEX action_journal_latest ON action_journal(plan_id,action_id,sequence);',
  "CREATE TRIGGER action_plan_immutable BEFORE UPDATE OF id,conversation_id,execution_id,payload,created_at ON action_plans BEGIN SELECT RAISE(ABORT,'Action Plan is immutable.'); END;",
  "CREATE TRIGGER action_journal_no_update BEFORE UPDATE ON action_journal BEGIN SELECT RAISE(ABORT,'Action journal is append-only.'); END;",
  "CREATE TRIGGER action_journal_no_direct_delete BEFORE DELETE ON action_journal WHEN EXISTS (SELECT 1 FROM action_plans WHERE id=OLD.plan_id) BEGIN SELECT RAISE(ABORT,'Action journal is append-only.'); END;",
  'CREATE TABLE web_sources (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,id TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,id));',
  'CREATE INDEX web_sources_expiry ON web_sources(expires_at);',
].join('\n');
const legacyConversation = {
  id: 'legacy',
  title: 'Existing history',
  updatedAt: 1,
  state: 'completed',
  messages: [{ role: 'user', content: 'Keep my history' }],
};

function seedLegacy(path: string, version: 1 | 2) {
  inspect(path, (db) => {
    db.exec(legacyV1);
    if (version === 2) db.exec(legacyV2);
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run(
      'legacy',
      legacyConversation.title,
      1,
      'completed',
      JSON.stringify(legacyConversation),
    );
    db.prepare('INSERT INTO settings VALUES (?,?)').run('theme', '"dark"');
    db.prepare('INSERT INTO providers VALUES (?,?)').run(
      'legacy-provider',
      '{"id":"legacy-provider","model":"fake"}',
    );
    db.prepare('INSERT INTO credentials VALUES (?,?)').run(
      'legacy-provider',
      new Uint8Array([9, 8, 7]),
    );
    db.prepare('INSERT INTO executions VALUES (?,?,?,?,?,?,?)').run(
      'legacy-run',
      'legacy',
      'completed',
      10,
      20,
      2,
      1,
    );
    if (version === 2) {
      const plan = {
        id: 'legacy-plan',
        title: 'Keep action history',
        digest: 'legacy-digest',
        createdAt: 10,
        scopeIds: ['legacy-scope'],
        actions: [
          { id: 'action-1', kind: 'create_directory', target: '/fixture', effects: ['file.write'] },
        ],
      };
      db.prepare('INSERT INTO action_plans VALUES (?,?,?,?,?,?,?)').run(
        plan.id,
        'legacy',
        'legacy-run',
        JSON.stringify(plan),
        'completed',
        10,
        20,
      );
      db.prepare('INSERT INTO action_journal VALUES (?,?,?,?,?,?)').run(
        plan.id,
        'action-1',
        1,
        'succeeded',
        20,
        'legacy receipt',
      );
      for (const [id, expiry] of [
        ['expired-source', 0],
        ['retained-source', Number.MAX_SAFE_INTEGER],
      ] as const)
        db.prepare('INSERT INTO web_sources VALUES (?,?,?,?)').run(
          'legacy',
          id,
          JSON.stringify({ id, url: 'https://fixture.example/paper', title: id }),
          expiry,
        );
    }
    db.exec(`PRAGMA user_version=${version}`);
  });
}

function legacyRows(path: string, version: 1 | 2) {
  return inspect(path, (db) => {
    const tables = ['conversations', 'settings', 'providers', 'credentials', 'executions'];
    if (version === 2) tables.push('action_plans', 'action_journal', 'web_sources');
    return Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    );
  });
}

describe('Dot repository schema and existing profile preservation', () => {
  test('fresh v0 database migrates once to v3 without adding future Dot subsystems', async () => {
    await fixture(({ path, open, close }) => {
      const store = open();
      expect(store.dots().list()).toEqual([]);
      expect(inspect(path, (db) => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(3);
      const tables = inspect(path, (db) =>
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dot%' ORDER BY name",
          )
          .all(),
      );
      expect(tables.map((row) => row.name)).toEqual(['dot_runs', 'dots']);
      close(store);
      const reopened = open();
      expect(reopened.dots().list()).toEqual([]);
      expect(inspect(path, (db) => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(3);
    });
  });

  for (const version of [1, 2] as const) {
    test(`v${version} migration preserves old profile records byte-for-byte`, async () => {
      await fixture(({ path, open, close }) => {
        seedLegacy(path, version);
        const before = legacyRows(path, version);
        const store = open();
        expect(legacyRows(path, version)).toEqual(before);
        expect(store.getConversation('legacy')).toEqual(legacyConversation);
        expect(store.providers()).toEqual([{ id: 'legacy-provider', model: 'fake' }]);
        expect([...(store.encryptedCredential('legacy-provider') ?? [])]).toEqual([9, 8, 7]);
        expect(store.executions('legacy')[0].state).toBe('completed');
        expect(store.dots().list()).toEqual([]);
        expect(inspect(path, (db) => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(
          3,
        );
        if (version === 2) {
          expect(store.actionPlans('legacy')[0].journal[0].detail).toBe('legacy receipt');
          // Migration must not remove expired unrelated records. Ordinary v3 startup retains TTL cleanup.
          close(store);
          open();
          const sources = inspect(path, (db) =>
            db.prepare('SELECT id FROM web_sources ORDER BY id').all(),
          );
          expect(sources.map((row) => row.id)).toEqual(['retained-source']);
        }
      });
    });
  }

  test('failed v3 DDL rolls back new tables and indexes while retaining the full v2 profile', async () => {
    await fixture(({ path }) => {
      seedLegacy(path, 2);
      inspect(path, (db) => {
        db.exec('CREATE TABLE dot_runs (sentinel TEXT NOT NULL)');
        db.prepare('INSERT INTO dot_runs VALUES (?)').run('pre-existing unrelated table');
      });
      const before = legacyRows(path, 2);
      const schema = inspect(path, (db) =>
        db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
      );
      expectRepositoryError(() => new ProsperoStore(path), 'storage-failure');
      expect(legacyRows(path, 2)).toEqual(before);
      expect(inspect(path, (db) => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(2);
      expect(
        inspect(path, (db) =>
          db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
        ),
      ).toEqual(schema);
      expect(inspect(path, (db) => db.prepare('SELECT * FROM dot_runs').all())).toEqual([
        { sentinel: 'pre-existing unrelated table' },
      ]);
      expect(
        inspect(path, (db) =>
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('dots','dots_created','dot_runs_in_flight','dot_runs_history')",
            )
            .all(),
        ),
      ).toEqual([]);
    });
  });

  test('newer database versions reject opening and preserve existing Dot rows', async () => {
    await fixture(({ path, open, close }) => {
      const store = open();
      const saved = create(store.dots());
      close(store);
      const before = inspect(path, (db) => db.prepare('SELECT * FROM dots').all());
      inspect(path, (db) => db.exec('PRAGMA user_version=99'));
      expect(() => new ProsperoStore(path)).toThrow('newer Prospero');
      expect(inspect(path, (db) => db.prepare('SELECT * FROM dots').all())).toEqual(before);
      expect(inspect(path, (db) => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(99);
      expect(String(saved.id)).toBe('dot-1');
    });
  });
});

describe('durable Dot and Run reads and domain boundaries', () => {
  test('roundtrip owns frozen snapshots and historical revisions remain valid after later runs and archive', async () => {
    await fixture(({ open, close }) => {
      const store = open();
      const repo = store.dots();
      const input = { id: 'dot-1', name: ' Researcher ', goal: { text: goal.text }, createdAt: 10 };
      const initial = repo.create(input);
      input.goal.text = 'Changed after creation';
      let first = repo.createRun(initial.id, initial.revision, { id: 'run-1', createdAt: 20 });
      first = repo.startRun(initial.id, first.run.id, first.dot.revision, 30);
      first = repo.finishRun(initial.id, first.run.id, first.dot.revision, 'failed', 40);
      expect(first.dot.lifecycle).toBe('active');
      let second = repo.createRun(initial.id, first.dot.revision, { id: 'run-2', createdAt: 50 });
      second = repo.startRun(initial.id, second.run.id, second.dot.revision, 60);
      second = repo.finishRun(initial.id, second.run.id, second.dot.revision, 'succeeded', 70);
      const paused = repo.transition(initial.id, second.dot.revision, 'pause', 80);
      const archived = repo.transition(initial.id, paused.revision, 'archive', 90);
      close(store);
      const read = open().dots();
      expect(read.get(initial.id)).toEqual(archived);
      expect(read.getRun('run-1')).toEqual(first.run);
      expect(read.runs(initial.id)).toEqual([first.run, second.run]);
      expect(first.run.dotRevision).toBeLessThan(archived.revision);
      const restored = read.get(initial.id);
      if (!restored) throw new Error('The persisted Dot is missing.');
      expect(restored.goal.text).toBe(goal.text);
      expect(Object.isFrozen(restored)).toBe(true);
      expect(Object.isFrozen(restored.goal)).toBe(true);
      expect(Object.isFrozen(read.getRun('run-1'))).toBe(true);
      expect(Reflect.set(restored, 'lifecycle', 'active')).toBe(false);
      expect(Reflect.set(restored.goal, 'text', 'Mutated')).toBe(false);
      expect(read.get(initial.id)).toEqual(archived);
      expect(read.list({ includeArchived: false })).toEqual([]);
      expect(read.list()).toEqual([archived]);
    });
  });

  test('the largest legal JSON-escaped goal survives persistence and reopening', async () => {
    await fixture(({ path, open, close }) => {
      const store = open();
      const escapedGoal = '\u0001'.repeat(16_384);
      const saved = store.dots().create({
        id: 'escaped-goal',
        name: 'Researcher',
        goal: { text: escapedGoal },
        createdAt: 10,
      });
      const payload = inspect(path, (db) => db.prepare('SELECT payload FROM dots').get()?.payload);
      expect(typeof payload).toBe('string');
      expect(Buffer.byteLength(String(payload), 'utf8')).toBeGreaterThan(64 * 1024);
      close(store);
      const restored = open().dots().get(saved.id);
      expect(restored).toEqual(saved);
      expect(restored?.goal.text).toBe(escapedGoal);
      expect(Object.isFrozen(restored?.goal)).toBe(true);
    });
  });

  test('queries are ordered, bounded and paginated, including terminal Run history', async () => {
    await fixture(({ open }) => {
      const repo = open().dots();
      create(repo, 'dot-b', 10);
      create(repo, 'dot-a', 10);
      const dot = create(repo, 'dot-c', 20);
      expect(repo.list().map((row) => String(row.id))).toEqual(['dot-a', 'dot-b', 'dot-c']);
      expect(repo.list({ limit: 1, offset: 1 }).map((row) => String(row.id))).toEqual(['dot-b']);
      let pair = repo.createRun(dot.id, dot.revision, { id: 'run-b', createdAt: 20 });
      pair = repo.finishRun(dot.id, pair.run.id, pair.dot.revision, 'cancelled', 20);
      pair = repo.createRun(dot.id, pair.dot.revision, { id: 'run-a', createdAt: 20 });
      pair = repo.finishRun(dot.id, pair.run.id, pair.dot.revision, 'interrupted', 20);
      expect(repo.runs(dot.id).map((row) => String(row.id))).toEqual(['run-a', 'run-b']);
      expect(repo.runs(dot.id, { limit: 1, offset: 1 }).map((row) => String(row.id))).toEqual([
        'run-b',
      ]);
      for (const options of [
        { limit: 0 },
        { limit: 201 },
        { limit: 0.5 },
        { offset: -1 },
        { offset: NaN },
        { limit: null } as unknown as { limit: number },
        { offset: null } as unknown as { offset: number },
        null as unknown as { limit: number },
      ]) {
        expectDomainError(() => repo.list(options), 'invalid-input');
        expectDomainError(() => repo.runs(dot.id, options), 'invalid-input');
      }
    });
  });

  test('missing entities, duplicate identities and domain errors remain distinct', async () => {
    await fixture(({ open }) => {
      const repo = open().dots();
      expect(repo.get('missing')).toBeUndefined();
      expect(repo.getRun('missing')).toBeUndefined();
      expectRepositoryError(() => repo.runs('missing'), 'not-found');
      expectRepositoryError(() => repo.transition('missing', 0, 'pause', 10), 'not-found');
      const initial = create(repo);
      expectRepositoryError(() => create(repo), 'duplicate-id');
      let pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 10 });
      expectDomainError(
        () => repo.transition(initial.id, pair.dot.revision, 'pause', 10),
        'run-in-flight',
      );
      expectDomainError(
        () => repo.createRun(initial.id, pair.dot.revision, { id: 'other-run', createdAt: 10 }),
        'run-in-flight',
      );
      expectDomainError(
        () => repo.finishRun(initial.id, pair.run.id, pair.dot.revision, 'succeeded', 10),
        'invalid-transition',
      );
      pair = repo.finishRun(initial.id, pair.run.id, pair.dot.revision, 'interrupted', 10);
      expectRepositoryError(
        () => repo.createRun(initial.id, pair.dot.revision, { id: 'run-1', createdAt: 10 }),
        'duplicate-id',
      );
      const other = create(repo, 'dot-2');
      expectRepositoryError(
        () => repo.createRun(other.id, other.revision, { id: 'run-1', createdAt: 10 }),
        'duplicate-id',
      );
      expectDomainError(
        () => repo.startRun(other.id, pair.run.id, other.revision, 10),
        'invalid-reference',
      );
      const completed = repo.transition(initial.id, pair.dot.revision, 'complete', 10);
      expectDomainError(
        () => repo.transition(initial.id, completed.revision, 'resume', 10),
        'invalid-transition',
      );
      expectDomainError(
        () => repo.createRun(initial.id, completed.revision, { id: 'new-run', createdAt: 10 }),
        'invalid-transition',
      );
    });
  });

  test('same-time revisions reject stale start and finish without rewriting current snapshots', async () => {
    await fixture(({ open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pending = repo.createRun(initial.id, initial.revision, { id: 'run-1', createdAt: 10 });
      const running = repo.startRun(initial.id, pending.run.id, pending.dot.revision, 10);
      expectRepositoryError(
        () => repo.startRun(initial.id, pending.run.id, pending.dot.revision, 10),
        'conflict',
      );
      expectRepositoryError(
        () => repo.finishRun(initial.id, pending.run.id, pending.dot.revision, 'cancelled', 10),
        'conflict',
      );
      expect(repo.get(initial.id)).toEqual(running.dot);
      expect(repo.getRun(pending.run.id)).toEqual(running.run);
    });
  });
});

describe('database CAS and paired transaction rollback', () => {
  test('two connections holding the same revision cannot both update', async () => {
    await fixture(({ open }) => {
      const first = open().dots();
      const initial = create(first);
      const second = open().dots();
      expect(second.get(initial.id)).toEqual(initial);
      const committed = first.transition(initial.id, initial.revision, 'pause', 20);
      expectRepositoryError(
        () => second.transition(initial.id, initial.revision, 'cancel', 20),
        'conflict',
      );
      expect(second.get(initial.id)).toEqual(committed);
      expect(first.get(initial.id)?.revision).toBe(1);
    });
  });

  test('a competing Run claim leaves exactly one pair and no orphaned in-flight Run', async () => {
    await fixture(({ open }) => {
      const first = open().dots();
      const initial = create(first);
      const second = open().dots();
      const winner = first.createRun(initial.id, 0, { id: 'winner', createdAt: 20 });
      expectRepositoryError(
        () => second.createRun(initial.id, 0, { id: 'loser', createdAt: 20 }),
        'conflict',
      );
      expect(second.get(initial.id)).toEqual(winner.dot);
      expect(second.runs(initial.id)).toEqual([winner.run]);
      expect(second.getRun('loser')).toBeUndefined();
    });
  });

  test('failure in each second-entity write rolls back Dot and Run creation/start/finish', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      inspect(path, (db) =>
        db.exec(
          "CREATE TRIGGER fail_run_insert BEFORE INSERT ON dot_runs BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
        ),
      );
      expectRepositoryError(
        () => repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 }),
        'storage-failure',
      );
      expect(repo.get(initial.id)).toEqual(initial);
      expect(repo.runs(initial.id)).toEqual([]);
      inspect(path, (db) => db.exec('DROP TRIGGER fail_run_insert'));
      const pending = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      inspect(path, (db) =>
        db.exec(
          "CREATE TRIGGER fail_run_start BEFORE UPDATE ON dot_runs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
        ),
      );
      expectRepositoryError(
        () => repo.startRun(initial.id, pending.run.id, pending.dot.revision, 30),
        'storage-failure',
      );
      expect(repo.get(initial.id)).toEqual(pending.dot);
      expect(repo.getRun(pending.run.id)).toEqual(pending.run);
      inspect(path, (db) => db.exec('DROP TRIGGER fail_run_start'));
      const running = repo.startRun(initial.id, pending.run.id, pending.dot.revision, 30);
      inspect(path, (db) =>
        db.exec(
          "CREATE TRIGGER fail_run_finish BEFORE UPDATE ON dot_runs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
        ),
      );
      expectRepositoryError(
        () => repo.finishRun(initial.id, running.run.id, running.dot.revision, 'succeeded', 40),
        'storage-failure',
      );
      expect(repo.get(initial.id)).toEqual(running.dot);
      expect(repo.getRun(running.run.id)).toEqual(running.run);
      expect(repo.runs(initial.id)).toEqual([running.run]);
    });
  });

  test('closed database failures are storage failures rather than missing entities or conflicts', async () => {
    await fixture(({ open, close }) => {
      const store = open();
      const repo = store.dots();
      create(repo);
      close(store);
      expectRepositoryError(() => repo.get('dot-1'), 'storage-failure');
      expectRepositoryError(() => repo.list(), 'storage-failure');
      expectRepositoryError(() => repo.transition('dot-1', 0, 'pause', 20), 'storage-failure');
    });
  });
});

describe('storage corruption and relational constraints fail closed', () => {
  for (const target of ['dot', 'run'] as const) {
    test(`rejects oversized valid JSON ${target} payload before decoding`, async () => {
      await fixture(({ path, open }) => {
        const repo = open().dots();
        const initial = create(repo);
        const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
        const snapshot = target === 'dot' ? pair.dot : pair.run;
        const payload = JSON.stringify(snapshot) + ' '.repeat((target === 'dot' ? 128 : 4) * 1024);
        expect(JSON.parse(payload)).toEqual(snapshot);
        inspect(path, (db) =>
          db
            .prepare(
              target === 'dot' ? 'UPDATE dots SET payload=?' : 'UPDATE dot_runs SET payload=?',
            )
            .run(payload),
        );
        expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
        expectRepositoryError(() => repo.getRun(pair.run.id), 'invalid-stored-state');
        expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
        expectRepositoryError(
          () => repo.startRun(initial.id, pair.run.id, pair.dot.revision, 30),
          'invalid-stored-state',
        );
      });
    });
  }

  for (const corruption of ['createdAt', 'dotRevision', 'updatedAt'] as const) {
    test(`rejects a locally valid current pair with inconsistent ${corruption}`, async () => {
      await fixture(({ path, open }) => {
        const repo = open().dots();
        const initial = create(repo);
        const pending = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
        const pair = repo.startRun(initial.id, pending.run.id, pending.dot.revision, 30);
        const run = {
          ...pair.run,
          ...(corruption === 'createdAt' ? { createdAt: 9 } : {}),
          ...(corruption === 'dotRevision' ? { dotRevision: 1 } : {}),
          ...(corruption === 'updatedAt' ? { updatedAt: 25, startedAt: 25 } : {}),
        };
        inspect(path, (db) =>
          db
            .prepare('UPDATE dot_runs SET dot_revision=?,created_at=?,updated_at=?,payload=?')
            .run(run.dotRevision, run.createdAt, run.updatedAt, JSON.stringify(run)),
        );
        const before = inspect(path, (db) => ({
          dot: db.prepare('SELECT * FROM dots').all(),
          run: db.prepare('SELECT * FROM dot_runs').all(),
        }));
        expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
        expectRepositoryError(() => repo.getRun(run.id), 'invalid-stored-state');
        expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
        expectRepositoryError(
          () => repo.finishRun(initial.id, run.id, pair.dot.revision, 'failed', 40),
          'invalid-stored-state',
        );
        expect(
          inspect(path, (db) => ({
            dot: db.prepare('SELECT * FROM dots').all(),
            run: db.prepare('SELECT * FROM dot_runs').all(),
          })),
        ).toEqual(before);
      });
    });
  }

  test('rejects a terminal historical Run revision ahead of its current Dot', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pending = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      const pair = repo.finishRun(
        initial.id,
        pending.run.id,
        pending.dot.revision,
        'cancelled',
        30,
      );
      const run = { ...pair.run, dotRevision: pair.dot.revision + 1 };
      inspect(path, (db) =>
        db
          .prepare('UPDATE dot_runs SET dot_revision=?,payload=?')
          .run(run.dotRevision, JSON.stringify(run)),
      );
      const before = inspect(path, (db) => db.prepare('SELECT * FROM dot_runs').all());
      expectRepositoryError(() => repo.getRun(run.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
      expectRepositoryError(
        () => repo.finishRun(initial.id, run.id, pair.dot.revision, 'interrupted', 40),
        'invalid-stored-state',
      );
      expect(repo.get(initial.id)).toEqual(pair.dot);
      expect(inspect(path, (db) => db.prepare('SELECT * FROM dot_runs').all())).toEqual(before);
    });
  });

  test('rejects an existing foreign-owner pointer without repairing either pair', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const ownPair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      const other = create(repo, 'dot-2');
      const foreignPair = repo.createRun(other.id, 0, { id: 'foreign-run', createdAt: 20 });
      const dot = { ...ownPair.dot, inFlightRunId: foreignPair.run.id };
      inspect(path, (db) => {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare('UPDATE dots SET in_flight_run_id=?,payload=? WHERE id=?').run(
          foreignPair.run.id,
          JSON.stringify(dot),
          initial.id,
        );
      });
      const before = inspect(path, (db) => ({
        dot: db.prepare('SELECT * FROM dots ORDER BY id').all(),
        run: db.prepare('SELECT * FROM dot_runs ORDER BY id').all(),
      }));
      expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.getRun(ownPair.run.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
      expectRepositoryError(
        () => repo.finishRun(initial.id, ownPair.run.id, ownPair.dot.revision, 'cancelled', 30),
        'invalid-stored-state',
      );
      expect(repo.get(other.id)).toEqual(foreignPair.dot);
      expect(repo.getRun(foreignPair.run.id)).toEqual(foreignPair.run);
      expect(
        inspect(path, (db) => ({
          dot: db.prepare('SELECT * FROM dots ORDER BY id').all(),
          run: db.prepare('SELECT * FROM dot_runs ORDER BY id').all(),
        })),
      ).toEqual(before);
    });
  });

  for (const payload of ['{', '[]', '{"id":"dot-1"}']) {
    test(`rejects corrupt Dot payload ${payload}`, async () => {
      await fixture(({ path, open }) => {
        const repo = open().dots();
        create(repo);
        inspect(path, (db) => db.prepare('UPDATE dots SET payload=?').run(payload));
        expectRepositoryError(() => repo.get('dot-1'), 'invalid-stored-state');
        expectRepositoryError(() => repo.list(), 'invalid-stored-state');
        expectRepositoryError(
          () => repo.transition('dot-1', 0, 'pause', 20),
          'invalid-stored-state',
        );
      });
    });
  }

  for (const target of ['dot', 'run'] as const) {
    test(`rejects ${target} column/payload mismatches before writes`, async () => {
      await fixture(({ path, open }) => {
        const repo = open().dots();
        const initial = create(repo);
        const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
        inspect(path, (db) => {
          db.exec(
            target === 'dot'
              ? 'UPDATE dots SET revision=revision+1'
              : 'UPDATE dot_runs SET dot_revision=dot_revision+1',
          );
        });
        expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
        expectRepositoryError(() => repo.getRun(pair.run.id), 'invalid-stored-state');
        expectRepositoryError(
          () => repo.startRun(initial.id, pair.run.id, pair.dot.revision, 30),
          'invalid-stored-state',
        );
      });
    });
  }

  test('rejects corrupt Run payload and refuses historical query output', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      inspect(path, (db) => db.prepare('UPDATE dot_runs SET payload=?').run('null'));
      expectRepositoryError(() => repo.getRun(pair.run.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
    });
  });

  test('missing pointed Run is detected without clearing the saved pointer', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      inspect(path, (db) => {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare('DELETE FROM dot_runs WHERE id=?').run(pair.run.id);
      });
      const before = inspect(path, (db) => db.prepare('SELECT * FROM dots').all());
      expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.runs(initial.id), 'invalid-stored-state');
      expect(inspect(path, (db) => db.prepare('SELECT * FROM dots').all())).toEqual(before);
    });
  });

  test('orphaned in-flight Run is detected even when the Dot payload agrees with its empty pointer column', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      const withoutPointer = { ...pair.dot };
      delete (withoutPointer as { inFlightRunId?: string }).inFlightRunId;
      inspect(path, (db) =>
        db
          .prepare('UPDATE dots SET in_flight_run_id=NULL,payload=?')
          .run(JSON.stringify(withoutPointer)),
      );
      expectRepositoryError(() => repo.get(initial.id), 'invalid-stored-state');
      expectRepositoryError(() => repo.getRun(pair.run.id), 'invalid-stored-state');
    });
  });

  test('SQL foreign keys and partial uniqueness forbid foreign owners and a second in-flight Run', async () => {
    await fixture(({ path, open }) => {
      const repo = open().dots();
      const initial = create(repo);
      const pair = repo.createRun(initial.id, 0, { id: 'run-1', createdAt: 20 });
      inspect(path, (db) => {
        db.exec('PRAGMA foreign_keys=ON');
        const insert = db.prepare(
          'INSERT INTO dot_runs(id,dot_id,dot_revision,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?)',
        );
        expect(() =>
          insert.run(
            'run-2',
            initial.id,
            1,
            'pending',
            20,
            20,
            JSON.stringify({ ...pair.run, id: 'run-2' }),
          ),
        ).toThrow();
        expect(() =>
          insert.run(
            'foreign-run',
            'missing-dot',
            1,
            'pending',
            20,
            20,
            JSON.stringify({ ...pair.run, id: 'foreign-run', dotId: 'missing-dot' }),
          ),
        ).toThrow();
        expect(() =>
          db
            .prepare('UPDATE dots SET in_flight_run_id=? WHERE id=?')
            .run('missing-run', initial.id),
        ).toThrow();
      });
      expect(repo.get(initial.id)).toEqual(pair.dot);
      expect(repo.runs(initial.id)).toEqual([pair.run]);
    });
  });
});

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending) yield pending;
  } finally {
    reader.releaseLock();
  }
}

describe('independent process durability without startup recovery', () => {
  test('exit during the second entity write rolls back the uncommitted pair', async () => {
    await fixture(({ path, open, close }) => {
      const store = open();
      const initial = create(store.dots(), 'dot-child');
      close(store);
      const before = inspect(path, (db) => ({
        dot: db.prepare('SELECT * FROM dots').all(),
        run: db.prepare('SELECT * FROM dot_runs').all(),
      }));
      const crashed = Bun.spawnSync(
        [process.execPath, processFixture, 'crash-before-commit', path],
        { env: {}, timeout: 5000 },
      );
      expect({ code: crashed.exitCode, error: crashed.stderr.toString() }).toEqual({
        code: 24,
        error: '',
      });
      expect(JSON.parse(crashed.stdout.toString())).toEqual({ stagedRevision: 1, runCount: 0 });
      const read = Bun.spawnSync([process.execPath, processFixture, 'read', path], {
        env: {},
        timeout: 5000,
      });
      expect({ code: read.exitCode, error: read.stderr.toString() }).toEqual({
        code: 0,
        error: '',
      });
      expect(JSON.parse(read.stdout.toString())).toEqual({
        dot: initial,
        history: [],
        frozen: true,
      });
      expect(
        inspect(path, (db) => ({
          dot: db.prepare('SELECT * FROM dots').all(),
          run: db.prepare('SELECT * FROM dot_runs').all(),
        })),
      ).toEqual(before);
    });
  });

  for (const status of ['pending', 'running'] as const) {
    test(`committed ${status} survives process exit and reads remain unchanged`, async () => {
      await fixture(({ path }) => {
        const written = Bun.spawnSync([process.execPath, processFixture, 'write', path, status], {
          env: {},
          timeout: 5000,
        });
        expect({ code: written.exitCode, error: written.stderr.toString() }).toEqual({
          code: 23,
          error: '',
        });
        const pair = JSON.parse(written.stdout.toString()) as DotRunChange;
        const before = inspect(path, (db) => ({
          dot: db.prepare('SELECT * FROM dots').all(),
          run: db.prepare('SELECT * FROM dot_runs').all(),
        }));
        const read = Bun.spawnSync([process.execPath, processFixture, 'read', path], {
          env: {},
          timeout: 5000,
        });
        expect({ code: read.exitCode, error: read.stderr.toString() }).toEqual({
          code: 0,
          error: '',
        });
        const restored = JSON.parse(read.stdout.toString());
        expect(restored).toEqual({ ...pair, history: [pair.run], frozen: true });
        expect(restored.run.status).toBe(status);
        expect(restored.run.finishedAt).toBeUndefined();
        expect(restored.dot.inFlightRunId).toBe(pair.run.id);
        expect(
          inspect(path, (db) => ({
            dot: db.prepare('SELECT * FROM dots').all(),
            run: db.prepare('SELECT * FROM dot_runs').all(),
          })),
        ).toEqual(before);
      });
    });
  }

  test('barrier-synchronized processes with revision N produce one N+1 and one conflict', async () => {
    await fixture(async ({ path, open, close }) => {
      const store = open();
      create(store.dots(), 'shared');
      close(store);
      const children = [0, 1].map(() =>
        Bun.spawn([process.execPath, processFixture, 'cas', path], {
          env: {},
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      const timers = children.map((child) => setTimeout(() => child.kill(), 8000));
      const outputs = children.map((child) => lines(child.stdout));
      const errors = children.map((child) => new Response(child.stderr).text());
      try {
        const ready = await Promise.all(
          outputs.map(async (output) => JSON.parse((await output.next()).value ?? '')),
        );
        expect(ready).toEqual([
          { ready: true, revision: 0 },
          { ready: true, revision: 0 },
        ]);
        for (const child of children) {
          child.stdin.write('go');
          child.stdin.end();
        }
        const outcomes = await Promise.all(
          outputs.map(async (output) => JSON.parse((await output.next()).value ?? '')),
        );
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['error', 'success']);
        expect(outcomes.find((outcome) => outcome.kind === 'error').code).toBe('conflict');
        expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
        expect(await Promise.all(errors)).toEqual(['', '']);
        const dot = open().dots().get('shared');
        expect(dot?.lifecycle).toBe('paused');
        expect(dot?.revision).toBe(1);
      } finally {
        for (const timer of timers) clearTimeout(timer);
        for (const child of children) child.kill();
        await Promise.all(children.map((child) => child.exited));
      }
    });
  }, 15000);
});
