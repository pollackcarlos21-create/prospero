import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  createLiveBudgetManifest,
  LiveBudgetLedger,
  type LiveBudgetState,
} from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import { LiveReconciliationError, reconcileLiveBudget } from '../acceptance/live-reconcile';
import {
  createBudgetedProviderFetch,
  createBudgetedWebClient,
  type LiveTransportReceipt,
} from '../acceptance/live-transport';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
const baseUrl = 'https://provider.example/v1';
let next = 0;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-reconcile-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'budget.sqlite');
  const journal = new SqliteLiveBudgetJournal(databasePath, { mode: 'create' });
  cleanup.push(() => journal.close());
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_reconcile_${++next}`,
    ...identity,
    journalSha256: journal.identitySha256,
    caseIds: ['W01', 'W02'],
    createdAt: 1000,
    expiresAt: 10000,
    limits: {
      provider: 10,
      search: 10,
      page: 10,
      redirects: 3,
      responseBodyBytes: 8 * 1024 * 1024,
      wallClockMs: 9000,
    },
  });
  const options = {
    humanConfirmed: true,
    executionIdentity: identity,
    journal,
    now: () => 1000,
    monotonic: () => 0,
  };
  const ledger = new LiveBudgetLedger(manifest, options);
  cleanup.push(() => {
    try {
      ledger.abort();
    } catch {}
  });
  return { directory, databasePath, journal, manifest, ledger, options };
}
type Fixture = ReturnType<typeof fixture>;
const fakeFetch = (callback: () => Response | Promise<Response>): typeof fetch =>
  ((_input: RequestInfo | URL, _init?: RequestInit) => callback()) as typeof fetch;
function meter(f: Fixture, callback: () => Response | Promise<Response>) {
  return createBudgetedProviderFetch({
    ledger: f.ledger,
    caseId: () => 'W01',
    baseUrl,
    fetchImpl: fakeFetch(callback),
  });
}
async function completed() {
  const f = fixture();
  const request = meter(f, () => new Response('abc'));
  expect(await (await request.fetch(`${baseUrl}/models`)).text()).toBe('abc');
  return { ...f, receipts: request.receipts() };
}
function check(
  f: Pick<Fixture, 'databasePath' | 'manifest'>,
  receipts: readonly LiveTransportReceipt[] = [],
) {
  return reconcileLiveBudget({ databasePath: f.databasePath, manifest: f.manifest, receipts });
}
function observer(path: string) {
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  return db;
}
function resume(f: Fixture) {
  const journal = new SqliteLiveBudgetJournal(f.databasePath, { mode: 'resume' });
  cleanup.push(() => journal.close());
  const ledger = new LiveBudgetLedger(f.manifest, { ...f.options, journal });
  cleanup.push(() => ledger.abort());
  return ledger;
}
const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('read-only reconciliation reconstructs reservation, intent, known EOF settlement and receipt membership', async () => {
  const f = await completed();
  const before = hashFile(f.databasePath);
  const result = check(f, f.receipts);
  expect(result.status).toBe('reconciled');
  expect(result.accountingComplete).toBe(true);
  expect(result.transportEvidenceComplete).toBe(true);
  expect(result.revision).toBe(3);
  expect(result.counts).toMatchObject({
    requests: { provider: 1, search: 0, page: 0, redirects: 0 },
    dispatchIntents: 1,
    settledReservations: 1,
    chargedBytes: 3,
    reservedBytes: 0,
    unknownSettlements: 0,
    observedTransportAttempts: 1,
    unknownTransportAttempts: 0,
  });
  expect(result.facts[0]).toMatchObject({
    dispatchIntent: true,
    accountingSettled: true,
    charge: 'known',
    chargedBytes: 3,
    reservedRevision: 1,
    dispatchRevision: 2,
    settlementRevision: 3,
    settlementMechanism: 'settled',
    transportAttempted: true,
  });
  expect(result.facts[0]?.receipt).toEqual(f.receipts[0]);
  expect(Object.isFrozen(result.facts[0])).toBe(true);
  expect(Object.isFrozen(result.facts[0]?.receipt)).toBe(true);
  expect(hashFile(f.databasePath)).toBe(before);
  expect(result).not.toHaveProperty('humanConfirmed');
  expect(result).not.toHaveProperty('token');
});

test('unknown cancelled response accounting is full cap while the original observed prefix remains unchanged', async () => {
  const f = fixture();
  const request = meter(
    f,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('prefix'));
          },
        }),
      ),
  );
  const response = await request.fetch(`${baseUrl}/models`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing fixture response stream');
  expect((await reader.read()).value?.byteLength).toBe(6);
  await reader.cancel();
  const original = request.receipts();
  const result = check(f, original);
  expect(result.status).toBe('reconciled');
  expect(result.facts[0]).toMatchObject({
    charge: 'unknown',
    chargedBytes: 4 * 1024 * 1024,
    transportAttempted: true,
  });
  expect(result.facts[0]?.receipt).toEqual(original[0]);
  expect(original[0]).toMatchObject({ observedBytes: 6, bytesKnown: false, outcome: 'cancelled' });
  expect(result.counts.unknownSettlements).toBe(1);
});

test('missing settled receipt leaves transport evidence pending without turning known charge into zero', async () => {
  const f = await completed();
  const result = check(f);
  expect(result.status).toBe('pending');
  expect(result.accountingComplete).toBe(true);
  expect(result.transportEvidenceComplete).toBe(false);
  expect(result.facts[0]).toMatchObject({
    charge: 'known',
    chargedBytes: 3,
    receipt: null,
    transportAttempted: 'unknown',
  });
  expect(result.counts.observedTransportAttempts).toBe(0);
  expect(result.counts.unknownTransportAttempts).toBe(1);
  expect(result.gaps[0]?.reason).toBe('missing-receipt');
});

test('still-open provider response produces unresolved accounting and unfinished receipt gaps', async () => {
  const f = fixture();
  const request = meter(
    f,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('held'));
          },
        }),
      ),
  );
  const response = await request.fetch(`${baseUrl}/models`);
  const result = check(f, request.receipts());
  expect(result.status).toBe('pending');
  expect(result.accountingComplete).toBe(false);
  expect(result.transportEvidenceComplete).toBe(false);
  expect(result.facts[0]).toMatchObject({
    accountingSettled: false,
    charge: 'pending',
    chargedBytes: null,
    transportAttempted: true,
  });
  expect(result.gaps.map((gap) => gap.reason)).toEqual([
    'unresolved-reservation',
    'unfinished-receipt',
  ]);
  await response.body?.cancel();
});

test('an earlier pending receipt remains unfinished evidence after a later durable EOF settlement', async () => {
  const f = fixture();
  const request = meter(f, () => new Response('abc'));
  const response = await request.fetch(`${baseUrl}/models`);
  const earlier = request.receipts();
  expect(earlier[0]?.outcome).toBe('pending');
  expect(await response.text()).toBe('abc');
  const result = check(f, earlier);
  expect(result.status).toBe('pending');
  expect(result.accountingComplete).toBe(true);
  expect(result.transportEvidenceComplete).toBe(false);
  expect(result.facts[0]).toMatchObject({ charge: 'known', chargedBytes: 3, receipt: earlier[0] });
  expect(result.gaps[0]?.reason).toBe('unfinished-receipt');
  const preAttempt = {
    ...earlier[0],
    transportAttempted: false,
    status: null,
  } as LiveTransportReceipt;
  expect(check(f, [preAttempt]).facts[0]?.transportAttempted).toBe('unknown');
  expect(check(f, [preAttempt]).counts.unknownTransportAttempts).toBe(1);
});

test('mixed Web search and redirect receipts reconcile by case, kind and each raw request cap', async () => {
  const f = fixture();
  const providerRequest = meter(f, () => new Response('abc'));
  await (await providerRequest.fetch(`${baseUrl}/models`)).text();
  const html =
    '<html><head><title>Offline reconciliation fixture</title></head><body><p>Public synthetic content exists only for offline accounting tests.</p></body></html>';
  const searchBody = JSON.stringify({
    type: 'search',
    web: {
      results: [
        {
          url: 'https://public.example/paper',
          title: 'Offline fixture',
          description: 'Synthetic source.',
        },
      ],
    },
  });
  const request = createBudgetedWebClient({
    ledger: f.ledger,
    caseId: () => 'W02',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (input) =>
        input.url.hostname === 'api.search.brave.com'
          ? {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: Buffer.from(searchBody),
            }
          : input.url.pathname === '/start'
            ? { status: 302, headers: { location: '/final' }, body: Buffer.from('redirect') }
            : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) },
    },
  });
  expect(await request.client.search('offline fixture')).toHaveLength(1);
  expect((await request.client.fetchPage('https://public.example/start')).title).toBe(
    'Offline reconciliation fixture',
  );
  const result = check(f, [...providerRequest.receipts(), ...request.receipts()]);
  expect(result.status).toBe('reconciled');
  expect(result.counts.requests).toEqual({ provider: 1, search: 1, page: 2, redirects: 1 });
  expect(result.counts.chargedBytes).toBe(
    3 + Buffer.byteLength(searchBody) + Buffer.byteLength('redirect') + Buffer.byteLength(html),
  );
  expect(
    result.facts.map(({ caseId, kind, redirect, capBytes }) => ({
      caseId,
      kind,
      redirect,
      capBytes,
    })),
  ).toEqual([
    { caseId: 'W01', kind: 'provider', redirect: false, capBytes: 4 * 1024 * 1024 },
    { caseId: 'W02', kind: 'search', redirect: false, capBytes: 512 * 1024 },
    { caseId: 'W02', kind: 'page', redirect: false, capBytes: 2 * 1024 * 1024 },
    { caseId: 'W02', kind: 'page', redirect: true, capBytes: 2 * 1024 * 1024 - 8 },
  ]);
  expect(JSON.stringify(result)).not.toContain('offline-dummy-key');
  expect(JSON.stringify(result)).not.toContain('https://');
});

test('out-of-order settlements cannot be validated by matching only aggregate response bytes', async () => {
  const f = fixture();
  let release: (response: Response) => void = () => {
    throw new Error('Missing held response initializer');
  };
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const first = meter(f, () => held);
  const second = meter(f, () => new Response('abc'));
  const firstPending = first.fetch(`${baseUrl}/models`);
  await (await second.fetch(`${baseUrl}/models`)).text();
  release(new Response('xy'));
  await (await firstPending).text();
  const receipts = [...first.receipts(), ...second.receipts()];
  const result = check(f, receipts);
  expect(result.counts.chargedBytes).toBe(5);
  expect(result.facts.map((fact) => fact.chargedBytes)).toEqual([2, 3]);
  expect(() =>
    check(
      f,
      receipts.map((item, index) => ({ ...item, observedBytes: index === 0 ? 3 : 2 })),
    ),
  ).toThrow('accounting');
});

test('receipt settlement commit failure is independently accounted by recovery without rewriting its EOF facts', async () => {
  const f = fixture();
  const db = observer(f.databasePath);
  db.exec(
    "CREATE TRIGGER failed_settlement BEFORE INSERT ON budget_records WHEN NEW.event = 'settled' BEGIN SELECT RAISE(FAIL, 'PRIVATE_SQL_CANARY'); END",
  );
  const request = meter(f, () => new Response('abc'));
  await expect((await request.fetch(`${baseUrl}/models`)).text()).rejects.toThrow('journal');
  const original = request.receipts();
  expect(check(f, original).accountingComplete).toBe(false);
  db.exec('DROP TRIGGER failed_settlement');
  const unapproved = new LiveBudgetLedger(f.manifest, { ...f.options, humanConfirmed: false });
  expect(() => unapproved.availableResponseBytes()).toThrow('authorization');
  expect(check(f, original).revision).toBe(2);
  const recovered = resume(f);
  recovered.availableResponseBytes();
  const result = check(f, original);
  expect(result.status).toBe('reconciled');
  expect(result.accountingComplete).toBe(true);
  expect(result.facts[0]).toMatchObject({
    accountingSettled: true,
    settlementMechanism: 'recovered',
    charge: 'unknown',
    chargedBytes: 4 * 1024 * 1024,
    transportAttempted: true,
  });
  expect(result.facts[0]?.receipt).toEqual(original[0]);
  expect(result.facts[0]?.receipt).toMatchObject({
    outcome: 'completed',
    observedBytes: 3,
    bytesKnown: true,
    ledgerSettled: false,
    failure: 'journal',
  });
});

test('recovered pre-dispatch journal failure proves zero transport while preserving the consumed request slot', async () => {
  const f = fixture();
  const db = observer(f.databasePath);
  db.exec(
    "CREATE TRIGGER failed_dispatch BEFORE INSERT ON budget_records WHEN NEW.event = 'dispatch' BEGIN SELECT RAISE(FAIL, 'PRIVATE_SQL_CANARY'); END",
  );
  let calls = 0;
  const request = meter(f, () => {
    calls++;
    return new Response('unused');
  });
  await expect(request.fetch(`${baseUrl}/models`)).rejects.toThrow('journal');
  db.exec('DROP TRIGGER failed_dispatch');
  resume(f).availableResponseBytes();
  const result = check(f, request.receipts());
  expect(calls).toBe(0);
  expect(result.status).toBe('reconciled');
  expect(result.counts.requests.provider).toBe(1);
  expect(result.counts.dispatchIntents).toBe(0);
  expect(result.counts.chargedBytes).toBe(0);
  expect(result.counts.unknownTransportAttempts).toBe(0);
  expect(result.facts[0]).toMatchObject({
    dispatchIntent: false,
    charge: 'not-dispatched',
    accountingSettled: true,
    chargedBytes: 0,
    transportAttempted: false,
  });
  expect(result.facts[0]?.receipt?.failure).toBe('journal');
});

test('a persisted dispatch intent with failed acknowledgment can coexist with a proven zero raw attempt', async () => {
  const f = fixture();
  const backing = f.journal;
  const ambiguous = {
    identitySha256: backing.identitySha256,
    load: backing.load.bind(backing),
    commit: (...args: Parameters<typeof backing.commit>) => {
      const revision = backing.commit(...args);
      if (args[3] === 'dispatch') throw new Error('PRIVATE_ACKNOWLEDGMENT_CANARY');
      return revision;
    },
  };
  f.ledger = new LiveBudgetLedger(f.manifest, { ...f.options, journal: ambiguous });
  let attempts = 0;
  const request = meter(f, () => {
    attempts++;
    return new Response('unused');
  });
  await expect(request.fetch(`${baseUrl}/models`)).rejects.toThrow('journal');
  const original = request.receipts();
  expect(original[0]).toMatchObject({
    transportAttempted: false,
    outcome: 'rejected',
    bytesKnown: true,
    observedBytes: 0,
  });
  expect(check(f, original).facts[0]?.dispatchIntent).toBe(true);
  resume(f).availableResponseBytes();
  const result = check(f, original);
  expect(attempts).toBe(0);
  expect(result.status).toBe('reconciled');
  expect(result.facts[0]).toMatchObject({
    dispatchIntent: true,
    accountingSettled: true,
    charge: 'unknown',
    chargedBytes: 4 * 1024 * 1024,
    transportAttempted: false,
    receipt: original[0],
  });
  expect(result.counts.dispatchIntents).toBe(1);
  expect(result.counts.observedTransportAttempts).toBe(0);
  expect(result.counts.unknownTransportAttempts).toBe(0);
});

test('global closed recovery accounting accepts an accurately failed receipt without overwriting its settlement flag', async () => {
  const f = fixture();
  const request = meter(
    f,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('held'));
          },
        }),
      ),
  );
  const controller = new AbortController();
  const response = await request.fetch(`${baseUrl}/models`, { signal: controller.signal });
  f.ledger.abort();
  controller.abort();
  const original = request.receipts();
  const result = check(f, original);
  expect(result.status).toBe('reconciled');
  expect(result.counts.closed).toBe(true);
  expect(result.facts[0]).toMatchObject({
    accountingSettled: true,
    settlementMechanism: 'closed',
    charge: 'unknown',
    chargedBytes: 4 * 1024 * 1024,
  });
  expect(result.facts[0]?.receipt).toEqual(original[0]);
  expect(result.facts[0]?.receipt?.ledgerSettled).toBe(false);
  await response.body?.cancel().catch(() => {});
});

test('every receipt identity, case, kind, redirect, cap and byte charge must match the complete history', async () => {
  const f = await completed();
  const original = f.receipts[0];
  if (!original) throw new Error('Missing fixture receipt');
  const mutations: Partial<LiveTransportReceipt>[] = [
    { reservationId: 'unregistered_receipt' },
    { caseId: 'W02' },
    { kind: 'page' },
    { redirect: true },
    { reservedBytes: original.reservedBytes - 1 },
    { observedBytes: 2 },
    { bytesKnown: false },
    { status: 0 },
  ];
  for (const mutation of mutations)
    expect(() => check(f, [{ ...original, ...mutation }])).toThrow(LiveReconciliationError);
  expect(() => check(f, [original, original])).toThrow('receipt');
  const extra = { ...original, body: 'PRIVATE_BODY_CANARY' };
  expect(() => check(f, [extra])).toThrow('receipt');
  const nested = {
    ...original,
    failure: { toString: () => 'journal', secret: 'PRIVATE_BODY_CANARY' },
  };
  expect(() => check(f, [nested as unknown as LiveTransportReceipt])).toThrow('receipt');
});

test('CAS loser cannot manufacture a dispatch after recovery consumed its old reservation', () => {
  const f = fixture();
  const token = f.ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
  const reservationId = f.ledger.reservationId(token);
  const second = resume(f);
  second.availableResponseBytes();
  expect(() => f.ledger.dispatch(token)).toThrow('journal');
  const result = check(f, [
    {
      reservationId,
      caseId: 'W01',
      kind: 'provider',
      redirect: false,
      transportAttempted: false,
      outcome: 'rejected',
      status: null,
      reservedBytes: 100,
      observedBytes: 0,
      bytesKnown: true,
      ledgerSettled: false,
      failure: 'journal',
    },
  ]);
  expect(result.status).toBe('reconciled');
  expect(result.revision).toBe(2);
  expect(result.facts[0]).toMatchObject({
    dispatchIntent: false,
    chargedBytes: 0,
    transportAttempted: false,
    settlementMechanism: 'recovered',
  });
});

test('closed batches independently attribute full cap only to entries with committed dispatch intents', () => {
  const f = fixture();
  const first = f.ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
  f.ledger.reserve({ caseId: 'W02', kind: 'page', redirect: true, responseBytes: 150 });
  f.ledger.dispatch(first);
  f.ledger.abort();
  const result = check(f);
  expect(result.status).toBe('pending');
  expect(result.accountingComplete).toBe(true);
  expect(result.counts.requests).toEqual({ provider: 1, search: 0, page: 1, redirects: 1 });
  expect(result.counts.chargedBytes).toBe(100);
  expect(
    result.facts.map((fact) => ({
      charge: fact.charge,
      chargedBytes: fact.chargedBytes,
      attempted: fact.transportAttempted,
    })),
  ).toEqual([
    { charge: 'unknown', chargedBytes: 100, attempted: 'unknown' },
    { charge: 'not-dispatched', chargedBytes: 0, attempted: false },
  ]);
});

test('a valid final state and valid hash chain cannot replace missing reservation transitions', () => {
  const f = fixture();
  const invented: LiveBudgetState = {
    version: 1,
    requests: { provider: 1, search: 0, page: 0, redirects: 0 },
    chargedBytes: 23,
    reservedBytes: 0,
    dispatched: 1,
    settled: 1,
    unknownReceipts: 0,
    closed: false,
    clockFloor: 1000,
    pending: [],
  };
  f.journal.commit(f.manifest, 0, invented, 'settled');
  expect(f.journal.load(f.manifest)?.state).toEqual(invented);
  expect(() => check(f)).toThrow('accounting');
});

test('even hash-valid dispatch history cannot change a reservation cap or case', () => {
  const f = fixture();
  f.ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
  const saved = f.journal.load(f.manifest);
  if (!saved) throw new Error('Missing fixture journal');
  const changed: LiveBudgetState = {
    ...saved.state,
    reservedBytes: 90,
    dispatched: 1,
    pending: saved.state.pending.map((entry) => ({
      ...entry,
      caseId: 'W02',
      bytes: 90,
      dispatched: true,
    })),
  };
  f.journal.commit(f.manifest, saved.revision, changed, 'dispatch');
  expect(() => check(f)).toThrow('accounting');
});

test('transport receipt cannot claim an attempted request without a committed dispatch intent', () => {
  const f = fixture();
  const token = f.ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
  const id = f.ledger.reservationId(token);
  f.ledger.complete(token, { outcome: 'cancelled', responseBytes: 0 });
  expect(() =>
    check(f, [
      {
        reservationId: id,
        caseId: 'W01',
        kind: 'provider',
        redirect: false,
        transportAttempted: true,
        outcome: 'completed',
        status: 200,
        reservedBytes: 100,
        observedBytes: 0,
        bytesKnown: true,
        ledgerSettled: true,
        failure: null,
      },
    ]),
  ).toThrow('accounting');
});

test('identity, schema-only absence and corrupt storage fail closed without sensitive diagnostic data', async () => {
  const f = await completed();
  const copied = join(f.directory, 'copied.sqlite');
  copyFileSync(f.databasePath, copied);
  expect(() =>
    reconcileLiveBudget({ databasePath: copied, manifest: f.manifest, receipts: f.receipts }),
  ).toThrow('identity');
  const empty = fixture();
  expect(() => check(empty)).toThrow('history');
  const corrupt = join(f.directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'PRIVATE_DATABASE_CANARY');
  const alternate = createLiveBudgetManifest({
    authorizationId: 'offline_corrupt_identity',
    ...identity,
    journalSha256: createHash('sha256').update(corrupt).digest('hex'),
    caseIds: ['W01'],
    createdAt: 1000,
    expiresAt: 10000,
    limits: f.manifest.limits,
  });
  let caught: unknown;
  try {
    reconcileLiveBudget({ databasePath: corrupt, manifest: alternate, receipts: [] });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LiveReconciliationError);
  expect(String(caught)).not.toContain('PRIVATE_DATABASE_CANARY');
  expect(String(caught)).not.toContain(f.directory);
});

test('independent hash-chain verification rejects altered records even when the immutable trigger is restored', async () => {
  const f = await completed();
  const db = observer(f.databasePath);
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_records_no_update'")
    .get();
  if (typeof existing?.sql !== 'string') throw new Error('Missing fixture immutable trigger');
  db.exec('DROP TRIGGER budget_records_no_update');
  db.prepare('UPDATE budget_records SET record_hash = ? WHERE sequence = 2').run(
    'PRIVATE_HASH_CANARY',
  );
  db.exec(existing.sql);
  let caught: unknown;
  try {
    check(f, f.receipts);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LiveReconciliationError);
  expect(String(caught)).toContain('history');
  expect(String(caught)).not.toContain('PRIVATE_HASH_CANARY');
});

test('actual child crash leaves unknown dispatch evidence, then recovery accounts it without fabricating receipt or approval', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-reconcile-child-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'child.sqlite');
  const journalModule = pathToFileURL(
    join(import.meta.dir, '../acceptance/live-budget-journal.ts'),
  ).href;
  const budgetModule = pathToFileURL(join(import.meta.dir, '../acceptance/live-budget.ts')).href;
  const publicInput = {
    authorizationId: `offline_child_reconcile_${++next}`,
    ...identity,
    caseIds: ['W01'],
    createdAt: 1000,
    expiresAt: 10000,
    limits: {
      provider: 3,
      search: 1,
      page: 1,
      redirects: 0,
      responseBodyBytes: 1024,
      wallClockMs: 9000,
    },
  };
  const child = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { SqliteLiveBudgetJournal } from ${JSON.stringify(journalModule)};
    import { createLiveBudgetManifest, LiveBudgetLedger } from ${JSON.stringify(budgetModule)};
    const journal = new SqliteLiveBudgetJournal(${JSON.stringify(databasePath)}, { mode: 'create' });
    const manifest = createLiveBudgetManifest({ ...${JSON.stringify(publicInput)}, journalSha256: journal.identitySha256 });
    const ledger = new LiveBudgetLedger(manifest, { humanConfirmed: true, executionIdentity: ${JSON.stringify(identity)}, journal, now: () => 1000, monotonic: () => 0 });
    const token = ledger.reserve({ caseId: 'W01', kind: 'provider', responseBytes: 100 });
    ledger.dispatch(token);
    process.exit(23);
  `,
    ],
    { env: { PATH: process.env.PATH ?? '' }, timeout: 10000 },
  );
  expect(child.exitCode).toBe(23);
  const journal = new SqliteLiveBudgetJournal(databasePath, { mode: 'resume' });
  cleanup.push(() => journal.close());
  const manifest = createLiveBudgetManifest({
    ...publicInput,
    journalSha256: journal.identitySha256,
  });
  const before = check({ databasePath, manifest });
  expect(before.status).toBe('pending');
  expect(before.accountingComplete).toBe(false);
  expect(before.facts[0]).toMatchObject({
    dispatchIntent: true,
    charge: 'pending',
    chargedBytes: null,
    transportAttempted: 'unknown',
    receipt: null,
  });
  const unapproved = new LiveBudgetLedger(manifest, {
    humanConfirmed: false,
    executionIdentity: identity,
    journal,
    now: () => 1000,
    monotonic: () => 0,
  });
  expect(() => unapproved.availableResponseBytes()).toThrow('authorization');
  expect(check({ databasePath, manifest }).revision).toBe(2);
  const recovered = new LiveBudgetLedger(manifest, {
    humanConfirmed: true,
    executionIdentity: identity,
    journal,
    now: () => 1000,
    monotonic: () => 0,
  });
  cleanup.push(() => recovered.abort());
  expect(recovered.availableResponseBytes()).toBe(924);
  const after = check({ databasePath, manifest });
  expect(after.status).toBe('pending');
  expect(after.accountingComplete).toBe(true);
  expect(after.transportEvidenceComplete).toBe(false);
  expect(after.counts.unknownTransportAttempts).toBe(1);
  expect(after.counts.observedTransportAttempts).toBe(0);
  expect(after.facts[0]).toMatchObject({
    charge: 'unknown',
    chargedBytes: 100,
    accountingSettled: true,
    settlementMechanism: 'recovered',
    transportAttempted: 'unknown',
    receipt: null,
  });
});
