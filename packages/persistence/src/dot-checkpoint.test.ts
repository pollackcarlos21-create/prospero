import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore, DotRepositoryError, SCHEMA_VERSION } from './index';

function fixture(body: (path: string, store: ProsperoStore, inspect: DatabaseSync) => void) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-checkpoint-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const inspect = new DatabaseSync(path);
  try {
    body(path, store, inspect);
  } finally {
    inspect.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const input = { summary: 'Current brief', completed: ['Read source A'], next: ['Read source B'] };
function running(store: ProsperoStore) {
  const repo = store.dots();
  const dot = repo.create({
    id: 'research',
    name: 'Research',
    goal: { text: 'Keep a brief' },
    createdAt: 1,
  });
  const pending = repo.createRun(dot.id, dot.revision, { id: 'run-a', createdAt: 2 });
  return repo.startRun(dot.id, pending.run.id, pending.dot.revision, 3);
}

test('checkpoint commits with its successful Run and retains ordered history across later Runs', () => {
  fixture((_path, store) => {
    const repo = store.dots();
    const current = running(store);
    expect(repo.checkpoint(current.dot.id)).toBeUndefined();
    const first = repo.finishRunWithCheckpoint(
      current.dot.id,
      current.run.id,
      current.dot.revision,
      input,
      4,
    );
    const previous = repo.checkpoint(current.dot.id);
    if (!previous) throw new Error('Checkpoint was not committed.');
    expect(previous).toMatchObject({
      ...input,
      revision: 1,
      dotId: current.dot.id,
      runId: current.run.id,
      updatedAt: 4,
    });
    const pending = repo.createRun(first.dot.id, first.dot.revision, { id: 'run-b', createdAt: 5 });
    const second = repo.startRun(pending.dot.id, pending.run.id, pending.dot.revision, 6);
    repo.finishRunWithCheckpoint(
      second.dot.id,
      second.run.id,
      second.dot.revision,
      { ...input, summary: 'Brief continues from source A' },
      7,
    );
    const latest = repo.checkpoint('research');
    if (!latest) throw new Error('The second checkpoint was not committed.');
    expect(latest).toMatchObject({ runId: second.run.id, revision: 2 });
    expect(repo.checkpoints('research')).toHaveLength(2);
    expect(repo.checkpoints('research')[0]).toEqual(previous);
    expect(repo.checkpoints('research', { limit: 1, offset: 1 })).toEqual([latest]);
    expect(repo.getRun(current.run.id)).toEqual(first.run);
    expect(repo.get('research')?.lifecycle).toBe('active');
  });
});

test('checkpoint insert failure rolls back both the terminal Run and Dot release', () => {
  fixture((_path, store, inspect) => {
    const current = running(store);
    inspect.exec(
      "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON dot_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      store
        .dots()
        .finishRunWithCheckpoint(current.dot.id, current.run.id, current.dot.revision, input, 4),
    ).toThrow(DotRepositoryError);
    expect(store.dots().get(current.dot.id)).toEqual(current.dot);
    expect(store.dots().getRun(current.run.id)).toEqual(current.run);
    expect(store.dots().checkpoint(current.dot.id)).toBeUndefined();
  });
});

test('invalid continuation input and stale revision cannot finish or replace a Run', () => {
  fixture((_path, store) => {
    const current = running(store);
    const repo = store.dots();
    expect(() =>
      repo.finishRunWithCheckpoint(
        current.dot.id,
        current.run.id,
        current.dot.revision,
        { ...input, summary: '' },
        4,
      ),
    ).toThrow();
    expect(repo.get(current.dot.id)).toEqual(current.dot);
    const result = repo.finishRunWithCheckpoint(
      current.dot.id,
      current.run.id,
      current.dot.revision,
      input,
      4,
    );
    const saved = repo.checkpoint(current.dot.id);
    expect(() =>
      repo.finishRunWithCheckpoint(current.dot.id, current.run.id, current.dot.revision, input, 5),
    ).toThrow(DotRepositoryError);
    expect(repo.get(current.dot.id)).toEqual(result.dot);
    expect(repo.checkpoint(current.dot.id)).toEqual(saved);
  });
});

test('finishing a later Run cannot make a previously corrupt future checkpoint valid', () => {
  fixture((_path, store, inspect) => {
    const repo = store.dots();
    const first = running(store);
    const finished = repo.finishRunWithCheckpoint(
      first.dot.id,
      first.run.id,
      first.dot.revision,
      input,
      4,
    );
    const pending = repo.createRun(first.dot.id, finished.dot.revision, {
      id: 'run-b',
      createdAt: 5,
    });
    const current = repo.startRun(pending.dot.id, pending.run.id, pending.dot.revision, 6);
    const runRow = inspect.prepare('SELECT payload FROM dot_runs WHERE id=?').get('run-a');
    const checkpointRow = inspect.prepare('SELECT payload FROM dot_checkpoints').get();
    if (typeof runRow?.payload !== 'string' || typeof checkpointRow?.payload !== 'string')
      throw new Error('Invalid fixture.');
    const oldRun = JSON.parse(runRow.payload);
    const oldCheckpoint = JSON.parse(checkpointRow.payload);
    oldRun.updatedAt = oldRun.finishedAt = oldCheckpoint.updatedAt = 20;
    inspect
      .prepare('UPDATE dot_runs SET updated_at=20,payload=? WHERE id=?')
      .run(JSON.stringify(oldRun), 'run-a');
    inspect
      .prepare('UPDATE dot_checkpoints SET updated_at=20,payload=?')
      .run(JSON.stringify(oldCheckpoint));
    expect(() => repo.checkpoint(first.dot.id)).toThrow(DotRepositoryError);
    expect(() =>
      repo.finishRunWithCheckpoint(current.dot.id, current.run.id, current.dot.revision, input, 30),
    ).toThrow(DotRepositoryError);
    expect(repo.get(current.dot.id)).toEqual(current.dot);
    expect(repo.getRun(current.run.id)).toEqual(current.run);
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM dot_checkpoints').get()?.n).toBe(1);
  });
});

for (const mutation of [
  "UPDATE dot_checkpoints SET payload='invalid JSON'",
  'UPDATE dot_checkpoints SET revision=revision+1',
  'UPDATE dot_checkpoints SET updated_at=updated_at+1',
  "UPDATE dot_checkpoints SET run_id='missing',payload=replace(payload,'run-a','missing')",
])
  test(`stored checkpoint corruption is rejected: ${mutation}`, () => {
    fixture((_path, store, inspect) => {
      const current = running(store);
      store
        .dots()
        .finishRunWithCheckpoint(current.dot.id, current.run.id, current.dot.revision, input, 4);
      if (mutation.includes("run_id='missing'")) {
        expect(() => inspect.exec(mutation)).toThrow();
        // Test-only corruption after proving the normal SQL foreign-key guard rejects it.
        inspect.exec('PRAGMA foreign_keys=OFF');
      }
      inspect.exec(mutation);
      expect(() => store.dots().checkpoint(current.dot.id)).toThrow(DotRepositoryError);
      expect(() => store.dots().checkpoints(current.dot.id)).toThrow(DotRepositoryError);
    });
  });

test('v3 migration preserves Dot/Run rows, expired sources and old settings without recovery', () => {
  fixture((path, store, inspect) => {
    const current = running(store);
    store.setSetting('private-marker', { keep: true });
    store.saveConversation({ id: 'legacy', title: 'Legacy', updatedAt: 1, state: 'completed' });
    inspect
      .prepare('INSERT INTO web_sources VALUES (?,?,?,?)')
      .run('legacy', 'expired', '{"id":"expired"}', 0);
    inspect.exec(
      'DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; DROP TABLE dot_policy_approvals; DROP TABLE dot_policy_usage; DROP TABLE dot_policies; DROP TABLE dot_intent_events; DROP TABLE dot_intents; DROP TABLE dot_checkpoints; PRAGMA user_version=3;',
    );
    const before = inspect.prepare('SELECT * FROM dot_runs').all();
    const sources = inspect.prepare('SELECT * FROM web_sources').all();
    const reopened = new ProsperoStore(path);
    try {
      expect(reopened.dots().get(current.dot.id)).toEqual(current.dot);
      expect(reopened.dots().getRun(current.run.id)).toEqual(current.run);
      expect(reopened.dots().checkpoint(current.dot.id)).toBeUndefined();
      expect(reopened.getSetting<unknown>('private-marker', null)).toEqual({ keep: true });
      expect(inspect.prepare('SELECT * FROM dot_runs').all()).toEqual(before);
      expect(inspect.prepare('SELECT * FROM web_sources').all()).toEqual(sources);
      expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });
});

test('v4 DDL failure leaves the v3 schema, data and colliding table intact', () => {
  fixture((path, store, inspect) => {
    const current = running(store);
    inspect.exec(
      "DROP TABLE dot_checkpoints; CREATE TABLE dot_checkpoints (sentinel TEXT); INSERT INTO dot_checkpoints VALUES('keep'); PRAGMA user_version=3;",
    );
    const before = inspect.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => new ProsperoStore(path)).toThrow(DotRepositoryError);
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    expect(inspect.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before,
    );
    expect(inspect.prepare('SELECT sentinel FROM dot_checkpoints').get()?.sentinel).toBe('keep');
    expect(store.dots().get(current.dot.id)).toEqual(current.dot);
  });
});

test('committed checkpoint survives an independent process exit without closing its store', () => {
  fixture((path, _store) => {
    const child = join(import.meta.dir, 'fixtures', 'dot-repository-process.ts');
    const written = Bun.spawnSync([process.execPath, child, 'checkpoint-write', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ code: written.exitCode, error: written.stderr.toString() }).toEqual({
      code: 23,
      error: '',
    });
    const read = Bun.spawnSync([process.execPath, child, 'checkpoint-read', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ code: read.exitCode, error: read.stderr.toString() }).toEqual({ code: 0, error: '' });
    const value = JSON.parse(read.stdout.toString());
    expect(value.checkpoint).toMatchObject({
      revision: 1,
      summary: 'A durable research brief.',
      completed: ['Compared source A'],
      next: ['Read source B'],
    });
    expect(value.history).toEqual([value.checkpoint]);
    expect(value.frozen).toBe(true);
  });
});
