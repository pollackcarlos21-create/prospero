import { describe, expect, test } from 'bun:test';
import {
  archiveDot,
  cancelDot,
  completeDot,
  createDot,
  createDotRun,
  DotError,
  finishDotRun,
  pauseDot,
  resumeDot,
  startDotRun,
  type Dot,
  type DotRun,
} from '@prospero/dots';

function dot(id = 'dot-1') {
  return createDot({
    id,
    name: 'Researcher',
    goal: { text: 'Maintain an evolving research brief.' },
    createdAt: 10,
  });
}

function expectDotError(action: () => unknown, code?: DotError['code']): DotError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DotError);
    if (!(error instanceof DotError)) throw error;
    if (code) expect(error.code).toBe(code);
    return error;
  }
  throw new Error('Expected the domain operation to reject.');
}

const lifecycleCommands = [
  { name: 'pause', command: pauseDot, target: 'paused', from: ['active'] },
  { name: 'resume', command: resumeDot, target: 'active', from: ['paused'] },
  { name: 'complete', command: completeDot, target: 'completed', from: ['active', 'paused'] },
  { name: 'cancel', command: cancelDot, target: 'cancelled', from: ['active', 'paused'] },
  {
    name: 'archive',
    command: archiveDot,
    target: 'archived',
    from: ['active', 'paused', 'completed', 'cancelled'],
  },
] as const;

const lifecycles: Dot['lifecycle'][] = ['active', 'paused', 'completed', 'cancelled', 'archived'];

function dotWithLifecycle(lifecycle: Dot['lifecycle']): Dot {
  const initial = dot();
  switch (lifecycle) {
    case 'active':
      return initial;
    case 'paused':
      return pauseDot(initial, 10);
    case 'completed':
      return completeDot(initial, 10);
    case 'cancelled':
      return cancelDot(initial, 10);
    case 'archived':
      return archiveDot(initial, 10);
  }
}

const runStatuses: DotRun['status'][] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];
const runOutcomes = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const;

function runWithStatus(status: DotRun['status']) {
  const pending = createDotRun(dot(), { id: 'run-1', createdAt: 10 });
  if (status === 'pending') return pending;
  const running = startDotRun(pending.dot, pending.run, 20);
  return status === 'running' ? running : finishDotRun(running.dot, running.run, status, 30);
}

describe('Dot creation and input boundaries', () => {
  test('creation normalizes user text and owns an immutable, independent goal', () => {
    const input = {
      id: 'dot_Research-1',
      name: '  Researcher  ',
      goal: { text: '  Maintain an evolving research brief.  ' },
      createdAt: 0,
    };
    const before = structuredClone(input);
    const created = createDot(input);
    expect(String(created.id)).toBe(input.id);
    expect(created).toEqual({
      id: created.id,
      name: 'Researcher',
      goal: { text: 'Maintain an evolving research brief.' },
      lifecycle: 'active',
      createdAt: 0,
      updatedAt: 0,
      revision: 0,
    });
    expect(input).toEqual(before);
    expect(created.goal).not.toBe(input.goal);
    input.goal.text = 'A different goal';
    expect(created.goal.text).toBe('Maintain an evolving research brief.');
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.goal)).toBe(true);
    expect(Reflect.set(created, 'lifecycle', 'completed')).toBe(false);
    expect(Reflect.set(created.goal, 'text', 'Changed')).toBe(false);
  });

  test('accepts the exact ID, name, goal code-unit and timestamp limits', () => {
    const created = createDot({
      id: 'a'.repeat(128),
      name: ` ${'n'.repeat(120)} `,
      goal: { text: ` ${'📄'.repeat(8192)} ` },
      createdAt: Number.MAX_SAFE_INTEGER,
    });
    expect(created.id.length).toBe(128);
    expect(created.name.length).toBe(120);
    expect(created.goal.text.length).toBe(16384);
    expect(created.updatedAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects missing, oversized and unsafe IDs for both entities', () => {
    for (const id of ['', ' ', 'a'.repeat(129), 'a/b', 'a.b', 'a\0b', '研究']) {
      expectDotError(
        () => createDot({ id, name: 'Name', goal: { text: 'Goal' }, createdAt: 0 }),
        'invalid-input',
      );
      expectDotError(() => createDotRun(dot(), { id, createdAt: 10 }), 'invalid-input');
    }
  });

  test('rejects blank and oversized normalized names and goals', () => {
    for (const name of ['', ' \t\n ', 'n'.repeat(121)])
      expectDotError(
        () => createDot({ id: 'dot', name, goal: { text: 'Goal' }, createdAt: 0 }),
        'invalid-input',
      );
    for (const text of ['', ' \t\n ', 'g'.repeat(16385), '📄'.repeat(8193)])
      expectDotError(
        () => createDot({ id: 'dot', name: 'Name', goal: { text }, createdAt: 0 }),
        'invalid-input',
      );
  });

  test('rejects non-integer and unsafe timestamps at creation and transition boundaries', () => {
    for (const at of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expectDotError(
        () => createDot({ id: 'dot', name: 'Name', goal: { text: 'Goal' }, createdAt: at }),
        'invalid-input',
      );
      expectDotError(() => pauseDot(dot(), at), 'invalid-input');
      expectDotError(() => createDotRun(dot(), { id: 'run', createdAt: at }), 'invalid-input');
      const pending = runWithStatus('pending');
      expectDotError(() => startDotRun(pending.dot, pending.run, at), 'invalid-input');
      const running = runWithStatus('running');
      expectDotError(
        () => finishDotRun(running.dot, running.run, 'succeeded', at),
        'invalid-input',
      );
    }
  });

  test('input failures use domain errors without echoing the rejected content', () => {
    const secret = 'PRIVATE_INPUT_SHOULD_NOT_APPEAR';
    const badId = expectDotError(
      () => createDot({ id: `${secret}/`, name: 'Name', goal: { text: 'Goal' }, createdAt: 0 }),
      'invalid-input',
    );
    const badGoal = expectDotError(
      () =>
        createDot({ id: 'dot', name: 'Name', goal: { text: secret.repeat(1000) }, createdAt: 0 }),
      'invalid-input',
    );
    expect(badId.message).not.toContain(secret);
    expect(badGoal.message).not.toContain(secret);
    expect(badId.message).toBe(badGoal.message);
  });
});

describe('complete Dot lifecycle transition matrix', () => {
  for (const lifecycle of lifecycles) {
    for (const { name, command, target, from } of lifecycleCommands) {
      test(`${lifecycle} -> ${name}`, () => {
        const source = dotWithLifecycle(lifecycle);
        const before = structuredClone(source);
        if ((from as readonly string[]).includes(lifecycle)) {
          const updated = command(source, 20);
          expect(updated.lifecycle).toBe(target);
          expect(updated.id).toBe(source.id);
          expect(updated.name).toBe(source.name);
          expect(updated.goal).toEqual(source.goal);
          expect(updated.createdAt).toBe(source.createdAt);
          expect(updated.updatedAt).toBe(20);
          expect(updated.revision).toBe(source.revision + 1);
          expect(updated.inFlightRunId).toBeUndefined();
          expect(Object.isFrozen(updated)).toBe(true);
          expect(Object.isFrozen(updated.goal)).toBe(true);
        } else expectDotError(() => command(source, 20), 'invalid-transition');
        expect(source).toEqual(before);
      });
    }
  }

  test('same-millisecond transitions are valid while backwards timestamps are rejected', () => {
    const paused = pauseDot(dot(), 10);
    const resumed = resumeDot(paused, 10);
    expect(resumed.updatedAt).toBe(10);
    expect(resumed.revision).toBe(2);
    const later = pauseDot(resumed, 30);
    expectDotError(() => resumeDot(later, 29), 'invalid-input');
    expect(later.lifecycle).toBe('paused');
    expect(later.revision).toBe(3);
  });
});

describe('DotRun admission and finite execution', () => {
  test('creation reserves only one run and changes neither Dot identity nor goal', () => {
    const initial = dot();
    const reserved = createDotRun(initial, { id: 'r'.repeat(128), createdAt: 11 });
    expect(String(reserved.run.id)).toBe('r'.repeat(128));
    expect(reserved.run).toEqual({
      id: reserved.run.id,
      dotId: initial.id,
      dotRevision: 1,
      status: 'pending',
      createdAt: 11,
      updatedAt: 11,
    });
    expect(reserved.dot.inFlightRunId).toBe(reserved.run.id);
    expect(reserved.dot.id).toBe(initial.id);
    expect(reserved.dot.goal).toEqual(initial.goal);
    expect(reserved.dot.lifecycle).toBe('active');
    expect(reserved.dot.createdAt).toBe(10);
    expect(reserved.dot.updatedAt).toBe(11);
    expect(reserved.dot.revision).toBe(1);
    expect(initial.revision).toBe(0);
    expect(initial.inFlightRunId).toBeUndefined();
    expectDotError(
      () => createDotRun(reserved.dot, { id: 'run-2', createdAt: 12 }),
      'run-in-flight',
    );
    expect(Object.isFrozen(reserved.dot)).toBe(true);
    expect(Object.isFrozen(reserved.dot.goal)).toBe(true);
    expect(Object.isFrozen(reserved.run)).toBe(true);
    expect(Reflect.set(reserved.run, 'status', 'succeeded')).toBe(false);
  });

  for (const lifecycle of lifecycles.filter((value) => value !== 'active')) {
    test(`${lifecycle} Dot cannot admit a run`, () => {
      expectDotError(
        () => createDotRun(dotWithLifecycle(lifecycle), { id: 'run-1', createdAt: 20 }),
        'invalid-transition',
      );
    });
  }

  for (const status of ['pending', 'running'] as const) {
    test(`all lifecycle commands reject an in-flight ${status} run`, () => {
      const current = runWithStatus(status);
      const before = structuredClone(current);
      for (const { command } of lifecycleCommands)
        expectDotError(() => command(current.dot, 30), 'run-in-flight');
      expect(current).toEqual(before);
    });
  }

  for (const status of runStatuses) {
    test(`start from ${status}`, () => {
      const current = runWithStatus(status);
      const before = structuredClone(current);
      if (status === 'pending') {
        const started = startDotRun(current.dot, current.run, 40);
        expect(started.run.status).toBe('running');
        expect(started.run.startedAt).toBe(40);
        expect(started.run.finishedAt).toBeUndefined();
        expect(started.run.id).toBe(current.run.id);
        expect(started.run.dotId).toBe(current.dot.id);
        expect(started.run.createdAt).toBe(current.run.createdAt);
        expect(started.run.updatedAt).toBe(40);
        expect(started.dot.inFlightRunId).toBe(current.run.id);
        expect(started.dot.revision).toBe(current.dot.revision + 1);
        expect(started.run.dotRevision).toBe(started.dot.revision);
        expect(started.dot.updatedAt).toBe(40);
        expect(Object.isFrozen(started.run)).toBe(true);
        expect(Object.isFrozen(started.dot)).toBe(true);
      } else {
        // A terminal run has also released its pointer; validation order is not part of the API.
        expectDotError(
          () => startDotRun(current.dot, current.run, 40),
          status === 'running' ? 'invalid-transition' : undefined,
        );
      }
      expect(current).toEqual(before);
    });

    for (const outcome of runOutcomes) {
      test(`finish ${status} -> ${outcome}`, () => {
        const current = runWithStatus(status);
        const before = structuredClone(current);
        const allowed =
          status === 'running' ||
          (status === 'pending' && (outcome === 'cancelled' || outcome === 'interrupted'));
        if (allowed) {
          const finished = finishDotRun(current.dot, current.run, outcome, 40);
          expect(finished.run.status).toBe(outcome);
          expect(finished.run.id).toBe(current.run.id);
          expect(finished.run.dotId).toBe(current.dot.id);
          expect(finished.run.createdAt).toBe(current.run.createdAt);
          expect(finished.run.startedAt).toBe(current.run.startedAt);
          expect(finished.run.finishedAt).toBe(40);
          expect(finished.run.updatedAt).toBe(40);
          expect(finished.dot.lifecycle).toBe('active');
          expect(finished.dot.inFlightRunId).toBeUndefined();
          expect(finished.dot.id).toBe(current.dot.id);
          expect(finished.dot.goal).toEqual(current.dot.goal);
          expect(finished.dot.createdAt).toBe(current.dot.createdAt);
          expect(finished.dot.updatedAt).toBe(40);
          expect(finished.dot.revision).toBe(current.dot.revision + 1);
          expect(finished.run.dotRevision).toBe(finished.dot.revision);
          expect(Object.isFrozen(finished.run)).toBe(true);
          expect(Object.isFrozen(finished.dot)).toBe(true);
        } else {
          expectDotError(
            () => finishDotRun(current.dot, current.run, outcome, 40),
            status === 'pending' ? 'invalid-transition' : undefined,
          );
        }
        expect(current).toEqual(before);
      });
    }
  }

  test('a failed run leaves the same Dot active and admits a later successful run', () => {
    const running = runWithStatus('running');
    const failed = finishDotRun(running.dot, running.run, 'failed', 30);
    const second = createDotRun(failed.dot, { id: 'run-2', createdAt: 30 });
    const started = startDotRun(second.dot, second.run, 30);
    const finished = finishDotRun(started.dot, started.run, 'succeeded', 30);
    expect(finished.dot.id).toBe(running.dot.id);
    expect(finished.dot.goal).toEqual(running.dot.goal);
    expect(finished.dot.lifecycle).toBe('active');
    expect(finished.dot.revision).toBe(6);
    expect(finished.dot.inFlightRunId).toBeUndefined();
    expect(failed.run.status).toBe('failed');
    expect(finished.run.id).not.toBe(failed.run.id);
    expect(finished.run.startedAt).toBe(30);
    expect(finished.run.finishedAt).toBe(30);
  });

  test('a foreign run cannot start or finish against another Dot, even with the same run ID', () => {
    const first = createDotRun(dot('dot-1'), { id: 'shared-run-id', createdAt: 10 });
    const foreign = createDotRun(dot('dot-2'), { id: 'shared-run-id', createdAt: 10 });
    const before = structuredClone(first.dot);
    expectDotError(() => startDotRun(first.dot, foreign.run, 20), 'invalid-reference');
    expectDotError(
      () => finishDotRun(first.dot, foreign.run, 'cancelled', 20),
      'invalid-reference',
    );
    expect(first.dot).toEqual(before);
    expect(first.dot.inFlightRunId).toBe(first.run.id);
  });

  test('an old run cannot clear the new pointer or prevent the new run from completing', () => {
    const first = runWithStatus('running');
    const stopped = finishDotRun(first.dot, first.run, 'interrupted', 30);
    const second = createDotRun(stopped.dot, { id: 'run-2', createdAt: 40 });
    const before = structuredClone(second.dot);
    expectDotError(() => finishDotRun(second.dot, first.run, 'succeeded', 50), 'invalid-reference');
    expectDotError(() => startDotRun(second.dot, stopped.run, 50));
    expect(second.dot).toEqual(before);
    expect(second.dot.inFlightRunId).toBe(second.run.id);
    const started = startDotRun(second.dot, second.run, 50);
    const finished = finishDotRun(started.dot, started.run, 'succeeded', 60);
    expect(finished.dot.inFlightRunId).toBeUndefined();
    expect(finished.run.id).toBe(second.run.id);
    expect(finished.run.status).toBe('succeeded');
  });

  test('same-millisecond stale snapshots cannot start again or cancel a newer running revision', () => {
    const pending = createDotRun(dot(), { id: 'run-1', createdAt: 10 });
    const running = startDotRun(pending.dot, pending.run, 10);
    expect(running.run.dotRevision).toBe(2);
    expect(running.dot.updatedAt).toBe(pending.dot.updatedAt);
    expectDotError(() => startDotRun(running.dot, pending.run, 10), 'invalid-reference');
    expectDotError(
      () => finishDotRun(running.dot, pending.run, 'cancelled', 10),
      'invalid-reference',
    );
    expectDotError(
      () => finishDotRun(pending.dot, running.run, 'succeeded', 10),
      'invalid-reference',
    );
    expect(running.dot.inFlightRunId).toBe(running.run.id);
    expect(running.dot.revision).toBe(2);
    const finished = finishDotRun(running.dot, running.run, 'succeeded', 10);
    expect(finished.dot.revision).toBe(3);
    expect(finished.run.dotRevision).toBe(3);
  });

  test('revision binding rejects an old running snapshot even when a later run reuses its ID and time', () => {
    const pending = createDotRun(dot(), { id: 'run-1', createdAt: 10 });
    const first = startDotRun(pending.dot, pending.run, 10);
    const interrupted = finishDotRun(first.dot, first.run, 'interrupted', 10);
    // Global ID uniqueness belongs to the future store; a snapshot still fences the old revision.
    const second = createDotRun(interrupted.dot, { id: 'run-1', createdAt: 10 });
    const running = startDotRun(second.dot, second.run, 10);
    expectDotError(
      () => finishDotRun(running.dot, first.run, 'succeeded', 10),
      'invalid-reference',
    );
    expect(running.dot.inFlightRunId).toBe(first.run.id);
    expect(running.dot.revision).toBe(5);
    const finished = finishDotRun(running.dot, running.run, 'succeeded', 10);
    expect(finished.dot.revision).toBe(6);
    expect(finished.run.dotRevision).toBe(6);
    expect(finished.dot.inFlightRunId).toBeUndefined();
  });

  test('run admission, start and finish cannot move timestamps backwards', () => {
    const current = resumeDot(pauseDot(dot(), 20), 30);
    expectDotError(() => createDotRun(current, { id: 'run-1', createdAt: 29 }), 'invalid-input');
    const pending = createDotRun(current, { id: 'run-1', createdAt: 40 });
    expectDotError(() => startDotRun(pending.dot, pending.run, 39), 'invalid-input');
    expectDotError(
      () => finishDotRun(pending.dot, pending.run, 'interrupted', 39),
      'invalid-input',
    );
    const running = startDotRun(pending.dot, pending.run, 50);
    expectDotError(() => finishDotRun(running.dot, running.run, 'succeeded', 49), 'invalid-input');
    expect(running.run.status).toBe('running');
    expect(running.run.finishedAt).toBeUndefined();
  });
});

describe('public domain error boundaries', () => {
  test('missing Dot and Run snapshots are invalid references', () => {
    const pending = runWithStatus('pending');
    for (const missing of [undefined, null]) {
      const missingDot = missing as unknown as Dot;
      for (const { command } of lifecycleCommands)
        expectDotError(() => command(missingDot, 20), 'invalid-reference');
      expectDotError(
        () => createDotRun(missingDot, { id: 'run', createdAt: 20 }),
        'invalid-reference',
      );
      expectDotError(() => startDotRun(missingDot, pending.run, 20), 'invalid-reference');
      expectDotError(
        () => finishDotRun(missingDot, pending.run, 'cancelled', 20),
        'invalid-reference',
      );
      const missingRun = missing as unknown as DotRun;
      expectDotError(() => startDotRun(pending.dot, missingRun, 20), 'invalid-reference');
      expectDotError(
        () => finishDotRun(pending.dot, missingRun, 'cancelled', 20),
        'invalid-reference',
      );
    }
  });

  test('malformed Dot snapshots reject invalid fields and impossible timestamp or revision values', () => {
    const initial = dot();
    const patches: Record<string, unknown>[] = [
      { id: 'invalid/id' },
      { name: '' },
      { goal: null },
      { goal: { text: ' Unnormalized goal ' } },
      { lifecycle: 'sleeping' },
      { createdAt: NaN },
      { createdAt: 11 },
      { updatedAt: -1 },
      { updatedAt: 10.5 },
      { revision: -1 },
      { revision: 0.5 },
      { revision: NaN },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { inFlightRunId: 'invalid/run' },
      { lifecycle: 'paused', inFlightRunId: 'run-1' },
    ];
    for (const patch of patches) {
      const malformed = { ...initial, ...patch } as Dot;
      expectDotError(() => pauseDot(malformed, 20), 'invalid-input');
    }
    expect(initial.revision).toBe(0);
    expect(initial.lifecycle).toBe('active');
  });

  test('malformed Run snapshots reject invalid identity, phase, timestamp and revision values', () => {
    const pending = runWithStatus('pending');
    const patches: Record<string, unknown>[] = [
      { id: 'invalid/id' },
      { dotId: 'invalid/dot' },
      { dotRevision: -1 },
      { dotRevision: 0.5 },
      { dotRevision: NaN },
      { dotRevision: Number.MAX_SAFE_INTEGER + 1 },
      { status: 'unknown' },
      { createdAt: -1 },
      { updatedAt: 9 },
      { updatedAt: NaN },
      { updatedAt: 11 },
      { startedAt: 10 },
      { finishedAt: 10 },
    ];
    for (const patch of patches) {
      const malformed = { ...pending.run, ...patch } as DotRun;
      expectDotError(() => startDotRun(pending.dot, malformed, 20), 'invalid-input');
      expectDotError(() => finishDotRun(pending.dot, malformed, 'cancelled', 20), 'invalid-input');
    }
    const running = runWithStatus('running');
    for (const patch of [{ startedAt: undefined }, { startedAt: 9 }, { finishedAt: 30 }]) {
      const malformed = { ...running.run, ...patch } as DotRun;
      expectDotError(() => finishDotRun(running.dot, malformed, 'succeeded', 30), 'invalid-input');
    }
    expect(pending.run.status).toBe('pending');
    expect(running.run.status).toBe('running');
  });

  test('unknown outcomes are invalid input and leave the current run reserved', () => {
    const running = runWithStatus('running');
    for (const outcome of ['', 'completed', 'sleeping', undefined, null])
      expectDotError(
        () =>
          finishDotRun(running.dot, running.run, outcome as Parameters<typeof finishDotRun>[2], 30),
        'invalid-input',
      );
    expect(running.dot.inFlightRunId).toBe(running.run.id);
    expect(running.dot.revision).toBe(2);
    expect(running.run.finishedAt).toBeUndefined();
  });

  test('aggregate revisions can reach the last safe integer but never overflow it', () => {
    const almostExhausted: Dot = { ...dot(), revision: Number.MAX_SAFE_INTEGER - 1 };
    const paused = pauseDot(almostExhausted, 10);
    expect(paused.revision).toBe(Number.MAX_SAFE_INTEGER);
    expectDotError(() => resumeDot(paused, 10), 'invalid-input');
    const exhausted: Dot = { ...dot(), revision: Number.MAX_SAFE_INTEGER };
    expectDotError(() => pauseDot(exhausted, 10), 'invalid-input');
    expectDotError(() => createDotRun(exhausted, { id: 'run', createdAt: 10 }), 'invalid-input');
    const pending = runWithStatus('pending');
    const pendingDot: Dot = { ...pending.dot, revision: Number.MAX_SAFE_INTEGER };
    const pendingRun: DotRun = { ...pending.run, dotRevision: Number.MAX_SAFE_INTEGER };
    expectDotError(() => startDotRun(pendingDot, pendingRun, 10), 'invalid-input');
    expectDotError(() => finishDotRun(pendingDot, pendingRun, 'cancelled', 10), 'invalid-input');
    const running = runWithStatus('running');
    const runningDot: Dot = { ...running.dot, revision: Number.MAX_SAFE_INTEGER };
    const runningRun: DotRun = { ...running.run, dotRevision: Number.MAX_SAFE_INTEGER };
    expectDotError(() => finishDotRun(runningDot, runningRun, 'succeeded', 20), 'invalid-input');
    expect(pendingDot.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(runningDot.inFlightRunId).toBe(runningRun.id);
  });

  test('starting a rehydrated Run projects domain fields without retaining extra mutable payload', () => {
    const pending = runWithStatus('pending');
    const privateContext = { notes: ['before'] };
    const enrichedRun = { ...pending.run, privateContext };
    const running = startDotRun(pending.dot, enrichedRun, 20);
    expect(running.run).not.toHaveProperty('privateContext');
    privateContext.notes.push('after');
    expect(running.run).toEqual({
      id: pending.run.id,
      dotId: pending.dot.id,
      dotRevision: running.dot.revision,
      status: 'running',
      createdAt: 10,
      updatedAt: 20,
      startedAt: 20,
    });
    expect(Object.isFrozen(running.run)).toBe(true);
    expect(enrichedRun.privateContext.notes).toEqual(['before', 'after']);
  });
});
