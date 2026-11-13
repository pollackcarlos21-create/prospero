import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProsperoStore, DotRepositoryError } from './index';

function fixture(body: (store: ProsperoStore, inspect: (sql: string) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-recovery-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const inspection = new DatabaseSync(path);
  try {
    body(store, (sql) => inspection.exec(sql));
  } finally {
    inspection.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(store: ProsperoStore, id: string, running = false) {
  const repo = store.dots();
  const dot = repo.create({
    id,
    name: id,
    goal: { text: 'Keep a durable research brief.' },
    createdAt: 10,
  });
  const pending = repo.createRun(id, dot.revision, { id: `run-${id}`, createdAt: 20 });
  return running ? repo.startRun(id, pending.run.id, pending.dot.revision, 30) : pending;
}

test('startup recovery requires exclusive ownership and never changes a live owner pair', () => {
  fixture((store) => {
    const pair = seed(store, 'live', true);
    try {
      store.dots().recoverInFlight(40, () => false);
      throw new Error('Recovery should require ownership.');
    } catch (error) {
      expect(error).toBeInstanceOf(DotRepositoryError);
      expect((error as DotRepositoryError).code).toBe('ownership-required');
    }
    expect(store.dots().get('live')).toEqual(pair.dot);
    expect(store.dots().getRun(pair.run.id)).toEqual(pair.run);
  });
});

test('bounded recovery atomically interrupts pending/running pairs and preserves terminal history', () => {
  fixture((store) => {
    const repo = store.dots();
    const pending = seed(store, 'a');
    const running = seed(store, 'b', true);
    const historic = repo.finishRun('b', running.run.id, running.dot.revision, 'succeeded', 35);
    const current = repo.createRun('b', historic.dot.revision, { id: 'new-run-b', createdAt: 36 });
    const active = repo.startRun('b', current.run.id, current.dot.revision, 37);
    expect(repo.get('a')).toEqual(pending.dot);
    const first = repo.recoverInFlight(40, () => true, 1);
    expect(first.map((pair) => String(pair.dot.id))).toEqual(['a']);
    expect(repo.get('b')).toEqual(active.dot);
    const second = repo.recoverInFlight(40, () => true);
    expect(second.map((pair) => String(pair.dot.id))).toEqual(['b']);
    for (const [previous, recovered] of [
      [pending, first[0]],
      [active, second[0]],
    ] as const) {
      expect(recovered.dot.lifecycle).toBe(previous.dot.lifecycle);
      expect(recovered.dot.goal).toEqual(previous.dot.goal);
      expect(recovered.dot.revision).toBe(previous.dot.revision + 1);
      expect(recovered.dot.inFlightRunId).toBeUndefined();
      expect(recovered.run.status).toBe('interrupted');
      expect(recovered.run.dotRevision).toBe(recovered.dot.revision);
      expect(Object.isFrozen(recovered.run)).toBe(true);
    }
    expect(Object.isFrozen(second)).toBe(true);
    expect(repo.getRun(historic.run.id)).toEqual(historic.run);
    expect(repo.recoverInFlight(50, () => true)).toEqual([]);
    expect(repo.get('b')).toEqual(second[0].dot);
  });
});

test('a backwards wall clock preserves valid timestamps and cannot restart the interrupted run', () => {
  fixture((store) => {
    const pair = seed(store, 'clock', true);
    const [recovered] = store.dots().recoverInFlight(1, () => true);
    expect(recovered.run.updatedAt).toBe(pair.run.updatedAt);
    expect(recovered.run.finishedAt).toBe(pair.run.updatedAt);
    expect(() => store.dots().startRun('clock', pair.run.id, recovered.dot.revision, 50)).toThrow();
    expect(store.dots().get('clock')).toEqual(recovered.dot);
  });
});

test('losing ownership after the pair write rolls the entire recovery transaction back', () => {
  fixture((store) => {
    const pair = seed(store, 'lease', true);
    let checks = 0;
    expect(() => store.dots().recoverInFlight(40, () => ++checks < 3)).toThrow(DotRepositoryError);
    expect(checks).toBe(3);
    expect(store.dots().get('lease')).toEqual(pair.dot);
    expect(store.dots().getRun(pair.run.id)).toEqual(pair.run);
  });
});

test('failure while saving the second pair rolls back every earlier recovery in the batch', () => {
  fixture((store, inspect) => {
    const first = seed(store, 'a');
    const second = seed(store, 'b', true);
    inspect(
      "CREATE TRIGGER fail_recovery BEFORE UPDATE ON dot_runs WHEN NEW.dot_id='b' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() => store.dots().recoverInFlight(40, () => true)).toThrow(DotRepositoryError);
    expect(store.dots().get('a')).toEqual(first.dot);
    expect(store.dots().getRun(first.run.id)).toEqual(first.run);
    expect(store.dots().get('b')).toEqual(second.dot);
    expect(store.dots().getRun(second.run.id)).toEqual(second.run);
  });
});

test('corrupt state is refused without repairing rows or committing an earlier batch member', () => {
  fixture((store, inspect) => {
    const first = seed(store, 'a');
    seed(store, 'b');
    inspect("UPDATE dot_runs SET payload='invalid JSON' WHERE dot_id='b'");
    expect(() => store.dots().recoverInFlight(40, () => true)).toThrow(DotRepositoryError);
    expect(store.dots().get('a')).toEqual(first.dot);
    expect(store.dots().getRun(first.run.id)).toEqual(first.run);
    expect(() => store.dots().get('b')).toThrow(DotRepositoryError);
  });
});
