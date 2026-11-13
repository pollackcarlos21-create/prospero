import { expect, test } from 'bun:test';
import { rehydrateDotIntentReview } from './intent-review';
const value = {
  version: 1,
  acknowledgement: 'accept-uncertainty',
  intentId: 'intent',
  dotId: 'dot',
  runId: 'run',
  intentRevision: 3,
  intentDigest: 'a'.repeat(64),
  dotRevision: 3,
  reviewedAt: 100,
  note: 'Inspected service history; accept uncertainty.',
} as const;
test('human uncertainty review is frozen, bounded and cannot claim success or authorize retry', () => {
  const review = rehydrateDotIntentReview(value);
  expect(Object.isFrozen(review)).toBe(true);
  expect(review).toEqual(value);
  for (const bad of [
    { ...value, acknowledgement: 'succeeded' },
    { ...value, note: '' },
    { ...value, note: '界'.repeat(1400) },
    { ...value, intentDigest: 'bad' },
    { ...value, intentRevision: -1 },
    { ...value, reviewedAt: Infinity },
    { ...value, retry: true },
  ])
    expect(() => rehydrateDotIntentReview(bad)).toThrow();
});
test('review accessors and unexpected properties are rejected without invoking them', () => {
  let calls = 0;
  const bad = { ...value };
  Object.defineProperty(bad, 'note', {
    enumerable: true,
    get: () => {
      calls++;
      return 'Reviewed';
    },
  });
  expect(() => rehydrateDotIntentReview(bad)).toThrow();
  expect(calls).toBe(0);
});

test('review advances the Dot revision without resuming paused work or changing Run identity', async () => {
  const { createDot, pauseDot, recordDotReview, createDotRun } = await import('./domain');
  const dot = createDot({ id: 'dot', name: 'Goal', goal: { text: 'Long term' }, createdAt: 1 });
  const paused = pauseDot(dot, 2);
  const reviewed = recordDotReview(paused, 3);
  expect(reviewed.lifecycle).toBe('paused');
  expect(reviewed.revision).toBe(paused.revision + 1);
  expect(reviewed.goal).toEqual(dot.goal);
  expect(reviewed.inFlightRunId).toBeUndefined();
  const busy = createDotRun(dot, { id: 'run', createdAt: 2 });
  expect(() => recordDotReview(busy.dot, 3)).toThrow();
  expect(() => recordDotReview(paused, 1)).toThrow();
});
