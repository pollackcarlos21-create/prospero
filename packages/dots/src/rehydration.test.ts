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
  rehydrateDot,
  rehydrateDotRun,
  startDotRun,
  type Dot,
  type DotRun,
} from './index';

const dot = () =>
  createDot({
    id: 'dot-1',
    name: 'Researcher',
    goal: { text: 'Maintain a brief.' },
    createdAt: 10,
  });
const pending = () => createDotRun(dot(), { id: 'run-1', createdAt: 20 });
const running = () => {
  const pair = pending();
  return startDotRun(pair.dot, pair.run, 30);
};
const payload = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));

function rejects(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DotError);
    if (!(error instanceof DotError)) throw error;
    expect(error.code).toBe('invalid-input');
    return;
  }
  throw new Error('Expected invalid stored state to be rejected.');
}

describe('stored Dot rehydration', () => {
  const active = dot();
  const snapshots: Dot[] = [
    active,
    pauseDot(active, 20),
    completeDot(active, 20),
    cancelDot(active, 20),
    archiveDot(active, 20),
    pending().dot,
    running().dot,
  ];

  for (const source of snapshots) {
    test(`roundtrip ${source.lifecycle} revision ${source.revision}`, () => {
      const stored = payload(source);
      const restored = rehydrateDot(stored);
      expect(restored).toEqual(source);
      expect(restored).not.toBe(stored);
      expect(restored.goal).not.toBe(stored.goal);
      expect(Object.isFrozen(restored)).toBe(true);
      expect(Object.isFrozen(restored.goal)).toBe(true);
      expect(Reflect.set(restored, 'revision', 99)).toBe(false);
      expect(Reflect.set(restored.goal, 'text', 'Changed')).toBe(false);
    });
  }

  test('copies mutable input and preserves saved revision, lifecycle and time without replay', () => {
    const stored = {
      ...payload(dot()),
      goal: { text: 'A saved goal.' },
      lifecycle: 'archived',
      revision: 42,
      updatedAt: 100,
    };
    const restored = rehydrateDot(stored);
    stored.goal.text = 'Changed';
    stored.revision = 43;
    stored.lifecycle = 'active';
    expect(restored.goal.text).toBe('A saved goal.');
    expect(restored.revision).toBe(42);
    expect(restored.lifecycle).toBe('archived');
    expect(restored.createdAt).toBe(10);
    expect(restored.updatedAt).toBe(100);
  });

  test('accepts exact scalar bounds and a null-prototype JSON-shaped record', () => {
    const source = createDot({
      id: 'd'.repeat(128),
      name: 'n'.repeat(120),
      goal: { text: 'g'.repeat(16_384) },
      createdAt: Number.MAX_SAFE_INTEGER,
    });
    const stored = Object.assign(Object.create(null), payload(source), {
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(rehydrateDot(stored)).toEqual({ ...source, revision: Number.MAX_SAFE_INTEGER });
  });

  test('requires every declared mandatory field including goal.text', () => {
    for (const key of ['id', 'name', 'goal', 'lifecycle', 'createdAt', 'updatedAt', 'revision']) {
      const stored = payload(dot());
      delete stored[key];
      rejects(() => rehydrateDot(stored));
    }
    rejects(() => rehydrateDot({ ...payload(dot()), goal: {} }));
  });

  test('rejects invalid identity, text, lifecycle and references without normalizing storage', () => {
    for (const id of ['', 'a/b', 'd'.repeat(129), 1, null])
      rejects(() => rehydrateDot({ ...payload(dot()), id }));
    for (const name of ['', ' ', ' Name ', 'n'.repeat(121), 'a\0b', 1, null])
      rejects(() => rehydrateDot({ ...payload(dot()), name }));
    for (const text of ['', ' ', ' Goal ', 'g'.repeat(16_385), 'a\0b', 1, null])
      rejects(() => rehydrateDot({ ...payload(dot()), goal: { text } }));
    for (const lifecycle of ['running', 'waiting', '', null, 1])
      rejects(() => rehydrateDot({ ...payload(dot()), lifecycle }));
    for (const inFlightRunId of ['', 'a/b', 'r'.repeat(129), null, 1, undefined])
      rejects(() => rehydrateDot({ ...payload(dot()), inFlightRunId }));
    rejects(() => rehydrateDot({ ...payload(pauseDot(dot(), 20)), inFlightRunId: 'run-1' }));
    for (const goal of [null, [], 'Goal']) rejects(() => rehydrateDot({ ...payload(dot()), goal }));
  });

  test('rejects invalid times, revisions and reversed chronology', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
      for (const key of ['createdAt', 'updatedAt', 'revision'])
        rejects(() => rehydrateDot({ ...payload(dot()), [key]: value }));
    }
    rejects(() => rehydrateDot({ ...payload(dot()), updatedAt: 9 }));
  });
});

describe('stored DotRun rehydration', () => {
  const active = running();
  const notStarted = pending();
  const snapshots: DotRun[] = [
    notStarted.run,
    active.run,
    ...(['succeeded', 'failed', 'cancelled', 'interrupted'] as const).map(
      (outcome) => finishDotRun(active.dot, active.run, outcome, 40).run,
    ),
    ...(['cancelled', 'interrupted'] as const).map(
      (outcome) => finishDotRun(notStarted.dot, notStarted.run, outcome, 40).run,
    ),
  ];

  for (const source of snapshots) {
    test(`roundtrip ${source.status} ${source.startedAt === undefined ? 'without' : 'with'} start`, () => {
      const stored = payload(source);
      const restored = rehydrateDotRun(stored);
      expect(restored).toEqual(source);
      expect(restored).not.toBe(stored);
      expect(Object.isFrozen(restored)).toBe(true);
      expect(Reflect.set(restored, 'status', 'pending')).toBe(false);
      stored.dotRevision = 99;
      stored.status = 'pending';
      expect(restored.dotRevision).toBe(source.dotRevision);
      expect(restored.status).toBe(source.status);
    });
  }

  test('preserves historical ownership and revision without comparing another entity', () => {
    const stored = {
      ...payload(snapshots[2]),
      dotId: 'historical-dot',
      dotRevision: 15,
    };
    const restored = rehydrateDotRun(stored);
    expect(String(restored.dotId)).toBe('historical-dot');
    expect(restored.dotRevision).toBe(15);
    expect(restored.status).toBe('succeeded');
  });

  test('requires the fields of each run state and rejects state-incompatible fields', () => {
    for (const source of snapshots) {
      const stored = payload(source);
      for (const key of Object.keys(stored)) {
        if (key === 'startedAt' && ['cancelled', 'interrupted'].includes(source.status)) continue;
        const missing = { ...stored };
        delete missing[key];
        rejects(() => rehydrateDotRun(missing));
      }
    }
    rejects(() => rehydrateDotRun({ ...payload(pending().run), startedAt: 20 }));
    rejects(() => rehydrateDotRun({ ...payload(pending().run), finishedAt: 20 }));
    rejects(() => rehydrateDotRun({ ...payload(running().run), finishedAt: 30 }));
    rejects(() => rehydrateDotRun({ ...payload(snapshots[6]), startedAt: undefined }));
  });

  test('rejects corrupt IDs, states, scalar types and timestamp ordering', () => {
    for (const key of ['id', 'dotId']) {
      for (const value of ['', 'a/b', 'r'.repeat(129), null, 1])
        rejects(() => rehydrateDotRun({ ...payload(active.run), [key]: value }));
    }
    for (const status of ['paused', 'completed', 'suspended', '', null, 1])
      rejects(() => rehydrateDotRun({ ...payload(active.run), status }));
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '20', null]) {
      for (const key of ['createdAt', 'updatedAt', 'dotRevision', 'startedAt', 'finishedAt'])
        rejects(() => rehydrateDotRun({ ...payload(snapshots[2]), [key]: value }));
    }
    rejects(() => rehydrateDotRun({ ...payload(notStarted.run), updatedAt: 21 }));
    rejects(() => rehydrateDotRun({ ...payload(active.run), startedAt: 19 }));
    rejects(() => rehydrateDotRun({ ...payload(active.run), updatedAt: 31 }));
    rejects(() => rehydrateDotRun({ ...payload(snapshots[2]), finishedAt: 29, updatedAt: 29 }));
    rejects(() => rehydrateDotRun({ ...payload(snapshots[6]), finishedAt: 19, updatedAt: 19 }));
  });
});

describe('strict stored snapshot shape', () => {
  test('rejects non-records and unsupported object prototypes with domain errors', () => {
    for (const value of [undefined, null, [], 1, 'payload', true, new Date(), new Map()]) {
      rejects(() => rehydrateDot(value));
      rejects(() => rehydrateDotRun(value));
    }
    const inherited = Object.create(dot());
    rejects(() => rehydrateDot(inherited));
    const customPrototype = Object.assign(Object.create({}), payload(dot()));
    rejects(() => rehydrateDot(customPrototype));
  });

  test('rejects unknown fields rather than retaining mutable input or silently dropping data', () => {
    rejects(() => rehydrateDot({ ...payload(dot()), extra: { value: 1 } }));
    rejects(() => rehydrateDot({ ...payload(dot()), goal: { text: 'Goal', extra: { value: 1 } } }));
    rejects(() => rehydrateDotRun({ ...payload(running().run), extra: { value: 1 } }));
    rejects(() => rehydrateDot({ ...payload(dot()), [Symbol('extra')]: 1 }));
    rejects(() => rehydrateDotRun({ ...payload(running().run), [Symbol('extra')]: 1 }));
  });

  test('rejects accessors without executing them and rejects non-enumerable fields', () => {
    let accessed = false;
    const accessor = {
      ...payload(dot()),
      get name() {
        accessed = true;
        return 'Researcher';
      },
    };
    rejects(() => rehydrateDot(accessor));
    expect(accessed).toBe(false);
    const hidden = payload(running().run);
    Object.defineProperty(hidden, 'id', { value: 'run-1', enumerable: false });
    rejects(() => rehydrateDotRun(hidden));
    const extra = payload(dot());
    Object.defineProperty(extra, 'extra', { value: 1, enumerable: false });
    rejects(() => rehydrateDot(extra));
  });
});
