import { expect, test } from 'bun:test';
import { createDotWake, rehydrateDotWake } from './wake';
const input = { id: 'wake', dotId: 'dot', policyId: 'policy', createdAt: 100, dueAt: 200 };
test('wake binding and terminal states are frozen and strictly rehydrated', () => {
  const wake = createDotWake(input);
  expect(Object.isFrozen(wake)).toBe(true);
  expect(rehydrateDotWake(wake)).toEqual(wake);
  expect(
    rehydrateDotWake({ ...wake, status: 'claimed', revision: 1, updatedAt: 200, runId: 'run' })
      .runId,
  ).toBe('run');
  expect(
    rehydrateDotWake({ ...wake, status: 'blocked', revision: 1, updatedAt: 110, reason: 'policy' })
      .reason,
  ).toBe('policy');
  for (const bad of [
    { ...input, dueAt: 100 },
    { ...input, dueAt: NaN },
    { ...input, dueAt: 100 + 7 * 86400000 + 1 },
    { ...input, id: '' },
    { ...input, extra: 1 },
  ])
    expect(() => createDotWake(bad)).toThrow();
  for (const bad of [
    { ...wake, revision: 1 },
    { ...wake, status: 'claimed', revision: 1, updatedAt: 199, runId: 'run' },
    { ...wake, status: 'claimed', revision: 1, updatedAt: 200 },
    { ...wake, status: 'blocked', revision: 1, reason: 'retry' },
    { ...wake, status: 'cancelled', revision: 1, reason: 'user', runId: 'run' },
  ])
    expect(() => rehydrateDotWake(bad)).toThrow();
});
test('untrusted wake accessors are rejected without invoking them', () => {
  let calls = 0;
  const bad = { ...input };
  Object.defineProperty(bad, 'createdAt', {
    enumerable: true,
    get: () => {
      calls++;
      return 100;
    },
  });
  expect(() => createDotWake(bad)).toThrow();
  expect(calls).toBe(0);
});
