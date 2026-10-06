import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveBudgetManifest, LiveBudgetLedger } from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import {
  createBudgetedProviderFetch,
  createBudgetedWebClient,
  type LiveDispatchBoundary,
  type LiveDispatchGuard,
} from '../acceptance/live-transport';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const identity = { sourceSha256: 'a'.repeat(64), buildSha256: 'b'.repeat(64) };
const baseUrl = 'https://provider.example/v1';
let next = 0;
function fixture(options: { authorized?: boolean; lifetime?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'prospero-dispatch-guard-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new SqliteLiveBudgetJournal(join(directory, 'budget.sqlite'), { mode: 'create' });
  cleanup.push(() => journal.close());
  const lifetime = options.lifetime ?? 9000;
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_dispatch_guard_${++next}`,
    ...identity,
    journalSha256: journal.identitySha256,
    caseIds: ['W01'],
    createdAt: 1000,
    expiresAt: 1000 + lifetime,
    limits: {
      provider: 5,
      search: 5,
      page: 5,
      redirects: 3,
      responseBodyBytes: 1024,
      wallClockMs: lifetime,
    },
  });
  const ledger = new LiveBudgetLedger(manifest, {
    humanConfirmed: options.authorized !== false,
    executionIdentity: identity,
    journal,
    now: () => 1000,
    monotonic: () => 0,
  });
  cleanup.push(() => {
    try {
      ledger.abort();
    } catch {}
  });
  return ledger;
}
const fakeFetch = (callback: () => Response | Promise<Response>): typeof fetch =>
  ((_input: RequestInfo | URL, _init?: RequestInit) => callback()) as typeof fetch;
const resolvePublic = async () => [{ address: '93.184.216.34', family: 4 as const }];
const html =
  '<html><head><title>Offline guard fixture</title></head><body><p>This public synthetic fixture exists only for offline dispatch boundary tests.</p></body></html>';
const response = () => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: Buffer.from(html),
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred fixture not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('provider dispatch guard rejection consumes a request slot but enters no raw fetch and charges known zero bytes', async () => {
  const ledger = fixture();
  let guards = 0;
  let raw = 0;
  const metered = createBudgetedProviderFetch({
    ledger,
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: () => {
      guards++;
      throw new Error('PRIVATE_GUARD_CANARY');
    },
    fetchImpl: fakeFetch(() => {
      raw++;
      return new Response('unused');
    }),
  });
  let caught: unknown;
  try {
    await metered.fetch(`${baseUrl}/models`);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain('PRIVATE_GUARD_CANARY');
  expect(guards).toBe(1);
  expect(raw).toBe(0);
  expect(ledger.usage().provider).toBe(1);
  expect(ledger.usage().dispatchIntents).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
  expect(metered.receipts()[0]).toMatchObject({
    transportAttempted: false,
    outcome: 'failed',
    observedBytes: 0,
    bytesKnown: true,
    ledgerSettled: true,
  });
});

test('Web resolve guard rejection starts neither DNS nor HTTP and creates no reservation', async () => {
  const ledger = fixture();
  let dns = 0;
  let raw = 0;
  const seen: Readonly<LiveDispatchBoundary>[] = [];
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: (boundary) => {
      seen.push(boundary);
      throw new Error('PRIVATE_GUARD_CANARY');
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return response();
      },
    },
  });
  await expect(metered.client.fetchPage('https://public.example/paper')).rejects.toThrow();
  expect(seen).toEqual([
    { caseId: 'W01', kind: 'page', stage: 'resolve', redirect: false, reservedBytes: 0 },
  ]);
  expect(dns).toBe(0);
  expect(raw).toBe(0);
  expect(ledger.usage().page).toBe(0);
  expect(metered.receipts()).toHaveLength(0);
});

test('Web transport guard rejection permits one DNS lookup but enters no HTTP and settles known zero bytes', async () => {
  const ledger = fixture();
  let dns = 0;
  let raw = 0;
  const stages: string[] = [];
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: (boundary) => {
      stages.push(boundary.stage);
      if (boundary.stage === 'transport') throw new Error('Denied fixture transport');
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return response();
      },
    },
  });
  await expect(
    metered.client.fetchPage('https://public.example/paper', { maxResponseBytes: 500 }),
  ).rejects.toThrow();
  expect(stages).toEqual(['resolve', 'transport']);
  expect(dns).toBe(1);
  expect(raw).toBe(0);
  expect(ledger.usage().page).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
  expect(metered.receipts()[0]).toMatchObject({
    reservedBytes: 500,
    transportAttempted: false,
    outcome: 'failed',
    observedBytes: 0,
    bytesKnown: true,
    ledgerSettled: true,
  });
});

test('each redirect rechecks both resolve and transport guards with the correct redirect context', async () => {
  const ledger = fixture();
  const boundaries: Readonly<LiveDispatchBoundary>[] = [];
  let dns = 0;
  let raw = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: (boundary) => {
      boundaries.push(boundary);
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async (input) => {
        raw++;
        if (input.url.pathname === '/start')
          return { status: 302, headers: { location: '/middle' }, body: Buffer.from('one') };
        if (input.url.pathname === '/middle')
          return { status: 302, headers: { location: '/final' }, body: Buffer.from('two') };
        return response();
      },
    },
  });
  expect(
    (await metered.client.fetchPage('https://public.example/start', { maxResponseBytes: 500 }))
      .title,
  ).toBe('Offline guard fixture');
  expect(boundaries.map(({ stage, redirect }) => ({ stage, redirect }))).toEqual([
    { stage: 'resolve', redirect: false },
    { stage: 'transport', redirect: false },
    { stage: 'resolve', redirect: true },
    { stage: 'transport', redirect: true },
    { stage: 'resolve', redirect: true },
    { stage: 'transport', redirect: true },
  ]);
  expect(
    boundaries.filter((item) => item.stage === 'transport').map((item) => item.reservedBytes),
  ).toEqual([500, 497, 494]);
  expect(dns).toBe(3);
  expect(raw).toBe(3);
  expect(ledger.usage().page).toBe(3);
  expect(ledger.usage().redirects).toBe(2);
});

test('a redirect guard denial stops before the next raw entry without losing the first body receipt', async () => {
  const ledger = fixture();
  let dns = 0;
  let raw = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: (boundary) => {
      if (boundary.stage === 'transport' && boundary.redirect)
        throw new Error('Denied fixture redirect');
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return { status: 302, headers: { location: '/final' }, body: Buffer.from('first') };
      },
    },
  });
  await expect(
    metered.client.fetchPage('https://public.example/start', { maxResponseBytes: 500 }),
  ).rejects.toThrow();
  expect(dns).toBe(2);
  expect(raw).toBe(1);
  expect(ledger.usage().page).toBe(2);
  expect(ledger.usage().redirects).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(5);
  expect(metered.receipts()[0]).toMatchObject({
    transportAttempted: true,
    outcome: 'completed',
    observedBytes: 5,
    bytesKnown: true,
  });
  expect(metered.receipts()[1]).toMatchObject({
    redirect: true,
    transportAttempted: false,
    outcome: 'failed',
    observedBytes: 0,
    bytesKnown: true,
  });
});

test('aborting a held provider guard settles known zero and its late approval cannot enter fetch', async () => {
  const ledger = fixture();
  const entered = deferred();
  const held = deferred();
  let raw = 0;
  const metered = createBudgetedProviderFetch({
    ledger,
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: async () => {
      entered.release();
      await held.promise;
    },
    fetchImpl: fakeFetch(() => {
      raw++;
      return new Response('unused');
    }),
  });
  const controller = new AbortController();
  const pending = metered.fetch(`${baseUrl}/models`, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  const original = metered.receipts();
  expect(original[0]).toMatchObject({
    transportAttempted: false,
    outcome: 'cancelled',
    bytesKnown: true,
    ledgerSettled: true,
    observedBytes: 0,
  });
  held.release();
  await tick();
  expect(raw).toBe(0);
  expect(metered.receipts()).toEqual(original);
  expect(ledger.usage().provider).toBe(1);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
});

test('aborting a held Web resolve guard prevents late DNS and transport entry', async () => {
  const ledger = fixture();
  const entered = deferred();
  const held = deferred();
  let dns = 0;
  let raw = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: async () => {
      entered.release();
      await held.promise;
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return response();
      },
    },
  });
  const controller = new AbortController();
  const pending = metered.client.fetchPage('https://public.example/paper', {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  held.release();
  await tick();
  expect(dns).toBe(0);
  expect(raw).toBe(0);
  expect(metered.receipts()).toHaveLength(0);
});

test('aborting a held Web transport guard preserves zero body charge and blocks its late resolution', async () => {
  const ledger = fixture();
  const entered = deferred();
  const held = deferred();
  let dns = 0;
  let raw = 0;
  const metered = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: async (boundary) => {
      if (boundary.stage === 'transport') {
        entered.release();
        await held.promise;
      }
    },
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return response();
      },
    },
  });
  const controller = new AbortController();
  const pending = metered.client.fetchPage('https://public.example/paper', {
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await tick();
  expect(dns).toBe(1);
  expect(metered.receipts()[0]).toMatchObject({
    transportAttempted: false,
    outcome: 'cancelled',
    observedBytes: 0,
    bytesKnown: true,
    ledgerSettled: true,
  });
  const original = metered.receipts();
  held.release();
  await tick();
  expect(raw).toBe(0);
  expect(metered.receipts()).toEqual(original);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(0);
});

test('global deadline bounds a non-cooperating dispatch guard and its late resolution does not issue a request', async () => {
  const ledger = fixture({ lifetime: 20 });
  const held = deferred();
  let raw = 0;
  const metered = createBudgetedProviderFetch({
    ledger,
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: () => held.promise,
    fetchImpl: fakeFetch(() => {
      raw++;
      return new Response('unused');
    }),
  });
  await expect(metered.fetch(`${baseUrl}/models`)).rejects.toThrow('cancelled');
  expect(ledger.usage().closed).toBe(true);
  const charged = ledger.usage().chargedResponseBodyBytes;
  held.release();
  await tick();
  expect(raw).toBe(0);
  expect(ledger.usage().chargedResponseBodyBytes).toBe(charged);
  expect(metered.receipts()[0]?.transportAttempted).toBe(false);
});

test('changing caller options cannot replace the captured rejecting provider or Web dispatch guard', async () => {
  const providerLedger = fixture();
  let original = 0;
  let substituted = 0;
  let raw = 0;
  const rejecting: LiveDispatchGuard = () => {
    original++;
    throw new Error('Captured guard denies');
  };
  const providerOptions = {
    ledger: providerLedger,
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: rejecting,
    fetchImpl: fakeFetch(() => {
      raw++;
      return new Response('unused');
    }),
  };
  const provider = createBudgetedProviderFetch(providerOptions);
  providerOptions.beforeDispatch = () => {
    substituted++;
  };
  await expect(provider.fetch(`${baseUrl}/models`)).rejects.toThrow();
  const webOptions = {
    ledger: fixture(),
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: rejecting,
    dependencies: {
      resolve: resolvePublic,
      transport: async () => {
        raw++;
        return response();
      },
    },
  };
  const web = createBudgetedWebClient(webOptions);
  webOptions.beforeDispatch = () => {
    substituted++;
  };
  await expect(web.client.fetchPage('https://public.example/paper')).rejects.toThrow();
  expect(original).toBe(2);
  expect(substituted).toBe(0);
  expect(raw).toBe(0);
});

test('technical dispatch guards never substitute for absent human approval or expose request secrets', async () => {
  const ledger = fixture({ authorized: false });
  let guards = 0;
  let dns = 0;
  let raw = 0;
  const permissive: LiveDispatchGuard = () => {
    guards++;
  };
  const provider = createBudgetedProviderFetch({
    ledger,
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: permissive,
    fetchImpl: fakeFetch(() => {
      raw++;
      return new Response('unused');
    }),
  });
  await expect(provider.fetch(`${baseUrl}/models`)).rejects.toThrow('budget');
  const web = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: 'offline-dummy-key',
    beforeDispatch: permissive,
    dependencies: {
      resolve: async () => {
        dns++;
        return resolvePublic();
      },
      transport: async () => {
        raw++;
        return response();
      },
    },
  });
  await expect(web.client.search('offline query')).rejects.toThrow('budget');
  expect(guards).toBe(0);
  expect(dns).toBe(0);
  expect(raw).toBe(0);
  const boundaries: Readonly<LiveDispatchBoundary>[] = [];
  const authorized = createBudgetedProviderFetch({
    ledger: fixture(),
    caseId: () => 'W01',
    baseUrl,
    beforeDispatch: (boundary) => {
      boundaries.push(boundary);
    },
    fetchImpl: fakeFetch(() => new Response('abc')),
  });
  expect(
    await (
      await authorized.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer PRIVATE_KEY_CANARY' },
        body: 'PRIVATE_BODY_CANARY',
      })
    ).text(),
  ).toBe('abc');
  const boundary = boundaries[0];
  expect(Object.keys(boundary ?? {}).sort()).toEqual([
    'caseId',
    'kind',
    'redirect',
    'reservedBytes',
    'stage',
  ]);
  expect(Object.isFrozen(boundary)).toBe(true);
  expect(JSON.stringify(boundaries)).not.toContain('PRIVATE_KEY_CANARY');
  expect(JSON.stringify(boundaries)).not.toContain('PRIVATE_BODY_CANARY');
  expect(JSON.stringify(boundaries)).not.toContain('https://');
});
