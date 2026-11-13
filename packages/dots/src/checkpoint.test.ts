import { expect, test } from 'bun:test';
import { createDot, createDotRun, startDotRun, finishDotRun } from './domain';
import { createDotCheckpoint, rehydrateDotCheckpoint } from './checkpoint';

function succeeded(id = 'dot-1', runId = 'run-1') {
  const dot = createDot({ id, name: 'Research', goal: { text: 'Maintain a brief' }, createdAt: 1 });
  const pending = createDotRun(dot, { id: runId, createdAt: 2 });
  const started = startDotRun(pending.dot, pending.run, 3);
  const run = finishDotRun(started.dot, started.run, 'succeeded', 4).run;
  if (run.status !== 'succeeded') throw new Error('Invalid success fixture.');
  return run;
}
const input = () => ({
  summary: 'First verified brief.',
  completed: ['Read the first source'],
  next: ['Compare the next source'],
});

test('checkpoint records a successful Run and owns deeply frozen continuation notes', () => {
  const draft = input();
  const checkpoint = createDotCheckpoint(succeeded(), undefined, draft);
  draft.completed[0] = 'mutated';
  draft.next.push('mutated');
  expect(checkpoint.completed).toEqual(['Read the first source']);
  expect(checkpoint.next).toEqual(['Compare the next source']);
  expect(checkpoint.revision).toBe(1);
  expect(checkpoint.updatedAt).toBe(4);
  expect(Object.isFrozen(checkpoint)).toBe(true);
  expect(Object.isFrozen(checkpoint.completed)).toBe(true);
  expect(Object.isFrozen(checkpoint.next)).toBe(true);
  expect(rehydrateDotCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
});

test('a checkpoint cannot be replayed for the same Run or transferred to another Dot', () => {
  const run = succeeded();
  const previous = createDotCheckpoint(run, undefined, input());
  expect(() => createDotCheckpoint(run, previous, input())).toThrow();
  expect(() => createDotCheckpoint(succeeded('other', 'other-run'), previous, input())).toThrow();
  const next = createDotCheckpoint(succeeded('dot-1', 'run-2'), previous, input());
  expect(next.revision).toBe(2);
});

test('checkpoint refuses unsuccessful Runs and unsafe revisions', () => {
  const run = succeeded();
  expect(() => createDotCheckpoint({ ...run, status: 'failed' }, undefined, input())).toThrow();
  const checkpoint = createDotCheckpoint(run, undefined, input());
  expect(() =>
    createDotCheckpoint(
      succeeded('dot-1', 'run-2'),
      { ...checkpoint, revision: Number.MAX_SAFE_INTEGER },
      input(),
    ),
  ).toThrow();
});

test('stored checkpoints reject unrecognised fields, accessors and sparse notes without executing getters', () => {
  const checkpoint = createDotCheckpoint(succeeded(), undefined, input());
  let invoked = false;
  const getter = { ...checkpoint };
  Object.defineProperty(getter, 'summary', {
    enumerable: true,
    get() {
      invoked = true;
      return 'Untrusted';
    },
  });
  for (const corrupt of [
    { ...checkpoint, extra: {} },
    getter,
    { ...checkpoint, completed: new Array(1) },
    { ...checkpoint, next: [''] },
    { ...checkpoint, revision: 0 },
    { ...checkpoint, updatedAt: -1 },
    Object.assign(Object.create({ inherited: true }), checkpoint),
  ])
    expect(() => rehydrateDotCheckpoint(corrupt)).toThrow();
  expect(invoked).toBe(false);
});

test('UTF-8 size bound applies even when each individual note fits its character limit', () => {
  expect(() =>
    createDotCheckpoint(succeeded(), undefined, {
      summary: '界'.repeat(16384),
      completed: Array(20).fill('界'.repeat(1024)),
      next: [],
    }),
  ).toThrow();
});
