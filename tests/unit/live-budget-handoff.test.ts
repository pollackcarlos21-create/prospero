import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createLiveBudgetManifest,
  LiveBudgetLedger,
  type LiveBudgetJournal,
  type LiveBudgetManifest,
} from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
let nextId = 0;
function fixture(options: { provider?: number; bytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-budget-handoff-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'budget.sqlite');
  const firstJournal = new SqliteLiveBudgetJournal(path, { mode: 'create' });
  cleanup.push(() => firstJournal.close());
  const clock = { wall: 1000, mono: 0 };
  const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_handoff_${++nextId}`,
    ...identity,
    journalSha256: firstJournal.identitySha256,
    caseIds: ['C07'],
    createdAt: 1000,
    expiresAt: 11_000,
    limits: {
      provider: options.provider ?? 3,
      search: 1,
      page: 1,
      redirects: 1,
      responseBodyBytes: options.bytes ?? 100,
      wallClockMs: 10_000,
    },
  });
  const ledgerOptions = (journal: LiveBudgetJournal | undefined, humanConfirmed = true) => ({
    journal,
    humanConfirmed,
    executionIdentity: identity,
    now: () => clock.wall,
    monotonic: () => clock.mono,
  });
  const first = new LiveBudgetLedger(manifest, ledgerOptions(firstJournal));
  const resume = () => {
    const journal = new SqliteLiveBudgetJournal(path, { mode: 'resume' });
    cleanup.push(() => journal.close());
    return { journal, ledger: new LiveBudgetLedger(manifest, ledgerOptions(journal)) };
  };
  return { manifest, clock, identity, path, first, firstJournal, resume, ledgerOptions };
}
const reserve = (ledger: LiveBudgetLedger, bytes = 30) =>
  ledger.reserve({ caseId: 'C07', kind: 'provider', responseBytes: bytes });
const complete = (ledger: LiveBudgetLedger, bytes = 20) => {
  const token = reserve(ledger, 30);
  ledger.dispatch(token);
  ledger.complete(token, { outcome: 'completed', responseBytes: bytes });
  return token;
};
const head = (journal: LiveBudgetJournal, manifest: LiveBudgetManifest) => {
  const record = journal.load(manifest);
  if (!record) throw new Error('Offline fixture has no durable budget record.');
  return record;
};

test('local suspension closes no authorization and same actual SQLite resume retains consumed requests and byte quotas', () => {
  const { first, firstJournal, manifest, resume } = fixture({ provider: 2, bytes: 60 });
  complete(first, 20);
  const original = head(firstJournal, manifest);
  first.suspendForHandoff();
  expect(firstJournal.load(manifest)).toEqual(original);
  expect(first.usage()).toMatchObject({
    localWriterSuspended: true,
    closed: false,
    provider: 1,
    chargedResponseBodyBytes: 20,
  });
  firstJournal.close();
  const next = resume();
  complete(next.ledger, 25);
  expect(next.ledger.usage()).toMatchObject({
    localWriterSuspended: false,
    provider: 2,
    chargedResponseBodyBytes: 45,
    unknownResponseReceipts: 0,
    closed: false,
  });
  expect(next.journal.load(manifest)?.state.closed).toBe(false);
  expect(() => reserve(next.ledger, 1)).toThrow('quota');
  expect(first.usage()).toMatchObject({
    localWriterSuspended: true,
    provider: 1,
    chargedResponseBodyBytes: 20,
    journalRevision: original.revision,
  });
  next.ledger.suspendForHandoff();
  next.journal.close();
  const third = resume();
  expect(third.ledger.availableResponseBytes()).toBe(15);
  expect(third.ledger.usage().provider).toBe(2);
  expect(() => reserve(third.ledger, 1)).toThrow('quota');
});

test('every old stateful access and repeated handoff is rejected without changing the durable revision', () => {
  const { first, firstJournal, manifest } = fixture();
  const oldToken = complete(first);
  const original = head(firstJournal, manifest);
  first.suspendForHandoff();
  const oldOperations = [
    () => reserve(first, 1),
    () => first.dispatch(oldToken),
    () => first.complete(oldToken, { outcome: 'completed' as const, responseBytes: 0 }),
    () => first.revoke(),
    () => first.abort(),
    () => first.remainingTimeMs(),
    () => first.availableResponseBytes(),
    () => first.suspendForHandoff(),
  ];
  for (const operation of oldOperations) {
    expect(operation).toThrow('suspended');
    expect(firstJournal.load(manifest)).toEqual(original);
  }
  expect(first.usage().closed).toBe(false);
  expect(first.usage().journalCommitFailed).toBe(false);
});

test('live reserved or dispatched tokens forbid suspension without refunds or implicit settlement', () => {
  for (const dispatched of [false, true]) {
    const { first, firstJournal, manifest } = fixture();
    const token = reserve(first);
    if (dispatched) first.dispatch(token);
    const original = head(firstJournal, manifest);
    expect(() => first.suspendForHandoff()).toThrow('reservation');
    expect(firstJournal.load(manifest)).toEqual(original);
    expect(first.usage()).toMatchObject({
      localWriterSuspended: false,
      provider: 1,
      reservedResponseBodyBytes: 30,
      settledReservations: 0,
      chargedResponseBodyBytes: 0,
      closed: false,
    });
    if (dispatched) first.complete(token, { outcome: 'completed', responseBytes: 5 });
    else first.complete(token, { outcome: 'cancelled', responseBytes: 0 });
    first.suspendForHandoff();
    expect(first.usage()).toMatchObject({
      localWriterSuspended: true,
      reservedResponseBodyBytes: 0,
      settledReservations: 1,
      chargedResponseBodyBytes: dispatched ? 5 : 0,
    });
  }
});

test('an uninitialized or memory-only writer cannot use suspension to create or restore a journal', () => {
  const { first, firstJournal, manifest, ledgerOptions } = fixture();
  expect(firstJournal.load(manifest)).toBeUndefined();
  expect(() => first.suspendForHandoff()).toThrow('journal');
  expect(first.usage().durableAcrossProcessRestart).toBe(false);
  expect(firstJournal.load(manifest)).toBeUndefined();
  const memory = new LiveBudgetLedger(manifest, ledgerOptions(undefined));
  complete(memory);
  expect(() => memory.suspendForHandoff()).toThrow('journal');
  expect(memory.usage()).toMatchObject({ localWriterSuspended: false, provider: 1, closed: false });
  expect(firstJournal.load(manifest)).toBeUndefined();
});

test('closed, expired and failed writers reject handoff without appending a new journal event', () => {
  const expired = fixture();
  complete(expired.first);
  const original = head(expired.firstJournal, expired.manifest);
  expired.clock.wall = expired.manifest.expiresAt;
  expect(() => expired.first.suspendForHandoff()).toThrow('expired');
  expect(expired.firstJournal.load(expired.manifest)).toEqual(original);
  expect(expired.first.usage()).toMatchObject({ localWriterSuspended: false, closed: false });
  const closed = fixture();
  complete(closed.first);
  closed.first.abort();
  const closedState = head(closed.firstJournal, closed.manifest);
  expect(() => closed.first.suspendForHandoff()).toThrow('closed');
  expect(closed.firstJournal.load(closed.manifest)).toEqual(closedState);
  const failed = fixture();
  const rejecting: LiveBudgetJournal = {
    identitySha256: failed.firstJournal.identitySha256,
    load: (value) => failed.firstJournal.load(value),
    commit: () => {
      throw new Error('offline storage failure');
    },
  };
  const bad = new LiveBudgetLedger(failed.manifest, failed.ledgerOptions(rejecting));
  expect(() => reserve(bad)).toThrow('journal');
  expect(() => bad.suspendForHandoff()).toThrow('journal');
  expect(bad.usage()).toMatchObject({
    localWriterSuspended: false,
    journalCommitFailed: true,
    closed: true,
  });
  expect(failed.firstJournal.load(failed.manifest)).toBeUndefined();
});

test('old writer never reloads or commits even if its journal methods become available again', () => {
  const ctx = fixture();
  let loads = 0;
  let commits = 0;
  const counted: LiveBudgetJournal = {
    identitySha256: ctx.firstJournal.identitySha256,
    load: (manifest) => {
      loads++;
      return ctx.firstJournal.load(manifest);
    },
    commit: (...args) => {
      commits++;
      return ctx.firstJournal.commit(...args);
    },
  };
  const ledger = new LiveBudgetLedger(ctx.manifest, ctx.ledgerOptions(counted));
  complete(ledger);
  const counts = { loads, commits };
  const original = ctx.firstJournal.load(ctx.manifest);
  ledger.suspendForHandoff();
  for (const method of [
    () => reserve(ledger),
    () => ledger.availableResponseBytes(),
    () => ledger.remainingTimeMs(),
    () => ledger.abort(),
  ])
    expect(method).toThrow('suspended');
  expect({ loads, commits }).toEqual(counts);
  expect(ctx.firstJournal.load(ctx.manifest)).toEqual(original);
});

test('suspension is not an interprocess lock: a late unsuspended owner still fails CAS before dispatch', () => {
  const { first, firstJournal, manifest, resume } = fixture();
  const token = reserve(first, 30);
  const other = resume();
  const next = reserve(other.ledger, 30);
  expect(other.ledger.usage()).toMatchObject({
    provider: 2,
    chargedResponseBodyBytes: 0,
    reservedResponseBodyBytes: 30,
  });
  let transportAttempts = 0;
  expect(() => {
    first.dispatch(token);
    transportAttempts++;
  }).toThrow('journal');
  expect(transportAttempts).toBe(0);
  expect(first.usage()).toMatchObject({
    closed: true,
    journalCommitFailed: true,
    localWriterSuspended: false,
  });
  const afterConflict = head(other.journal, manifest);
  expect(() => first.suspendForHandoff()).toThrow('journal');
  expect(() => firstJournal.load(manifest)).toThrow('closed');
  expect(other.journal.load(manifest)).toEqual(afterConflict);
  other.ledger.dispatch(next);
  other.ledger.complete(next, { outcome: 'completed', responseBytes: 5 });
  expect(other.ledger.usage()).toMatchObject({
    provider: 2,
    chargedResponseBodyBytes: 5,
    closed: false,
  });
});

test('resuming never restores human consent even after a legitimate local handoff', () => {
  const { first, firstJournal, manifest, resume, ledgerOptions } = fixture();
  complete(first);
  first.suspendForHandoff();
  firstJournal.close();
  const { journal } = resume();
  const original = head(journal, manifest);
  const denied = new LiveBudgetLedger(manifest, ledgerOptions(journal, false));
  expect(() => denied.availableResponseBytes()).toThrow('authorization');
  expect(() => reserve(denied)).toThrow('authorization');
  expect(journal.load(manifest)).toEqual(original);
  expect(denied.usage()).toMatchObject({
    localWriterSuspended: false,
    durableAcrossProcessRestart: false,
    provider: 0,
  });
});

test('omitting suspension preserves normal settlement, reads and terminal abort behavior', () => {
  const { first, firstJournal, manifest } = fixture();
  complete(first, 10);
  expect(first.availableResponseBytes()).toBe(90);
  expect(first.remainingTimeMs()).toBe(10_000);
  expect(first.usage().localWriterSuspended).toBe(false);
  const token = reserve(first, 30);
  first.dispatch(token);
  first.complete(token, { outcome: 'cancelled' });
  expect(first.usage().chargedResponseBodyBytes).toBe(40);
  first.abort();
  first.abort();
  expect(first.usage()).toMatchObject({ closed: true, localWriterSuspended: false });
  expect(firstJournal.load(manifest)?.state.closed).toBe(true);
});

test('an actual owned offline child resumes the closed old connection without resetting the same authorization', async () => {
  const { first, firstJournal, manifest, path, resume } = fixture({ provider: 2 });
  complete(first, 20);
  first.suspendForHandoff();
  firstJournal.close();
  const script = `
    import { LiveBudgetLedger } from ${JSON.stringify(resolve('tests/acceptance/live-budget.ts'))};
    import { SqliteLiveBudgetJournal } from ${JSON.stringify(resolve('tests/acceptance/live-budget-journal.ts'))};
    const manifest = ${JSON.stringify(manifest)};
    const journal = new SqliteLiveBudgetJournal(${JSON.stringify(path)}, { mode: 'resume' });
    const ledger = new LiveBudgetLedger(manifest, { journal, humanConfirmed: true,
      executionIdentity: { sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 },
      now: () => 1000, monotonic: () => 0 });
    if (ledger.availableResponseBytes() !== 80 || ledger.usage().provider !== 1) process.exit(71);
    const token = ledger.reserve({ caseId: 'C07', kind: 'provider', responseBytes: 30 });
    ledger.dispatch(token);
    ledger.complete(token, { outcome: 'completed', responseBytes: 10 });
    ledger.suspendForHandoff();
    journal.close();
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env: {},
    stdout: 'ignore',
    stderr: 'pipe',
  });
  expect(await child.exited).toBe(0);
  const fresh = resume();
  expect(fresh.ledger.availableResponseBytes()).toBe(70);
  expect(fresh.ledger.usage()).toMatchObject({
    provider: 2,
    chargedResponseBodyBytes: 30,
    closed: false,
    localWriterSuspended: false,
  });
  expect(() => reserve(fresh.ledger, 1)).toThrow('quota');
  expect(() => reserve(first, 1)).toThrow('suspended');
});
