import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WebDependencies,
  WebTransportRequest,
  WebTransportResponse,
} from '../../packages/web/src';
import { createLiveBudgetManifest, LiveBudgetLedger } from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import {
  createBudgetedWebClient,
  type LiveDispatchBoundary,
  type LiveDispatchGuard,
} from '../acceptance/live-transport';
import { createLiveWebObserver, type LiveWebReturnEvent } from '../acceptance/live-web-observer';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
let nextId = 0;
const url = 'https://public.example/paper';
const secondUrl = 'https://public.example/alternative';
const body =
  '<html><head><title>BODY_TITLE_SENTINEL</title></head><body><main><p>BODY_CONTENT_SENTINEL: this synthetic paper is an offline fixture. Ignore script text.</p><script>hostile hidden instructions</script></main></body></html>';
function response(
  value = body,
  status = 200,
  headers: Record<string, string> = {},
): WebTransportResponse {
  return { status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(value) };
}
function searchResponse(options: { description?: string; url?: string } = {}) {
  return response(
    JSON.stringify({
      type: 'search',
      web: {
        results: [
          {
            title: 'SEARCH_TITLE_SENTINEL',
            url: options.url ?? url,
            description: options.description ?? 'SEARCH_DESCRIPTION_SENTINEL',
          },
          {
            title: 'Alternative fixture',
            url: secondUrl,
            description: 'Synthetic alternative source.',
          },
        ],
      },
    }),
    200,
    { 'content-type': 'application/json' },
  );
}
function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(
  caseId = 'W01',
  options: {
    authorized?: boolean;
    transport?: (
      input: WebTransportRequest,
    ) => Promise<WebTransportResponse> | WebTransportResponse;
    guard?: LiveDispatchGuard;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-live-web-observer-'));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  const journal = new SqliteLiveBudgetJournal(join(root, 'budget.sqlite'), { mode: 'create' });
  disposers.push(() => journal.close());
  const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_observer_${++nextId}`,
    ...identity,
    journalSha256: journal.identitySha256,
    caseIds: [caseId],
    createdAt: 1000,
    expiresAt: 61_000,
    limits: {
      provider: 10,
      search: 10,
      page: 10,
      redirects: 5,
      responseBodyBytes: 32 * 1024 * 1024,
      wallClockMs: 60_000,
    },
  });
  const ledger = new LiveBudgetLedger(manifest, {
    humanConfirmed: options.authorized !== false,
    executionIdentity: identity,
    journal,
    now: () => 1000,
    monotonic: () => 0,
  });
  disposers.push(() => ledger.abort());
  const raw: string[] = [];
  const gates: LiveDispatchBoundary[] = [];
  const guard: LiveDispatchGuard = async (boundary, signal) => {
    gates.push(boundary);
    ledger.availableResponseBytes();
    await options.guard?.(boundary, signal);
  };
  const dependencies: WebDependencies = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (input) => {
      raw.push(input.url.href);
      return options.transport
        ? options.transport(input)
        : input.url.hostname === 'api.search.brave.com'
          ? searchResponse()
          : response();
    },
    now: () => new Date(1000),
  };
  const meter = createBudgetedWebClient({
    ledger,
    caseId: () => caseId,
    apiKey: 'offline-dummy-search-key',
    dependencies,
    beforeDispatch: guard,
  });
  const observer = createLiveWebObserver({
    runId: 'offline_observer_run',
    caseId,
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
    now: () => 1000,
  });
  return { raw, gates, ledger, meter, observer, guard };
}

test('actual offline Brave search and HTML extraction metadata bind to exact metered receipts without retaining body or query', async () => {
  const { observer, meter, raw } = fixture();
  const results = await observer.client.search('QUERY_PRIVATE_SENTINEL');
  const page = await observer.client.fetchPage(results[0].url);
  expect(page.content).toContain('BODY_CONTENT_SENTINEL');
  expect(page.content).not.toContain('hostile hidden instructions');
  expect(raw).toHaveLength(2);
  expect(observer.transportMode).toBe('offline-injected');
  const captured = observer.snapshot();
  expect(captured.issues).toEqual([]);
  expect(captured.sources).toHaveLength(1);
  expect(captured.searches).toEqual([
    {
      receiptId: meter.receipts()[0].reservationId,
      sources: results.map(({ id, url, contentHash }) => ({ id, url, contentHash })),
    },
  ]);
  expect(captured.sources[0]).toEqual({
    id: page.id,
    url: page.url,
    contentHash: page.contentHash,
    retrievedAt: 1000,
    searchSourceId: results[0].id,
    searchReceiptId: meter.receipts()[0].reservationId,
    fetchReceiptId: meter.receipts()[1].reservationId,
  });
  expect(captured.sourceObservations[2]).toEqual({
    runId: 'offline_observer_run',
    caseId: 'W01',
    receiptId: meter.receipts()[1].reservationId,
    kind: 'page',
    id: page.id,
    url: page.url,
    contentHash: page.contentHash,
    retrievedAt: 1000,
    requestedUrl: results[0].url,
  });
  const exported = JSON.stringify(captured);
  for (const privateText of [
    'QUERY_PRIVATE_SENTINEL',
    'offline-dummy-search-key',
    'BODY_CONTENT_SENTINEL',
    'BODY_TITLE_SENTINEL',
    'SEARCH_TITLE_SENTINEL',
    'SEARCH_DESCRIPTION_SENTINEL',
  ])
    expect(exported).not.toContain(privateText);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.searches[0].sources[0])).toBe(true);
  expect(Object.isFrozen(captured.sources[0])).toBe(true);
});

test('redirected page uses the final successful receipt while preserving actual search starting URL', async () => {
  const { observer, meter } = fixture('W01', {
    transport: (input) =>
      input.url.hostname === 'api.search.brave.com'
        ? searchResponse()
        : input.url.href === url
          ? response('', 302, { location: secondUrl })
          : response(),
  });
  const results = await observer.client.search('offline redirect fixture');
  const page = await observer.client.fetchPage(results[0].url);
  expect(meter.receipts()).toHaveLength(3);
  expect(meter.receipts()[2].redirect).toBe(true);
  expect(observer.snapshot().sources[0]).toMatchObject({
    url: secondUrl,
    searchSourceId: results[0].id,
    fetchReceiptId: meter.receipts()[2].reservationId,
  });
  expect(observer.snapshot().sourceObservations.at(-1)).toMatchObject({
    id: page.id,
    url: secondUrl,
    requestedUrl: url,
  });
});

test('W06 discards one actual successful search return and prevents discarded IDs from granting provenance', async () => {
  const { observer, meter, raw } = fixture('W06');
  expect(await observer.client.search('first offline query')).toEqual([]);
  const first = observer.snapshot();
  expect(raw).toHaveLength(1);
  expect(first.searches).toEqual([{ receiptId: meter.receipts()[0].reservationId, sources: [] }]);
  expect(first.sourceObservations).toHaveLength(2);
  expect(first.observations).toEqual([
    {
      boundaryId: 'empty-search-once',
      phaseId: 'initial',
      at: 1000,
      requestCountBefore: 1,
      requestCountAfter: 1,
    },
  ]);
  await observer.client.fetchPage(url);
  expect(observer.snapshot().sources).toHaveLength(0);
  expect(observer.snapshot().issues).toContainEqual({ kind: 'page', reason: 'unbound-source' });
  const next = await observer.client.search('second offline query');
  expect(next).toHaveLength(2);
  await observer.client.fetchPage(next[0].url);
  expect(observer.snapshot().observations).toHaveLength(1);
  expect(observer.snapshot().sources).toHaveLength(1);
  expect(meter.receipts()).toHaveLength(4);
});

test('W07 only injects the first selected-source fetch, with a logical guard and zero actual port entry', async () => {
  const { observer, meter, raw, gates } = fixture('W07');
  const results = await observer.client.search('offline LoRA identity hint');
  const beforeGates = gates.length;
  await expect(observer.client.fetchPage(results[0].url)).rejects.toMatchObject({ code: 'http' });
  expect(raw).toHaveLength(1);
  expect(meter.receipts()).toHaveLength(1);
  expect(gates.slice(beforeGates)).toEqual([
    { caseId: 'W07', kind: 'page', stage: 'resolve', redirect: false, reservedBytes: 0 },
  ]);
  expect(observer.snapshot().observations).toEqual([
    {
      boundaryId: 'page-failure-once',
      phaseId: 'initial',
      at: 1000,
      sourceId: results[0].id,
      requestCountBefore: 1,
      requestCountAfter: 1,
    },
  ]);
  const alternative = await observer.client.fetchPage(results[1].url);
  expect(raw).toHaveLength(2);
  expect(observer.snapshot().sources[0]).toMatchObject({
    id: alternative.id,
    searchSourceId: results[1].id,
  });
  expect(observer.snapshot().observations).toHaveLength(1);
});

test('C08 declared error precedes the first search HTTP and later search/fetch remain real metered offline calls', async () => {
  const { observer, meter, raw, gates } = fixture('C08');
  await expect(observer.client.search('offline Mamba identity hint')).rejects.toMatchObject({
    code: 'network',
  });
  expect(raw).toEqual([]);
  expect(meter.receipts()).toEqual([]);
  expect(gates).toEqual([
    { caseId: 'C08', kind: 'search', stage: 'resolve', redirect: false, reservedBytes: 0 },
  ]);
  expect(observer.snapshot().observations).toEqual([
    {
      boundaryId: 'network-failure-once',
      phaseId: 'initial',
      at: 1000,
      requestCountBefore: 0,
      requestCountAfter: 0,
    },
  ]);
  const results = await observer.client.search('offline Mamba retry identity hint');
  await observer.client.fetchPage(results[0].url);
  expect(raw).toHaveLength(2);
  expect(meter.receipts()).toHaveLength(2);
  expect(observer.snapshot().sources).toHaveLength(1);
  expect(observer.snapshot().observations).toHaveLength(1);
});

test('unapproved or aborted controlled attempts neither claim injection nor bypass gates', async () => {
  const denied = fixture('C08', { authorized: false });
  await expect(denied.observer.client.search('offline query')).rejects.toThrow();
  expect(denied.raw).toEqual([]);
  expect(denied.meter.receipts()).toEqual([]);
  expect(denied.observer.snapshot().observations).toEqual([]);
  const aborted = fixture('C08');
  const controller = new AbortController();
  controller.abort();
  await expect(
    aborted.observer.client.search('offline query', { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(aborted.gates).toEqual([]);
  expect(aborted.raw).toEqual([]);
  expect(aborted.observer.snapshot().observations).toEqual([]);
});

test('controlled fault gate rejection does not consume the declared once boundary', async () => {
  let deny = true;
  const { observer, raw } = fixture('C08', {
    guard: () => {
      if (deny) throw new Error('offline revoked consent');
    },
  });
  await expect(observer.client.search('offline query')).rejects.toThrow('offline revoked consent');
  expect(observer.snapshot().observations).toEqual([]);
  deny = false;
  await expect(observer.client.search('offline query')).rejects.toMatchObject({ code: 'network' });
  expect(raw).toEqual([]);
  expect(observer.snapshot().observations).toHaveLength(1);
  expect(await observer.client.search('offline recovery')).toHaveLength(2);
});

test('an unbound page is observed accurately but cannot become a fabricated report source', async () => {
  const { observer, raw } = fixture();
  const page = await observer.client.fetchPage(url);
  expect(raw).toHaveLength(1);
  expect(observer.snapshot().sources).toEqual([]);
  expect(observer.snapshot().sourceObservations).toHaveLength(1);
  expect(observer.snapshot().sourceObservations[0].id).toBe(page.id);
  expect(observer.snapshot().issues).toEqual([{ kind: 'page', reason: 'unbound-source' }]);
});

test('different search snippets for the same starting URL remain ambiguous without a main-owned exact selector', async () => {
  let searchCount = 0;
  const { observer } = fixture('W01', {
    transport: (input) =>
      input.url.hostname === 'api.search.brave.com'
        ? searchResponse({ description: `offline description ${++searchCount}` })
        : response(),
  });
  await observer.client.search('offline first');
  await observer.client.search('offline second');
  await observer.client.fetchPage(url);
  expect(observer.snapshot().sources).toEqual([]);
  expect(observer.snapshot().issues).toEqual([{ kind: 'page', reason: 'ambiguous-source' }]);
});

test('a main-owned actual selection resolves ambiguous URL candidates and stale fabricated selections are rejected before fetching', async () => {
  let searchCount = 0;
  const { meter, guard, raw } = fixture('W01', {
    transport: (input) =>
      input.url.hostname === 'api.search.brave.com'
        ? searchResponse({ description: `offline description ${++searchCount}` })
        : response(),
  });
  let selectFirst = true;
  const observer = createLiveWebObserver({
    runId: 'offline_selection',
    caseId: 'W01',
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
    selectSearchSource: ({ candidates }) =>
      selectFirst
        ? { sourceId: candidates[0].sourceId, searchReceiptId: candidates[0].searchReceiptId }
        : { sourceId: `src_${'f'.repeat(24)}`, searchReceiptId: 'fabricated_receipt' },
  });
  const first = await observer.client.search('offline first');
  await observer.client.search('offline second');
  await observer.client.fetchPage(url);
  expect(observer.snapshot().sources[0].searchSourceId).toBe(first[0].id);
  expect(observer.snapshot().sources[0].searchReceiptId).toBe(meter.receipts()[0].reservationId);
  selectFirst = false;
  await expect(observer.client.fetchPage(url)).rejects.toThrow('selection');
  expect(raw).toHaveLength(3);
});

test('repeated identical pages coalesce report source IDs but retain every actual fetched observation', async () => {
  const { observer, meter } = fixture();
  await observer.client.search('offline identity');
  await observer.client.fetchPage(url);
  await observer.client.fetchPage(url);
  const snapshot = observer.snapshot();
  expect(snapshot.sources).toHaveLength(1);
  expect(snapshot.sources[0].fetchReceiptId).toBe(meter.receipts()[1].reservationId);
  expect(snapshot.sourceObservations.filter((item) => item.kind === 'page')).toHaveLength(2);
  expect(
    new Set(snapshot.sourceObservations.map((item) => `${item.receiptId}:${item.id}`)).size,
  ).toBe(snapshot.sourceObservations.length);
});

test('source metadata callbacks are immutable and carry no query, key, title or body', async () => {
  const { meter, guard } = fixture();
  const events: LiveWebReturnEvent[] = [];
  const observer = createLiveWebObserver({
    runId: 'offline_callbacks',
    caseId: 'W01',
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
    onReturn: (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.sourceIds)).toBe(true);
      events.push(event);
    },
  });
  await observer.client.search('QUERY_PRIVATE_SENTINEL');
  await observer.client.fetchPage(url);
  expect(events.map((item) => item.kind)).toEqual(['search', 'page']);
  for (const value of [
    'QUERY_PRIVATE_SENTINEL',
    'offline-dummy-search-key',
    'BODY_CONTENT_SENTINEL',
    'SEARCH_TITLE_SENTINEL',
  ])
    expect(JSON.stringify(events)).not.toContain(value);
});

test('overlapping observer calls fail before a second dispatch so receipt attribution cannot cross operations', async () => {
  const pending = deferred<WebTransportResponse>();
  const { observer, raw } = fixture('W01', { transport: () => pending.promise });
  const first = observer.client.search('offline held search');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(observer.client.fetchPage(url)).rejects.toThrow('concurrent');
  expect(raw).toHaveLength(1);
  pending.release(searchResponse());
  await first;
  expect(observer.snapshot().searches).toHaveLength(1);
});

test('source URLs carrying secret-like query fields are rejected before exporting metadata or dispatching page', async () => {
  const { observer, raw } = fixture('W01', {
    transport: () => searchResponse({ url: `${url}?api_key=URL_SECRET_SENTINEL` }),
  });
  await expect(observer.client.search('offline query')).rejects.toThrow('source');
  expect(observer.snapshot().sourceObservations).toEqual([]);
  expect(observer.snapshot().searches).toEqual([]);
  expect(JSON.stringify(observer.snapshot())).not.toContain('URL_SECRET_SENTINEL');
  await expect(observer.client.fetchPage(`${url}?token=URL_SECRET_SENTINEL`)).rejects.toThrow(
    'source',
  );
  expect(raw).toHaveLength(1);
});

test('real meter failures remain failures, produce no source observation and are never replaced with fabricated content', async () => {
  const { observer, meter } = fixture('W01', {
    transport: () => {
      throw new Error('offline HTTP failure');
    },
  });
  await expect(observer.client.search('offline failing query')).rejects.toMatchObject({
    code: 'network',
  });
  expect(meter.receipts()).toHaveLength(1);
  expect(meter.receipts()[0]).toMatchObject({
    transportAttempted: true,
    outcome: 'failed',
    bytesKnown: false,
    failure: 'network',
  });
  expect(observer.snapshot()).toEqual({
    searches: [],
    sources: [],
    sourceObservations: [],
    observations: [],
    issues: [],
  });
});

test('default production mode is preserved without making an HTTP or DNS call during construction', () => {
  const { ledger, guard } = fixture();
  const meter = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-never-used-key',
    beforeDispatch: guard,
  });
  const observer = createLiveWebObserver({
    runId: 'offline_mode_only',
    caseId: 'W01',
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
  });
  expect(observer.transportMode).toBe('production-default');
  expect(meter.receipts()).toEqual([]);
  expect(observer.snapshot()).toEqual({
    searches: [],
    sources: [],
    sourceObservations: [],
    observations: [],
    issues: [],
  });
});

test('captured metered methods cannot be swapped after observer construction', async () => {
  const { observer, meter, raw } = fixture();
  meter.client.search = async () => {
    throw new Error('replacement search must not run');
  };
  meter.client.fetchPage = async () => {
    throw new Error('replacement page must not run');
  };
  const results = await observer.client.search('offline captured methods');
  await observer.client.fetchPage(results[0].url);
  expect(raw).toHaveLength(2);
  expect(observer.snapshot().sources).toHaveLength(1);
});

test('a noncooperative logical guard is bounded by task cancellation and cannot record a claimed fault', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const { observer, raw, meter } = fixture('C08', {
    guard: async () => {
      entered.release();
      await release.promise;
    },
  });
  const controller = new AbortController();
  const attempt = observer.client.search('offline held gate', { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
  expect(observer.snapshot().observations).toEqual([]);
  expect(raw).toEqual([]);
  expect(meter.receipts()).toEqual([]);
  release.release();
});

test('a noncooperative controlled-observation callback stops on abort while preserving the actual already-applied boundary', async () => {
  const { meter, guard, raw } = fixture('C08');
  const entered = deferred<void>();
  const release = deferred<void>();
  const observer = createLiveWebObserver({
    runId: 'offline_fault_callback',
    caseId: 'C08',
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
    onControlledBoundary: async () => {
      entered.release();
      await release.promise;
    },
  });
  const controller = new AbortController();
  const attempt = observer.client.search('offline controlled callback', {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
  expect(observer.snapshot().observations).toHaveLength(1);
  expect(raw).toEqual([]);
  release.release();
  expect(await observer.client.search('offline actual recovery')).toHaveLength(2);
  expect(observer.snapshot().observations).toHaveLength(1);
  expect(raw).toHaveLength(1);
});

test('a noncooperative return callback is bounded by cancellation without losing already-observed metadata', async () => {
  const { meter, guard } = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const observer = createLiveWebObserver({
    runId: 'offline_return_callback',
    caseId: 'W01',
    meter,
    phaseId: () => 'initial',
    beforeDispatch: guard,
    onReturn: async () => {
      entered.release();
      await release.promise;
    },
  });
  const controller = new AbortController();
  const attempt = observer.client.search('offline return callback', { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
  expect(observer.snapshot().searches).toHaveLength(1);
  expect(observer.snapshot().sourceObservations).toHaveLength(2);
  expect(meter.receipts()[0]).toMatchObject({
    outcome: 'completed',
    bytesKnown: true,
    ledgerSettled: true,
  });
  release.release();
});

test('missing independent meter receipts fail closed instead of deriving HTTP success from a WebClient return', async () => {
  const { meter, guard, raw } = fixture();
  const observer = createLiveWebObserver({
    runId: 'offline_missing_receipt',
    caseId: 'W01',
    meter: { ...meter, receipts: () => [] },
    phaseId: () => 'initial',
    beforeDispatch: guard,
  });
  await expect(observer.client.search('offline parsed response')).rejects.toThrow('receipt');
  expect(raw).toHaveLength(1);
  expect(observer.snapshot()).toEqual({
    searches: [],
    sources: [],
    sourceObservations: [],
    observations: [],
    issues: [{ kind: 'search', reason: 'receipt' }],
  });
});

test('a page HTTP failure has a metered response but no successful page observation or fabricated report source', async () => {
  const { observer, meter } = fixture('W01', {
    transport: (input) =>
      input.url.hostname === 'api.search.brave.com'
        ? searchResponse()
        : response('offline missing page', 404),
  });
  const results = await observer.client.search('offline page failure');
  await expect(observer.client.fetchPage(results[0].url)).rejects.toMatchObject({ code: 'http' });
  expect(meter.receipts()[1]).toMatchObject({
    status: 404,
    outcome: 'completed',
    bytesKnown: true,
    ledgerSettled: true,
  });
  expect(observer.snapshot().sources).toEqual([]);
  expect(observer.snapshot().sourceObservations.every((item) => item.kind === 'search')).toBe(true);
  expect(observer.snapshot().observations).toEqual([]);
});
