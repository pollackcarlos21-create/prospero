import { expect, test } from 'bun:test';
import {
  createLiveBudgetManifest,
  LiveBudgetLedger,
  type LiveBudgetInput,
  type LiveBudgetManifest,
} from '../acceptance/live-budget';

const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
let nextId = 0;
function fixture(overrides: Partial<LiveBudgetInput> = {}) {
  const input: LiveBudgetInput = {
    authorizationId: `offline_auth_${++nextId}`,
    ...identity,
    journalSha256: 'c'.repeat(64),
    caseIds: ['W01', 'F01'],
    createdAt: 1000,
    expiresAt: 5000,
    limits: {
      provider: 3,
      search: 2,
      page: 2,
      redirects: 1,
      responseBodyBytes: 150,
      wallClockMs: 3000,
    },
    ...overrides,
  };
  const clock = { wall: 1000, mono: 0 };
  const manifest = createLiveBudgetManifest(input);
  const options = {
    humanConfirmed: true,
    executionIdentity: { ...identity },
    now: () => clock.wall,
    monotonic: () => clock.mono,
  };
  return { input, clock, manifest, options, ledger: new LiveBudgetLedger(manifest, options) };
}
const reserve = (ledger: LiveBudgetLedger, responseBytes = 100) =>
  ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes });

test('manifest flags and mutable caller options cannot fabricate actual human approval', () => {
  const { manifest, options } = fixture();
  const pending = { ...options, humanConfirmed: false };
  const ledger = new LiveBudgetLedger(manifest, pending);
  pending.humanConfirmed = true;
  expect(() => reserve(ledger)).toThrow('authorization');
  expect(() => reserve(new LiveBudgetLedger(manifest))).toThrow('authorization');
  expect(ledger.usage().dispatchIntents).toBe(0);
  expect(ledger.usage().provider).toBe(0);
  expect(
    () => new LiveBudgetLedger({ ...manifest, approval: true } as LiveBudgetManifest, options),
  ).toThrow('manifest');
});

test('source and build identities are copied and revalidated independently of approval', () => {
  const { manifest, options } = fixture();
  const changed = { ...options, executionIdentity: { ...identity, buildSha256: 'c'.repeat(64) } };
  const ledger = new LiveBudgetLedger(manifest, changed);
  changed.executionIdentity.buildSha256 = identity.buildSha256;
  expect(() => reserve(ledger)).toThrow('identity');
  expect(ledger.usage().provider).toBe(0);
});

test('approved manifest freezes and hashes all scope and limit values', () => {
  const { input, manifest, ledger } = fixture();
  const digest = manifest.digest;
  input.limits.responseBodyBytes = 10000;
  input.expiresAt = 1000000;
  (input.caseIds as string[]).push('C10');
  expect(manifest.digest).toBe(digest);
  expect(manifest.limits.responseBodyBytes).toBe(150);
  expect(manifest.caseIds).not.toContain('C10');
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.limits)).toBe(true);
  expect(Object.isFrozen(manifest.caseIds)).toBe(true);
  expect(() => ledger.reserve({ caseId: 'C10', kind: 'page', responseBytes: 1 })).toThrow(
    'reservation',
  );
  expect(() =>
    createLiveBudgetManifest({ ...input, authorizationId: 12345678 } as unknown as LiveBudgetInput),
  ).toThrow('manifest');
});

test('tampered digest, duplicate or unknown cases and unsafe numeric limits are rejected', () => {
  const { input, manifest, options } = fixture();
  expect(() => new LiveBudgetLedger({ ...manifest, buildSha256: 'c'.repeat(64) }, options)).toThrow(
    'manifest',
  );
  for (const selected of [['W01', 'W01'], ['W11'], []])
    expect(() => createLiveBudgetManifest({ ...input, caseIds: selected })).toThrow('manifest');
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      createLiveBudgetManifest({ ...input, limits: { ...input.limits, provider: value } }),
    ).toThrow('manifest');
  expect(() =>
    createLiveBudgetManifest({ ...input, limits: { ...input.limits, wallClockMs: 0 } }),
  ).toThrow('manifest');
});

test('simultaneous reservations cannot both spend the same response byte budget', () => {
  const { ledger } = fixture();
  const first = reserve(ledger);
  expect(() => reserve(ledger, 100)).toThrow('quota');
  expect(ledger.usage().provider).toBe(1);
  expect(ledger.usage().reservedResponseBodyBytes).toBe(100);
  ledger.dispatch(first);
  ledger.complete(first, { outcome: 'completed', responseBytes: 40 });
  const second = reserve(ledger, 110);
  ledger.dispatch(second);
  ledger.complete(second, { outcome: 'completed', responseBytes: 110 });
  expect(ledger.usage().chargedResponseBodyBytes).toBe(150);
  expect(() => reserve(ledger, 1)).toThrow('quota');
});

test('failed and cancelled HTTP attempts never refund request counts; unknown partial consumes reservation', () => {
  const { ledger } = fixture();
  const first = reserve(ledger);
  ledger.dispatch(first);
  ledger.complete(first, { outcome: 'failed' });
  expect(ledger.usage().chargedResponseBodyBytes).toBe(100);
  expect(ledger.usage().unknownResponseReceipts).toBe(1);
  const second = reserve(ledger, 20);
  ledger.dispatch(second);
  ledger.complete(second, { outcome: 'cancelled', responseBytes: 7 });
  const third = reserve(ledger, 20);
  ledger.dispatch(third);
  ledger.complete(third, { outcome: 'failed', responseBytes: 0 });
  expect(ledger.usage().provider).toBe(3);
  expect(ledger.usage().dispatchIntents).toBe(3);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(107);
  expect(() => reserve(ledger, 1)).toThrow('quota');
});

test('a redirect consumes both its raw HTTP kind and the independent redirect cap', () => {
  const { ledger } = fixture();
  const token = ledger.reserve({ caseId: 'W01', kind: 'page', redirect: true, responseBytes: 10 });
  ledger.dispatch(token);
  ledger.complete(token, { outcome: 'completed', responseBytes: 3 });
  expect(ledger.usage().page).toBe(1);
  expect(ledger.usage().redirects).toBe(1);
  expect(() =>
    ledger.reserve({ caseId: 'W01', kind: 'page', redirect: true, responseBytes: 10 }),
  ).toThrow('quota');
});

test('opaque tokens cannot be forged, used across ledgers, dispatched twice or replayed after settlement', () => {
  const { ledger } = fixture();
  const other = fixture().ledger;
  const token = reserve(ledger);
  expect(() => ledger.dispatch({})).toThrow('reservation');
  expect(() => other.dispatch(token)).toThrow('reservation');
  ledger.dispatch(token);
  expect(() => ledger.dispatch(token)).toThrow('reservation');
  ledger.complete(token, { outcome: 'completed', responseBytes: 5 });
  expect(() => ledger.complete(token, { outcome: 'completed', responseBytes: 0 })).toThrow(
    'reservation',
  );
});

test('missing or over-cap completed receipts fail closed rather than returning free allowance', () => {
  for (const receipt of [
    { outcome: 'completed' as const },
    { outcome: 'completed' as const, responseBytes: 101 },
  ]) {
    const { ledger } = fixture();
    const token = reserve(ledger);
    ledger.dispatch(token);
    expect(() => ledger.complete(token, receipt)).toThrow('receipt');
    expect(ledger.usage().chargedResponseBodyBytes).toBe(100);
    expect(ledger.usage().closed).toBe(true);
    expect(() => reserve(ledger, 1)).toThrow('closed');
  }
});

test('known cancellation before dispatch releases body bytes but still spends the reserved request slot', () => {
  const { ledger } = fixture();
  const token = reserve(ledger);
  ledger.complete(token, { outcome: 'cancelled', responseBytes: 0 });
  expect(ledger.usage().provider).toBe(1);
  expect(ledger.usage().dispatchIntents).toBe(0);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
  const invalid = reserve(ledger);
  expect(() => ledger.complete(invalid, { outcome: 'completed', responseBytes: 0 })).toThrow(
    'receipt',
  );
  expect(ledger.usage().closed).toBe(true);
});

test('dispatch rechecks deadline; monotonic elapsed prevents a backward wall clock extending authority', () => {
  const { ledger, clock } = fixture();
  const token = reserve(ledger);
  clock.wall = 900;
  clock.mono = 3000;
  expect(() => ledger.dispatch(token)).toThrow('expired');
  expect(ledger.usage().dispatchIntents).toBe(0);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
  expect(ledger.usage().closed).toBe(true);
});

test('invalid initial or subsequent clock samples fail closed before any dispatch', () => {
  const { manifest, options } = fixture();
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(() => new LiveBudgetLedger(manifest, { ...options, now: () => value })).toThrow(
      'expired',
    );
    expect(() => new LiveBudgetLedger(manifest, { ...options, monotonic: () => value })).toThrow(
      'expired',
    );
  }
  const { ledger, clock } = fixture();
  const token = reserve(ledger);
  clock.wall = Number.NaN;
  expect(() => ledger.dispatch(token)).toThrow('expired');
  expect(ledger.usage().dispatchIntents).toBe(0);
  expect(ledger.usage().closed).toBe(true);
});

test('new ledger cannot extend an expired manifest or reset a consumed authorization in this process', () => {
  const { manifest, options, ledger } = fixture();
  const token = reserve(ledger);
  ledger.dispatch(token);
  ledger.complete(token, { outcome: 'completed', responseBytes: 1 });
  expect(() => reserve(new LiveBudgetLedger(manifest, options))).toThrow('closed');
  expect(() =>
    reserve(new LiveBudgetLedger(fixture().manifest, { ...options, now: () => 4000 })),
  ).toThrow('expired');
});

test('abort permanently closes authority, charges dispatched unknown effects and releases undispatched bytes', () => {
  const { ledger } = fixture();
  const dispatched = reserve(ledger, 100);
  ledger.dispatch(dispatched);
  reserve(ledger, 40);
  ledger.abort();
  expect(ledger.usage().chargedResponseBodyBytes).toBe(100);
  expect(ledger.usage().reservedResponseBodyBytes).toBe(0);
  expect(ledger.usage().unknownResponseReceipts).toBe(1);
  expect(ledger.usage().durableAcrossProcessRestart).toBe(false);
  expect(() => ledger.complete(dispatched, { outcome: 'completed', responseBytes: 5 })).toThrow(
    'closed',
  );
  expect(() => reserve(ledger, 1)).toThrow('closed');
});
