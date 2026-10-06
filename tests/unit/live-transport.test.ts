import { afterEach, expect, test } from 'bun:test';
import { OpenAICompatibleProvider } from '@prospero/providers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WebDependencies, WebTransportResponse } from '../../packages/web/src/types';
import { createLiveBudgetManifest, LiveBudgetLedger } from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import { createBudgetedProviderFetch, createBudgetedWebClient } from '../acceptance/live-transport';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
let nextId = 0;
const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
const baseUrl = 'https://provider.example/v1';
const completionUrl = `${baseUrl}/chat/completions`;
function fixture(
  options: { authorized?: boolean; bytes?: number; redirects?: number; lifetime?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-meter-'));
  disposers.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'budget.sqlite');
  const journal = new SqliteLiveBudgetJournal(database, { mode: 'create' });
  disposers.push(() => journal.close());
  const clock = { wall: 1000, mono: 0 };
  const lifetime = options.lifetime ?? 9000;
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_meter_${++nextId}`,
    ...identity,
    journalSha256: journal.identitySha256,
    caseIds: ['W01', 'W02', 'C02'],
    createdAt: 1000,
    expiresAt: 1000 + lifetime,
    limits: {
      provider: 10,
      search: 10,
      page: 10,
      redirects: options.redirects ?? 5,
      responseBodyBytes: options.bytes ?? 8 * 1024 * 1024,
      wallClockMs: lifetime,
    },
  });
  const ledger = new LiveBudgetLedger(manifest, {
    humanConfirmed: options.authorized !== false,
    executionIdentity: identity,
    journal,
    now: () => clock.wall,
    monotonic: () => clock.mono,
  });
  disposers.push(() => ledger.abort());
  return { ledger, journal, manifest, database, clock };
}
const fakeFetch = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch => handler as typeof fetch;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('Deferred was not initialized');
  };
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function provider(ledger: LiveBudgetLedger, handler: typeof fetch) {
  return createBudgetedProviderFetch({ ledger, caseId: () => 'W01', baseUrl, fetchImpl: handler });
}
function observe(database: string) {
  const db = new DatabaseSync(database);
  disposers.push(() => db.close());
  return db;
}
const resolvePublic: WebDependencies['resolve'] = async () => [
  { address: '93.184.216.34', family: 4 },
];
const html =
  '<html><head><title>Offline fixture</title></head><body><main><p>Public fixture paper studies a bounded synthetic method. This content exists only for offline transport testing.</p></main></body></html>';
function webResponse(
  body = html,
  status = 200,
  headers: Record<string, string> = {},
): WebTransportResponse {
  return { status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(body) };
}
const searchResponse = () =>
  webResponse(
    JSON.stringify({
      type: 'search',
      web: {
        results: [
          {
            title: 'Offline paper',
            url: 'https://public.example/paper',
            description: 'Offline synthetic fixture.',
          },
        ],
      },
    }),
    200,
    { 'content-type': 'application/json' },
  );

test('provider missing approval, expired budget and invalid endpoints make zero transport attempts', async () => {
  let attempts = 0;
  const base = fakeFetch(() => {
    attempts++;
    return new Response('ok');
  });
  const unauthorized = fixture({ authorized: false });
  const first = provider(unauthorized.ledger, base);
  await expect(first.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('budget');
  expect(first.receipts()).toHaveLength(0);
  const expired = fixture();
  expired.clock.wall = expired.manifest.expiresAt;
  await expect(
    provider(expired.ledger, base).fetch(completionUrl, { method: 'POST' }),
  ).rejects.toThrow('budget');
  const valid = provider(fixture().ledger, base);
  for (const [url, method] of [
    [completionUrl, 'GET'],
    [`${completionUrl}?key=PRIVATE`, 'POST'],
    ['https://other.example/v1/models', 'GET'],
  ])
    await expect(valid.fetch(url, { method })).rejects.toThrow('endpoint');
  expect(attempts).toBe(0);
});

test('mutable factory options cannot replace a captured unapproved budget', async () => {
  const rejected = fixture({ authorized: false });
  const approved = fixture();
  let attempts = 0;
  const fetchOptions = {
    ledger: rejected.ledger,
    caseId: () => 'W01',
    baseUrl,
    fetchImpl: fakeFetch(() => {
      attempts++;
      return new Response('ok');
    }),
  };
  const metered = createBudgetedProviderFetch(fetchOptions);
  fetchOptions.ledger = approved.ledger;
  await expect(metered.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('budget');
  const webOptions = {
    ledger: rejected.ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async () => {
        attempts++;
        return webResponse();
      },
    },
  };
  const web = createBudgetedWebClient(webOptions);
  webOptions.ledger = approved.ledger;
  await expect(web.client.fetchPage('https://public.example/paper')).rejects.toThrow('budget');
  expect(attempts).toBe(0);
});

test('provider body stays lazy and known byte refunds occur only after observed EOF', async () => {
  const { ledger } = fixture();
  let reads = 0;
  const metered = provider(
    ledger,
    fakeFetch((_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(Buffer.from('abc'));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-length': '3' } },
      );
    }),
  );
  const response = await metered.fetch(`${baseUrl}/models`);
  expect(reads).toBe(0);
  expect(metered.receipts()[0]?.outcome).toBe('pending');
  expect(ledger.usage().reservedResponseBodyBytes).toBe(4 * 1024 * 1024);
  expect(await response.text()).toBe('abc');
  expect(reads).toBe(1);
  expect(metered.receipts()[0]).toMatchObject({
    outcome: 'completed',
    observedBytes: 3,
    bytesKnown: true,
    ledgerSettled: true,
    transportAttempted: true,
    status: 200,
  });
  expect(ledger.usage().chargedResponseBodyBytes).toBe(3);
  expect(ledger.usage().provider).toBe(1);
  expect(Object.isFrozen(metered.receipts()[0])).toBe(true);
});

test('actual provider DONE cancellation preserves an unknown tail rather than treating it as EOF', async () => {
  const { ledger } = fixture();
  let cancelled = 0;
  const packet = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Offline answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  const metered = provider(
    ledger,
    fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from(packet));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  const model = new OpenAICompatibleProvider(
    { baseUrl, model: 'offline-model', apiKey: 'offline-dummy-key' },
    metered.fetch,
  );
  const result = await model.stream(
    { messages: [{ role: 'user', content: 'Offline fixture' }], tools: [] },
    () => {},
    new AbortController().signal,
  );
  expect(result.content).toBe('Offline answer');
  await tick();
  expect(cancelled).toBe(1);
  expect(metered.receipts()[0]).toMatchObject({
    outcome: 'cancelled',
    bytesKnown: false,
    ledgerSettled: true,
  });
  expect(ledger.usage().chargedResponseBodyBytes).toBe(4 * 1024 * 1024);
  expect(ledger.usage().unknownResponseReceipts).toBe(1);
});

test('network failures and ordinary cancellations consume request slots without leaking private errors', async () => {
  const { ledger } = fixture();
  const metered = provider(
    ledger,
    fakeFetch(() => {
      throw new Error('SECRET_KEY_CANARY https://private.example/path');
    }),
  );
  await expect(metered.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('network');
  expect(ledger.usage().provider).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(4 * 1024 * 1024);
  const data = JSON.stringify(metered.receipts());
  expect(data).not.toContain('SECRET_KEY_CANARY');
  expect(data).not.toContain('https://');
  const recovered = provider(
    ledger,
    fakeFetch(() => new Response('ok')),
  );
  expect(await (await recovered.fetch(`${baseUrl}/models`)).text()).toBe('ok');
  expect(ledger.usage().provider).toBe(2);
});

test('provider consumer cap rejects overflow, cancels upstream and charges unknown bytes conservatively', async () => {
  const { ledger } = fixture();
  const cap = 4 * 1024 * 1024;
  let cancelled = 0;
  const metered = provider(
    ledger,
    fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(cap));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled++;
            },
          }),
        ),
    ),
  );
  const response = await metered.fetch(completionUrl, { method: 'POST' });
  await expect(response.text()).rejects.toThrow('too-large');
  expect(cancelled).toBe(1);
  expect(metered.receipts()[0]).toMatchObject({
    observedBytes: cap + 1,
    bytesKnown: false,
    failure: 'too-large',
  });
  expect(ledger.usage().chargedResponseBodyBytes).toBe(cap);
});

test('provider content length and encoding are checked before an incompatible response is consumed', async () => {
  const variants: Record<string, string>[] = [
    { 'content-length': '1025' },
    { 'content-length': 'invalid' },
    { 'content-encoding': 'gzip' },
    { 'content-length': '4' },
  ];
  for (const headers of variants) {
    const { ledger } = fixture({ bytes: 1024 });
    const metered = provider(
      ledger,
      fakeFetch(() => new Response('abc', { headers })),
    );
    let caught: unknown;
    try {
      await (await metered.fetch(completionUrl, { method: 'POST' })).text();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(metered.receipts()[0]?.bytesKnown).toBe(false);
    expect(ledger.usage().chargedResponseBodyBytes).toBe(1024);
  }
});

test('opaque provider status zero cannot be reported as a completed HTTP response', async () => {
  const { ledger } = fixture();
  const metered = provider(
    ledger,
    fakeFetch(() => Response.error()),
  );
  await expect(metered.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('incompatible');
  expect(metered.receipts()[0]).toMatchObject({
    outcome: 'failed',
    status: null,
    bytesKnown: false,
  });
});

test('reservation and dispatch journal failure prevent the provider transport from being entered', async () => {
  for (const event of ['reserved', 'dispatch']) {
    const { ledger, database } = fixture();
    const db = observe(database);
    db.exec(
      `CREATE TRIGGER forced_${event} BEFORE INSERT ON budget_records WHEN NEW.event = '${event}' BEGIN SELECT RAISE(FAIL, 'SECRET_SQL_ERROR'); END`,
    );
    let attempts = 0;
    const metered = provider(
      ledger,
      fakeFetch(() => {
        attempts++;
        return new Response('ok');
      }),
    );
    await expect(metered.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('journal');
    expect(attempts).toBe(0);
    expect(ledger.usage().closed).toBe(true);
    expect(metered.receipts().every((receipt) => !receipt.transportAttempted)).toBe(true);
    expect(JSON.stringify(metered.receipts())).not.toContain('SECRET_SQL_ERROR');
  }
});

test('settlement commit failure prevents an EOF response from being accepted as durable completion', async () => {
  const { ledger, database } = fixture();
  observe(database).exec(
    "CREATE TRIGGER forced_settlement BEFORE INSERT ON budget_records WHEN NEW.event = 'settled' BEGIN SELECT RAISE(FAIL, 'SECRET_SQL_ERROR'); END",
  );
  const metered = provider(
    ledger,
    fakeFetch(() => new Response('abc')),
  );
  const response = await metered.fetch(completionUrl, { method: 'POST' });
  await expect(response.text()).rejects.toThrow('journal');
  expect(metered.receipts()[0]).toMatchObject({
    outcome: 'completed',
    bytesKnown: true,
    ledgerSettled: false,
    failure: 'journal',
  });
  expect(ledger.usage().closed).toBe(true);
});

test('late provider response after Stop is observed and cancelled without a refund or second attempt', async () => {
  const { ledger } = fixture();
  const held = deferred<Response>();
  let attempts = 0;
  let lateCancel = 0;
  const metered = provider(
    ledger,
    fakeFetch(() => {
      attempts++;
      return held.promise;
    }),
  );
  const controller = new AbortController();
  const pending = metered.fetch(completionUrl, { method: 'POST', signal: controller.signal });
  ledger.abort();
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  const prior = ledger.usage().chargedResponseBodyBytes;
  held.release(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          lateCancel++;
        },
      }),
    ),
  );
  await tick();
  expect(lateCancel).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(prior);
  expect(metered.receipts()[0]).toMatchObject({
    outcome: 'cancelled',
    bytesKnown: false,
    status: null,
    observedBytes: 0,
  });
  await expect(metered.fetch(`${baseUrl}/models`)).rejects.toThrow('budget');
  expect(attempts).toBe(1);
});

test('global deadline bounds a non-cooperating provider promise and rejects its late response', async () => {
  const { ledger } = fixture({ lifetime: 20 });
  const held = deferred<Response>();
  const metered = provider(
    ledger,
    fakeFetch(() => held.promise),
  );
  await expect(metered.fetch(completionUrl, { method: 'POST' })).rejects.toThrow('cancelled');
  expect(ledger.usage().closed).toBe(true);
  held.release(new Response('late'));
  await tick();
  expect(metered.receipts()[0]?.status).toBeNull();
  expect(metered.receipts()[0]?.bytesKnown).toBe(false);
});

test('Web gate rejects absent approval before even the injected resolver is called', async () => {
  const { ledger } = fixture({ authorized: false });
  let dns = 0;
  let raw = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic('ignored');
      },
      transport: async () => {
        raw++;
        return searchResponse();
      },
    },
  });
  await expect(metered.client.search('offline paper')).rejects.toThrow('budget');
  await expect(metered.client.fetchPage('https://public.example/paper')).rejects.toThrow('budget');
  expect(dns).toBe(0);
  expect(raw).toBe(0);
  expect(metered.receipts()).toHaveLength(0);
  expect(metered.transportMode).toBe('offline-injected');
  expect(
    createBudgetedWebClient({ ledger, caseId: () => 'W01', apiKey: 'offline-dummy-key' })
      .transportMode,
  ).toBe('production-default');
});

test('Web reservation and dispatch journal failures prevent all raw transport attempts', async () => {
  for (const event of ['reserved', 'dispatch']) {
    const { ledger, database } = fixture();
    observe(database).exec(
      `CREATE TRIGGER web_${event} BEFORE INSERT ON budget_records WHEN NEW.event = '${event}' BEGIN SELECT RAISE(FAIL, 'SECRET_SQL_ERROR'); END`,
    );
    let attempts = 0;
    const metered = createBudgetedWebClient({
      ledger,
      caseId: () => 'W01',
      apiKey: 'offline-dummy-key',
      dependencies: {
        resolve: resolvePublic,
        transport: async () => {
          attempts++;
          return searchResponse();
        },
      },
    });
    await expect(metered.client.search('offline search')).rejects.toThrow();
    expect(attempts).toBe(0);
    expect(ledger.usage().closed).toBe(true);
    expect(metered.receipts().every((receipt) => !receipt.transportAttempted)).toBe(true);
  }
});

test('Web redirects charge every raw request and cumulative bodies within the remaining byte cap', async () => {
  const { ledger } = fixture({ bytes: 1024 });
  const caps: number[] = [];
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async (input) => {
        caps.push(input.maxBytes);
        return input.url.pathname === '/start'
          ? webResponse('redirect body', 302, { location: '/final' })
          : webResponse();
      },
    },
  });
  const source = await metered.client.fetchPage('https://public.example/start', {
    maxResponseBytes: 700,
  });
  expect(source.title).toBe('Offline fixture');
  expect(caps).toEqual([700, 700 - Buffer.byteLength('redirect body')]);
  expect(metered.receipts().map((receipt) => receipt.redirect)).toEqual([false, true]);
  expect(ledger.usage().page).toBe(2);
  expect(ledger.usage().redirects).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(
    Buffer.byteLength('redirect body') + Buffer.byteLength(html),
  );
});

test('Web redirect quota exhaustion rejects the second raw request before transport', async () => {
  const { ledger } = fixture({ redirects: 0 });
  let attempts = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async () => {
        attempts++;
        return webResponse('', 302, { location: '/final' });
      },
    },
  });
  await expect(metered.client.fetchPage('https://public.example/start')).rejects.toThrow();
  expect(attempts).toBe(1);
  expect(ledger.usage().page).toBe(1);
  expect(ledger.usage().redirects).toBe(0);
});

test('concurrent Web ALS contexts keep search, page and redirect counters and case identities separate', async () => {
  const { ledger } = fixture();
  let selected = 'W01';
  const held = deferred<WebTransportResponse>();
  let searchEntered = false;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => selected,
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async (input) => {
        if (input.url.hostname === 'api.search.brave.com') {
          searchEntered = true;
          return held.promise;
        }
        return input.url.pathname === '/start'
          ? webResponse('', 302, { location: '/final' })
          : webResponse();
      },
    },
  });
  const search = metered.client.search('offline search');
  await tick();
  expect(searchEntered).toBe(true);
  selected = 'W02';
  const page = await metered.client.fetchPage('https://public.example/start');
  expect(page.kind).toBe('page');
  held.release(searchResponse());
  expect(await search).toHaveLength(1);
  expect(
    metered.receipts().map(({ caseId, kind, redirect }) => ({ caseId, kind, redirect })),
  ).toEqual([
    { caseId: 'W01', kind: 'search', redirect: false },
    { caseId: 'W02', kind: 'page', redirect: false },
    { caseId: 'W02', kind: 'page', redirect: true },
  ]);
});

test('Web raw failure and cancellation preserve unknown byte costs and suppress late completion', async () => {
  const first = fixture({ bytes: 1024 });
  const failed = createBudgetedWebClient({
    ledger: first.ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async () => {
        throw new Error('SECRET_TRANSPORT_ERROR');
      },
    },
  });
  await expect(failed.client.search('offline', { maxResponseBytes: 200 })).rejects.toThrow();
  expect(first.ledger.usage().chargedResponseBodyBytes).toBe(200);
  expect(first.ledger.usage().search).toBe(1);
  expect(JSON.stringify(failed.receipts())).not.toContain('SECRET_TRANSPORT_ERROR');
  const second = fixture({ bytes: 1024 });
  const held = deferred<WebTransportResponse>();
  let attempts = 0;
  const cancelled = createBudgetedWebClient({
    ledger: second.ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async () => {
        attempts++;
        return held.promise;
      },
    },
  });
  const controller = new AbortController();
  const pending = cancelled.client.fetchPage('https://public.example/paper', {
    signal: controller.signal,
    maxResponseBytes: 500,
  });
  await tick();
  controller.abort();
  await expect(pending).rejects.toThrow();
  await tick();
  const charged = second.ledger.usage().chargedResponseBodyBytes;
  expect(charged).toBe(500);
  held.release(webResponse());
  await tick();
  expect(second.ledger.usage().chargedResponseBodyBytes).toBe(charged);
  expect(cancelled.receipts()[0]).toMatchObject({
    outcome: 'cancelled',
    observedBytes: 0,
    status: null,
    bytesKnown: false,
  });
  expect(attempts).toBe(1);
});

test('Web deadline bounds unresolved DNS before any raw dispatch and blocks a late resolution', async () => {
  const { ledger } = fixture({ lifetime: 20 });
  const held = deferred<Awaited<ReturnType<WebDependencies['resolve']>>>();
  let attempts = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: () => held.promise,
      transport: async () => {
        attempts++;
        return webResponse();
      },
    },
  });
  await expect(metered.client.fetchPage('https://public.example/paper')).rejects.toThrow();
  expect(ledger.usage().closed).toBe(true);
  held.release([{ address: '93.184.216.34', family: 4 }]);
  await tick();
  expect(attempts).toBe(0);
  expect(metered.receipts()).toHaveLength(0);
});

test('Web injected oversized raw response is rejected and does not refund its reservation', async () => {
  const { ledger } = fixture({ bytes: 1024 });
  let cap = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    dependencies: {
      resolve: resolvePublic,
      transport: async (input) => {
        cap = input.maxBytes;
        return webResponse('x'.repeat(input.maxBytes + 1));
      },
    },
  });
  await expect(
    metered.client.fetchPage('https://public.example/paper', { maxResponseBytes: 128 }),
  ).rejects.toThrow();
  expect(cap).toBe(128);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(128);
  expect(metered.receipts()[0]).toMatchObject({
    observedBytes: 129,
    bytesKnown: false,
    failure: 'too-large',
  });
});
