import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProsperoStore } from '@prospero/persistence';
import { BraveWebClient, type WebTransportRequest } from '@prospero/web';
import { startFakeProvider } from '../../../../tests/e2e/fake-provider';
import { DesktopService } from './service';
import { DotExecutionService } from './dot-execution';
import { DotApplication } from './dot-application';
import { ExecutionAdmission } from './execution-admission';

// Actual provider SDK and safe Web client, with only endpoint/DNS/transport replaced by owned fixtures.
test('normal application research approves exact search/page requests, preserves evidence and consumes page text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-web-'));
  const path = join(root, 'profile.sqlite');
  const requests: WebTransportRequest[] = [];
  const opened: string[] = [];
  const web = new BraveWebClient(
    { apiKey: 'fixture-search-key' },
    {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (request) => {
        requests.push(request);
        const search = request.url.hostname === 'api.search.brave.com';
        return {
          status: 200,
          headers: { 'content-type': search ? 'application/json' : 'text/html' },
          body: new TextEncoder().encode(
            search
              ? JSON.stringify({
                  type: 'search',
                  web: {
                    results: [
                      {
                        url: 'https://paper.example.test/article',
                        title: 'Verified research source',
                        description: 'Transient search snippet should not be persisted',
                      },
                    ],
                  },
                })
              : '<html><head><title>Verified research source</title></head><body><main><p>verified-page-fact-42</p></main></body></html>',
          ),
        };
      },
    },
  );
  const fake = await startFakeProvider((_request, _task, results) => {
    if (!results.length)
      return { tool: 'web_search', args: { query: 'bounded research question', maxResults: 1 } };
    if (results.length === 1) {
      const search = JSON.parse(results[0].content);
      return { tool: 'fetch_page', args: { url: search.sources[0].url } };
    }
    if (results.length === 2) {
      const page = JSON.parse(results[1].content);
      const actual = page.sources[0].content.includes('verified-page-fact-42');
      return {
        tool: 'record_progress',
        args: {
          summary: actual
            ? `Fact 42 verified [source:${page.sources[0].citation}]`
            : 'Page evidence was not supplied',
          completed: actual ? ['Read the actual page result'] : [],
          next: ['Compare the next question'],
        },
      };
    }
    return { text: 'The bounded step was recorded.' };
  });
  let store = new ProsperoStore(path);
  let desktop!: DesktopService;
  let runner!: DotExecutionService;
  let app!: DotApplication;
  const admission = new ExecutionAdmission();
  const compose = () => {
    desktop = new DesktopService(
      store,
      {
        get: async (id) => (id === 'brave-search' ? 'fixture-search-key' : 'fixture-model-key'),
        put: async (id) => {
          store.saveEncryptedCredential(id, new Uint8Array([1, 2, 3]));
        },
      },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      'test',
      undefined,
      undefined,
      () => web,
      undefined,
      undefined,
      admission,
    );
    runner = new DotExecutionService(
      store.dots(),
      admission,
      (id, signal) => desktop.reserveDotModel(id, signal),
      (event) => app?.notify(event),
      Date.now,
      30000,
      {
        provider: (id) => {
          const p = desktop.bootstrap().providers.find((p) => p.id === id);
          return p ? { id: p.id, baseUrl: p.baseUrl, model: p.model } : undefined;
        },
        policyRevision: () => desktop.dotResearchConfigurationRevision(),
        open: (input) => desktop.reserveDotResearch(input),
      },
    );
    app = new DotApplication(
      store.dots(),
      runner,
      () => desktop.bootstrap().providers,
      () => {},
      undefined,
      (url) => {
        opened.push(url);
      },
    );
  };
  compose();
  try {
    const provider = await desktop.saveProvider({
      displayName: 'Offline model',
      baseUrl: fake.baseUrl,
      model: 'fixture',
    });
    await desktop.saveWebSearch({
      provider: 'brave',
      enabled: true,
      retention: 'sources',
      apiKey: 'fixture-search-key',
    });
    let view = await app.create({
      name: 'Researcher',
      goal: 'Research the bounded question using public evidence.',
    });
    await app.run(view.dot.id, view.dot.revision, provider.id);
    await runner.wait(view.dot.id);
    view = await app.get(view.dot.id);
    const first = view.approvals?.find((entry) => entry.status === 'pending');
    if (!first) throw new Error('Missing search approval.');
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain('modelTurns');
    await app.decide(
      view.dot.id,
      view.dot.revision,
      first.id,
      first.revision,
      first.digest,
      'approve',
    );
    await runner.wait(view.dot.id);
    view = await app.get(view.dot.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].maxBytes).toBe(256 * 1024);
    const second = view.approvals?.find((entry) => entry.status === 'pending');
    if (!second) throw new Error('Missing page approval.');
    expect(view.approvals?.[0].receipt?.sources?.[0].excerpt).toBe('');
    const encoded = JSON.stringify(store.dots().intent(second.id));
    expect(encoded).not.toContain('Transient search snippet');
    expect(encoded).not.toContain('fixture-search-key');
    expect(encoded).not.toContain('fixture-model-key');
    app.dispose();
    await runner.shutdown();
    await desktop.shutdown();
    store.close();
    store = new ProsperoStore(path);
    compose();
    expect(store.dots().recoverInFlight(Date.now(), () => true)).toEqual([]);
    expect(requests).toHaveLength(1);
    view = await app.get(view.dot.id);
    await app.decide(
      view.dot.id,
      view.dot.revision,
      second.id,
      second.revision,
      second.digest,
      'approve',
    );
    await runner.wait(view.dot.id);
    view = await app.get(view.dot.id);
    expect(view.checkpoint?.summary).toContain('Fact 42 verified');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0].status).toBe('succeeded');
    expect(view.approvals?.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded']);
    expect(requests).toHaveLength(2);
    expect(requests[1].maxBytes).toBe(1024 * 1024);
    expect(requests[1].headers).not.toHaveProperty('X-Subscription-Token');
    const page = view.approvals?.[1].receipt?.sources?.[0];
    if (!page) throw new Error('Missing actual source metadata.');
    expect(page.kind).toBe('page');
    await app.openSource(view.dot.id, view.approvals?.[1].id ?? '', page.id);
    expect(opened).toEqual(['https://paper.example.test/article']);
    await expect(
      app.openSource('different-dot', view.approvals?.[1].id ?? '', page.id),
    ).rejects.toThrow();
    expect(store.conversations()).toEqual([]);
    expect(JSON.stringify(store.dots().intents(view.dot.id))).not.toContain(
      'verified-page-fact-42',
    );
  } finally {
    app.dispose();
    await runner.shutdown();
    await desktop.shutdown();
    store.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('research preparation makes no requests and rejects exhausted Run budgets, replay, credentials and private URLs', async () => {
  const { createDotWebSession } = await import('./dot-web-session');
  const calls: string[] = [];
  const web = {
    search: async () => {
      calls.push('search');
      return [];
    },
    fetchPage: async () => {
      calls.push('fetch');
      throw new Error('Unexpected network.');
    },
  };
  const prior = (name: string, key: string) =>
    ({
      status: 'succeeded',
      dispatchedAt: 1,
      request: { call: { name }, permissionKey: key },
    }) as import('@prospero/persistence').DotIntent;
  const quota = createDotWebSession(
    { runIntents: () => [prior('web_search', 'first'), prior('web_search', 'second')] },
    'run',
    web,
  );
  const call = { id: 'pending', name: 'web_search', arguments: '{"query":"third question"}' };
  await expect(quota.prepare(call, new AbortController().signal)).rejects.toThrow('budget');
  const safe = createDotWebSession({ runIntents: () => [] }, 'run', web, (value) =>
    value.includes('fixture-private-key'),
  );
  await expect(
    safe.prepare(
      { ...call, arguments: '{"query":"fixture-private-key"}' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('credential');
  await expect(
    safe.prepare(
      { id: 'private', name: 'fetch_page', arguments: '{"url":"https://127.0.0.1/private"}' },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const prepared = await safe.prepare(call, new AbortController().signal);
  await expect(
    safe.prepare({ ...call, arguments: '{"query":"   "}' }, new AbortController().signal),
  ).rejects.toThrow('non-empty');
  const replay = createDotWebSession(
    { runIntents: () => [prior('web_search', prepared.permissionKey)] },
    'run',
    web,
  );
  await expect(replay.prepare(call, new AbortController().signal)).rejects.toThrow('already');
  expect(calls).toEqual([]);
  await safe.close();
  await expect(safe.prepare(call, new AbortController().signal)).rejects.toThrow('closed');
});

test('durable Web suspension preserves paired deferred calls in a multi-call model response', async () => {
  const { createDotWebSession } = await import('./dot-web-session');
  const { runAgent } = await import('@prospero/core');
  const session = createDotWebSession({ runIntents: () => [] }, 'parallel-run', {
    search: async () => [],
    fetchPage: async () => {
      throw new Error('No request authorised.');
    },
  });
  try {
    const outcome = await runAgent({
      executionId: 'parallel-run',
      host: session,
      model: {
        stream: async () => ({
          content: '',
          toolCalls: [
            { id: 'first', name: 'web_search', arguments: '{"query":"bounded query"}' },
            { id: 'second', name: 'fetch_page', arguments: '{"url":"https://example.org/page"}' },
          ],
          finishReason: 'tool_calls',
        }),
      },
      permissions: { decide: async () => 'suspend' },
      messages: [{ role: 'user', content: 'Inspect the bounded question.' }],
      signal: new AbortController().signal,
      onEvent: () => {},
      suspension: {},
    });
    if (outcome.state !== 'suspended') throw new Error('Expected suspension.');
    const saved = session.retain?.(outcome.continuation);
    expect(saved?.messages.find((message) => message.toolCallId === 'second')?.content).toContain(
      'skipped',
    );
    expect(saved?.pending).toEqual(outcome.continuation.pending);
  } finally {
    await session.close();
  }
});

for (const action of ['window', 'cancel'] as const)
  test(`Dot Web credential ownership survives ${action === 'window' ? 'window close' : 'logical cancellation until native settlement'}`, async () => {
    const store = new ProsperoStore(':memory:');
    store.setSetting('web-search', { provider: 'brave', enabled: true, retention: 'sources' });
    store.saveEncryptedCredential('brave-search', new Uint8Array([1, 2]));
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (key: string) => void;
    const native = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let nativeSignal: AbortSignal | undefined;
    let factoryCalls = 0;
    const desktop = new DesktopService(
      store,
      {
        put: async () => {},
        get: async (id, signal, endpoint) => {
          expect(id).toBe('brave-search');
          expect(endpoint).toBe('https://api.search.brave.com/res/v1/web/search');
          nativeSignal = signal;
          entered();
          return native;
        },
      },
      { folder: async () => undefined, files: async () => [] },
      () => {},
      'test',
      undefined,
      undefined,
      () => {
        factoryCalls++;
        return {
          search: async () => [],
          fetchPage: async () => {
            throw new Error('No request authorised.');
          },
        };
      },
    );
    const repo = store.dots();
    const dot = repo.create({
      id: 'owned-dot',
      name: 'Owned',
      goal: { text: 'Inspect public notes' },
      createdAt: 1,
    });
    const queued = repo.createRun(dot.id, dot.revision, { id: 'owned-run', createdAt: 2 });
    const running = repo.startRun(dot.id, queued.run.id, queued.dot.revision, 3);
    const controller = new AbortController();
    const pendingSession = desktop.reserveDotResearch({
      dot: running.dot,
      run: running.run,
      signal: controller.signal,
    });
    const result = pendingSession.then(
      (session) => ({ session }),
      () => ({ session: undefined }),
    );
    let session: Awaited<typeof result>['session'];
    try {
      await began;
      if (action === 'window') {
        await desktop.suspendWindow();
        expect(nativeSignal?.aborted).toBe(false);
        desktop.resumeWindow();
      } else {
        controller.abort();
        expect((await result).session).toBeUndefined();
        expect(nativeSignal?.aborted).toBe(true);
      }
      await expect(
        desktop.saveWebSearch({ enabled: false, retention: 'sources' }),
      ).rejects.toThrow();
      finish('fixture-only-search-key');
      await new Promise<void>((resolve) => setImmediate(resolve));
      session = (await result).session;
      if (action === 'window') {
        expect(factoryCalls).toBe(1);
        await expect(
          desktop.saveWebSearch({ enabled: false, retention: 'sources' }),
        ).rejects.toThrow();
        await session?.close();
      } else expect(factoryCalls).toBe(0);
      await desktop.saveWebSearch({ enabled: false, retention: 'sources' });
    } finally {
      finish('fixture-only-search-key');
      await session?.close();
      await desktop.shutdown();
      store.close();
    }
  });
