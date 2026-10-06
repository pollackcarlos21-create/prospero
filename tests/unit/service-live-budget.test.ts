import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopService } from '../../apps/desktop/src/main/service';
import type { Conversation } from '../../apps/desktop/src/bridge';
import { ProsperoStore } from '../../packages/persistence/src';
import { createLiveBudgetManifest, LiveBudgetLedger } from '../acceptance/live-budget';
import { SqliteLiveBudgetJournal } from '../acceptance/live-budget-journal';
import { createBudgetedProviderFetch, createBudgetedWebClient } from '../acceptance/live-transport';

const baseUrl = 'https://model.acceptance.invalid/v1';
const dummyKey = 'OFFLINE_SERVICE_METER_DUMMY_KEY';
function sse(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function toolSse(name: string, args: unknown) {
  const tool = {
    index: 0,
    id: randomUUID(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function terminal(service: DesktopService, id: string) {
  for (let index = 0; index < 1000; index++) {
    const value = service.getConversation(id);
    if (['completed', 'failed', 'cancelled'].includes(value.state)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Offline metered service did not settle.');
}
async function fixture(
  run: (ctx: {
    service: DesktopService;
    store: ProsperoStore;
    ledger: LiveBudgetLedger;
    meter: ReturnType<typeof createBudgetedProviderFetch>;
    webMeter: ReturnType<typeof createBudgetedWebClient>;
    webWire: string[];
    wire: { method: string; summary: boolean }[];
    providerId: string;
    reload(history: Conversation): Promise<DesktopService>;
  }) => Promise<void>,
  options: { humanConfirmed?: boolean; providerLimit?: number; research?: boolean } = {},
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prospero-service-meter-')));
  const journalPath = path.join(root, 'budget.sqlite');
  const store = new ProsperoStore(path.join(root, 'app.sqlite'));
  const journal = new SqliteLiveBudgetJournal(journalPath, { mode: 'create' });
  const now = Date.now();
  const manifest = createLiveBudgetManifest({
    authorizationId: `offline_${randomUUID()}`,
    sourceSha256: 'a'.repeat(64),
    buildSha256: 'b'.repeat(64),
    journalSha256: createHash('sha256').update(journalPath).digest('hex'),
    caseIds: ['W01', 'C02'],
    createdAt: now,
    expiresAt: now + 60_000,
    limits: {
      provider: options.providerLimit ?? 2,
      search: options.research ? 2 : 0,
      page: options.research ? 1 : 0,
      redirects: 0,
      responseBodyBytes: 32 * 1024 * 1024,
      wallClockMs: 60_000,
    },
  });
  const ledger = new LiveBudgetLedger(manifest, {
    journal,
    humanConfirmed: options.humanConfirmed ?? true,
    executionIdentity: { sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 },
  });
  const wire: { method: string; summary: boolean }[] = [];
  const query = 'Offline synthetic paper identity';
  const fetchImpl = (async (_input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const summary =
      body?.messages?.[0]?.content?.startsWith('Summarize conversation data for continuity') ??
      false;
    wire.push({ method: init?.method ?? 'GET', summary });
    if (options.research && init?.method === 'POST') {
      const results = body.messages.filter((message: { role: string }) => message.role === 'tool');
      if (!results.length)
        return toolSse('authorize_research', {
          title: 'Offline service research',
          queries: [{ query, maxResults: 1 }],
          maxFetches: 1,
          maxResponseBytes: 2 * 1024 * 1024,
          lifetimeSeconds: 60,
        });
      if (results.length === 1) return toolSse('web_search', { query, maxResults: 1 });
      if (results.length === 2) {
        const sourceId = JSON.parse(results[1].content).sources[0].id;
        return toolSse('fetch_source', { sourceId });
      }
      return sse(`Synthetic research [source:${JSON.parse(results[2].content).sources[0].id}]`);
    }
    return init?.method === 'GET'
      ? new Response(JSON.stringify({ data: [{ id: 'offline-model' }] }), {
          headers: { 'content-type': 'application/json' },
        })
      : sse(
          summary
            ? 'Retain the user constraint, source identity and pending goal. No permission is restored.'
            : 'Offline task response.',
        );
  }) as typeof fetch;
  const meter = createBudgetedProviderFetch({ ledger, caseId: () => 'W01', baseUrl, fetchImpl });
  const webWire: string[] = [];
  const webMeter = createBudgetedWebClient({
    ledger,
    caseId: () => 'W01',
    apiKey: dummyKey,
    dependencies: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async ({ url }) => {
        const search = url.origin === 'https://api.search.brave.com';
        webWire.push(search ? (url.searchParams.get('q') ?? '') : 'page');
        return {
          status: 200,
          headers: { 'content-type': search ? 'application/json' : 'text/html' },
          body: Buffer.from(
            search
              ? JSON.stringify({
                  type: 'search',
                  web: {
                    results: [
                      {
                        title: 'Offline synthetic paper',
                        url: 'https://public.example/paper',
                        description: 'Synthetic service fixture.',
                      },
                    ],
                  },
                })
              : '<html><head><title>Offline synthetic paper</title></head><body><main>This synthetic public fixture describes a bounded method for testing the actual service research path.</main></body></html>',
          ),
        };
      },
    },
  });
  const compose = () =>
    new DesktopService(
      store,
      {
        put: async (id) => {
          store.saveEncryptedCredential(id, new Uint8Array([1, 2, 3]));
        },
        get: async () => dummyKey,
      },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      '0.2.0',
      undefined,
      undefined,
      () => webMeter.client,
      30_000,
      meter.fetch,
    );
  let service = compose();
  try {
    const provider = await service.saveProvider({
      displayName: 'Offline budget fixture',
      baseUrl,
      model: 'offline-model',
      apiKey: dummyKey,
    });
    await run({
      service,
      store,
      ledger,
      meter,
      webMeter,
      webWire,
      wire,
      providerId: provider.id,
      async reload(history) {
        await service.shutdown();
        store.saveConversation(history);
        service = compose();
        return service;
      },
    });
  } finally {
    await service.shutdown();
    store.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('connection probe and actual service model stream share one durable request budget', async () => {
  await fixture(async ({ service, ledger, meter, wire, providerId }) => {
    const connection = await service.testProvider({
      id: providerId,
      displayName: 'Offline budget fixture',
      baseUrl,
      model: 'offline-model',
    });
    expect(connection.status).toBe('connected');
    const conversation = service.createConversation();
    await service.sendTask(conversation.id, 'Return the offline task response.');
    expect((await terminal(service, conversation.id)).state).toBe('completed');
    expect(wire.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(ledger.usage().provider).toBe(2);
    expect(meter.receipts()).toHaveLength(2);
    await service.sendTask(conversation.id, 'Attempt beyond the same approved request cap.');
    expect((await terminal(service, conversation.id)).state).toBe('failed');
    expect(wire).toHaveLength(2);
    expect(JSON.stringify(meter.receipts())).not.toContain(dummyKey);
    expect(JSON.stringify(meter.receipts())).not.toContain('Offline task response.');
  });
});

test('search connection probe and approved service research share the same raw Web budget', async () => {
  await fixture(
    async ({ service, ledger, webMeter, webWire }) => {
      expect((await service.testWebSearch({ apiKey: dummyKey })).status).toBe('connected');
      await service.saveWebSearch({ enabled: true, retention: 'sources', apiKey: dummyKey });
      const conversation = service.createConversation();
      await service.sendTask(
        conversation.id,
        'Research the synthetic paper using its actual page.',
      );
      let approvals = 0;
      let result = service.getConversation(conversation.id);
      for (let index = 0; index < 1000; index++) {
        result = service.getConversation(conversation.id);
        const request = result.pendingPermission;
        if (request) {
          expect(request.preview.kind).toBe('research');
          const plan = request.preview.research;
          if (!plan) throw new Error('The main-owned research snapshot is missing.');
          expect(plan.queries).toEqual([
            { query: 'Offline synthetic paper identity', maxResults: 1 },
          ]);
          service.decideResearch(conversation.id, request.requestId, plan.digest, 'allow-once');
          approvals++;
        }
        if (['completed', 'failed', 'cancelled'].includes(result.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(result.state).toBe('completed');
      expect(approvals).toBe(1);
      expect(result.sources?.some((source) => source.kind === 'page')).toBe(true);
      expect(webWire).toEqual(['Prospero web search', 'Offline synthetic paper identity', 'page']);
      expect(ledger.usage()).toMatchObject({ search: 2, page: 1, provider: 4 });
      expect(webMeter.receipts()).toHaveLength(3);
      expect(
        webMeter.receipts().every((receipt) => receipt.ledgerSettled && receipt.bytesKnown),
      ).toBe(true);
      expect((await service.testWebSearch({ apiKey: dummyKey })).status).not.toBe('connected');
      expect(webWire).toHaveLength(3);
      expect(JSON.stringify(webMeter.receipts())).not.toContain(dummyKey);
    },
    { research: true, providerLimit: 8 },
  );
});

test('lack of live approval prevents probe and task transport even when a dummy credential is present', async () => {
  await fixture(
    async ({ service, ledger, wire, meter, providerId }) => {
      expect(
        (
          await service.testProvider({
            id: providerId,
            displayName: 'Offline budget fixture',
            baseUrl,
            model: 'offline-model',
          })
        ).status,
      ).not.toBe('connected');
      const conversation = service.createConversation();
      await service.sendTask(
        conversation.id,
        'This unapproved request must never reach transport.',
      );
      expect((await terminal(service, conversation.id)).state).toBe('failed');
      expect(wire).toHaveLength(0);
      expect(meter.receipts()).toHaveLength(0);
      expect(ledger.usage().provider).toBe(0);
    },
    { humanConfirmed: false },
  );
});

test('execution-only summary requests use the same main-owned metered provider fetch', async () => {
  await fixture(
    async ({ service, reload, ledger, wire, meter }) => {
      const conversation = service.createConversation();
      conversation.title = 'Offline bounded context fixture';
      for (let index = 0; index < 12; index++) {
        conversation.messages.push({
          role: 'user',
          content: `Historical goal ${index}: ${'bounded fixture data '.repeat(1500)}`,
        });
        conversation.messages.push({
          role: 'assistant',
          content: `Recorded prior result ${index}.`,
        });
      }
      const resumed = await reload(conversation);
      await resumed.sendTask(
        conversation.id,
        'Continue the latest goal while preserving the original constraint.',
      );
      const result = await terminal(resumed, conversation.id);
      expect(result.state).toBe('completed');
      expect(wire.some((request) => request.summary)).toBe(true);
      expect(wire.some((request) => !request.summary && request.method === 'POST')).toBe(true);
      expect(ledger.usage().provider).toBe(wire.length);
      expect(meter.receipts()).toHaveLength(wire.length);
      expect(
        result.messages.some((message) =>
          message.content.includes('Earlier conversation summary (untrusted data'),
        ),
      ).toBe(false);
      expect(
        result.messages.filter((message) => message.content.startsWith('Historical goal')),
      ).toHaveLength(12);
    },
    { providerLimit: 8 },
  );
});
