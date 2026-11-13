import { DotError } from './errors';
import type {
  Dot,
  DotGoal,
  DotId,
  DotLifecycleStatus,
  DotRun,
  DotRunChange,
  DotRunId,
  DotRunOutcome,
} from './types';
import { assertDot, assertRun, assertTime, boundedText, identity, record } from './validation';

function snapshot(dot: Dot): Dot {
  return Object.freeze({
    id: dot.id,
    name: dot.name,
    goal: Object.freeze({ text: dot.goal.text }),
    lifecycle: dot.lifecycle,
    createdAt: dot.createdAt,
    updatedAt: dot.updatedAt,
    revision: dot.revision,
    ...(dot.inFlightRunId === undefined ? {} : { inFlightRunId: dot.inFlightRunId }),
  });
}

function advance(dot: Dot, at: number): Dot {
  assertTime(at, dot.updatedAt);
  if (dot.revision === Number.MAX_SAFE_INTEGER) throw new DotError('invalid-input');
  return { ...dot, updatedAt: at, revision: dot.revision + 1 };
}

function changeLifecycle(
  dot: Dot,
  at: number,
  next: DotLifecycleStatus,
  from: readonly DotLifecycleStatus[],
): Dot {
  assertDot(dot);
  if (dot.inFlightRunId !== undefined) throw new DotError('run-in-flight');
  if (!from.includes(dot.lifecycle)) throw new DotError('invalid-transition');
  return snapshot({ ...advance(dot, at), lifecycle: next });
}

/** The host supplies a fresh ID and UTC epoch-ms time; this function has no I/O. */
export function createDot(input: {
  id: string;
  name: string;
  goal: DotGoal;
  createdAt: number;
}): Dot {
  if (
    !record(input) ||
    !identity(input.id) ||
    !boundedText(input.name, 120) ||
    !record(input.goal) ||
    !boundedText(input.goal.text, 16_384)
  )
    throw new DotError('invalid-input');
  assertTime(input.createdAt, 0);
  return snapshot({
    id: input.id as DotId,
    name: input.name.trim(),
    goal: { text: input.goal.text.trim() },
    lifecycle: 'active',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revision: 0,
  });
}

/** Pure finalization only; an application must settle tool cleanup before calling. */
export function pauseDot(dot: Dot, at: number): Dot {
  return changeLifecycle(dot, at, 'paused', ['active']);
}

export function resumeDot(dot: Dot, at: number): Dot {
  return changeLifecycle(dot, at, 'active', ['paused']);
}

export function completeDot(dot: Dot, at: number): Dot {
  return changeLifecycle(dot, at, 'completed', ['active', 'paused']);
}

export function cancelDot(dot: Dot, at: number): Dot {
  return changeLifecycle(dot, at, 'cancelled', ['active', 'paused']);
}

export function archiveDot(dot: Dot, at: number): Dot {
  return changeLifecycle(dot, at, 'archived', ['active', 'paused', 'completed', 'cancelled']);
}

/** Record an explicit host-validated review. It grants no work and changes no lifecycle. */
export function recordDotReview(dot: Dot, at: number): Dot {
  assertDot(dot);
  if (dot.inFlightRunId !== undefined) throw new DotError('run-in-flight');
  return snapshot(advance(dot, at));
}

/** Reserve a pending run on the supplied latest aggregate, not a global execution slot. */
export function createDotRun(dot: Dot, input: { id: string; createdAt: number }): DotRunChange {
  assertDot(dot);
  if (!record(input) || !identity(input.id)) throw new DotError('invalid-input');
  if (dot.lifecycle !== 'active') throw new DotError('invalid-transition');
  if (dot.inFlightRunId !== undefined) throw new DotError('run-in-flight');
  const updated = advance(dot, input.createdAt);
  const id = input.id as DotRunId;
  return Object.freeze({
    dot: snapshot({ ...updated, inFlightRunId: id }),
    run: Object.freeze({
      id,
      dotId: dot.id,
      dotRevision: updated.revision,
      status: 'pending',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
  });
}

function assertCurrentRun(dot: Dot, run: DotRun) {
  assertDot(dot);
  assertRun(run);
  if (
    dot.id !== run.dotId ||
    dot.inFlightRunId !== run.id ||
    dot.revision !== run.dotRevision ||
    dot.updatedAt !== run.updatedAt ||
    run.createdAt < dot.createdAt
  )
    throw new DotError('invalid-reference');
}

export function startDotRun(dot: Dot, run: DotRun, at: number): DotRunChange {
  assertCurrentRun(dot, run);
  if (dot.lifecycle !== 'active' || run.status !== 'pending')
    throw new DotError('invalid-transition');
  const updated = advance(dot, at);
  return Object.freeze({
    dot: snapshot(updated),
    run: Object.freeze({
      id: run.id,
      dotId: run.dotId,
      createdAt: run.createdAt,
      dotRevision: updated.revision,
      status: 'running',
      updatedAt: at,
      startedAt: at,
    }),
  });
}

export function finishDotRun(
  dot: Dot,
  run: DotRun,
  outcome: DotRunOutcome,
  at: number,
): DotRunChange {
  assertCurrentRun(dot, run);
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(outcome))
    throw new DotError('invalid-input');
  if (
    run.status !== 'running' &&
    !(run.status === 'pending' && (outcome === 'cancelled' || outcome === 'interrupted'))
  )
    throw new DotError('invalid-transition');
  const updated = advance(dot, at);
  const base = {
    id: run.id,
    dotId: run.dotId,
    dotRevision: updated.revision,
    createdAt: run.createdAt,
    updatedAt: at,
    finishedAt: at,
  };
  let settled: DotRun;
  if (outcome === 'succeeded' || outcome === 'failed') {
    if (run.status !== 'running') throw new DotError('invalid-transition');
    settled = Object.freeze({ ...base, status: outcome, startedAt: run.startedAt });
  } else {
    settled = Object.freeze({
      ...base,
      status: outcome,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    });
  }
  // snapshot omits the released pointer; history stays with the returned terminal Run.
  return Object.freeze({
    dot: snapshot({ ...updated, inFlightRunId: undefined }),
    run: settled,
  });
}
