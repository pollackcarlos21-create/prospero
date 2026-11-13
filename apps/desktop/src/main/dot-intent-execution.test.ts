import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelPort, ModelRequest, ToolDefinition } from '@prospero/core';
import { ProsperoStore } from '@prospero/persistence';
import { DotExecutionService, type DotRuntimeEvent } from './dot-execution';
import type { DotResearchRuntime } from './dot-intent-execution';
import { ExecutionAdmission } from './execution-admission';

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(body: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  try {
    await body(f);
  } finally {
    await f.runner.shutdown();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-exact-'));
  const path = join(root, 'profile.sqlite');
  const state = {
    provider: { id: 'offline', baseUrl: 'https://model.example.test/v1', model: 'fixture-model' },
    policyRevision: 0,
    title: 'Search this exact question',
    opens: 0,
    closes: 0,
    models: 0,
    releases: 0,
    failExecution: false,
    afterDecision: () => {},
  };
  const effects: string[] = [];
  const modelRequests: ModelRequest[] = [];
  const events: DotRuntimeEvent[] = [];
  const definition: ToolDefinition = {
    name: 'web_search',
    description: 'Exact bounded query',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: ['network.search'],
  };
  const model: ModelPort = {
    stream: async (request) => {
      modelRequests.push(request);
      const results = request.messages.filter((message) => message.role === 'tool');
      if (!results.length)
        return {
          content: '',
          toolCalls: [
            { id: 'search-once', name: 'web_search', arguments: '{"query":"exact question"}' },
          ],
          finishReason: 'tool_calls',
        };
      if (!results.some((message) => message.content.startsWith('Continuation proposal recorded.')))
        return {
          content: '',
          toolCalls: [
            {
              id: 'save-progress',
              name: 'record_progress',
              arguments: JSON.stringify({
                summary: 'Verified the exact research receipt.',
                completed: ['One approved query completed'],
                next: ['Inspect the next question'],
              }),
            },
          ],
          finishReason: 'tool_calls',
        };
      return {
        content: 'The bounded research step is complete.',
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  };
  const research: DotResearchRuntime = {
    provider: () => ({ ...state.provider }),
    policyRevision: () => state.policyRevision,
    open: async ({ run }) => {
      state.opens++;
      return {
        definitions: [definition],
        prepare: async (call) => ({
          call,
          definition,
          preview: {
            kind: 'web',
            title: state.title,
            query: 'exact question',
            effects: ['network.search'],
          },
          permissionKey: `dot:${run.id}:exact-question`,
          allowSession: false,
          requiresPermission: true,
          onSuspended: () => {},
          onDecision: () => state.afterDecision(),
          execute: async () => {
            effects.push(run.id);
            if (state.failExecution) throw new Error('Private external failure');
            return { content: 'Actual response for the exact question.' };
          },
        }),
        receipt: () => ({ summary: 'One bounded query response received.', sourceIds: [] }),
        close: () => {
          state.closes++;
        },
      };
    },
  };
  const f = {
    root,
    path,
    state,
    effects,
    modelRequests,
    events,
    research,
    model,
    store: new ProsperoStore(path),
    admission: new ExecutionAdmission(),
    models: async (_id: string, _signal: AbortSignal) => {
      state.models++;
      return {
        model,
        release: () => {
          state.releases++;
        },
      };
    },
    runner: undefined as unknown as DotExecutionService,
    renew() {
      this.runner = new DotExecutionService(
        this.store.dots(),
        this.admission,
        this.models,
        (event) => events.push(event),
        Date.now,
        30_000,
        research,
      );
    },
    async start() {
      const dot = this.store.dots().create({
        id: 'dot-1',
        name: 'Researcher',
        goal: { text: 'Inspect this bounded question.' },
        createdAt: Date.now(),
      });
      const pair = this.runner.runNow(dot.id, dot.revision, state.provider.id);
      await this.runner.wait(dot.id);
      const intent = this.store.dots().currentIntent(pair.run.id);
      if (!intent) throw new Error('Missing persisted suspension.');
      return { pair, intent };
    },
    approve(id: string) {
      const intent = this.store.dots().intent(id);
      if (!intent) throw new Error('Missing intent.');
      return this.store
        .dots()
        .decideIntent(
          id,
          intent.revision,
          intent.digest,
          'approve',
          Math.max(Date.now(), intent.updatedAt),
        );
    },
  };
  f.renew();
  return f;
}

test('formal Dot runner suspends, releases admission and resumes the same approved call after store/service reopen', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    expect(intent.status).toBe('pending');
    expect(f.effects).toEqual([]);
    expect(f.admission.owner).toBeUndefined();
    expect(f.state.closes).toBe(1);
    expect(f.state.releases).toBe(1);
    expect(f.store.dots().getRun(pair.run.id)?.status).toBe('running');
    expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
    f.approve(intent.id);
    await f.runner.shutdown();
    f.store.close();
    f.store = new ProsperoStore(f.path);
    f.renew();
    expect(f.store.dots().recoverInFlight(Date.now(), () => true)).toEqual([]);
    expect(f.effects).toEqual([]);
    const same = f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    expect(same.run.id).toBe(pair.run.id);
    await f.runner.wait(pair.dot.id);
    expect(f.effects).toEqual([pair.run.id]);
    expect(f.modelRequests).toHaveLength(3);
    expect(
      f.modelRequests[1].messages.some(
        (message) =>
          message.role === 'tool' && message.content === 'Actual response for the exact question.',
      ),
    ).toBe(true);
    expect(f.store.dots().getRun(pair.run.id)?.status).toBe('succeeded');
    expect(f.store.dots().checkpoint(pair.dot.id)?.summary).toBe(
      'Verified the exact research receipt.',
    );
    expect(f.store.dots().intent(intent.id)?.status).toBe('succeeded');
    expect(
      f.store
        .dots()
        .intentEvents(intent.id)
        .map((event) => event.status),
    ).toEqual(['pending', 'approved', 'dispatching', 'succeeded']);
    expect(f.state.models).toBe(2);
    expect(f.state.releases).toBe(2);
  });
});

for (const changed of ['provider', 'policy', 'preview'] as const)
  test(`changed ${changed} cannot inherit the saved Dot approval`, async () => {
    await fixture(async (f) => {
      const { pair, intent } = await f.start();
      f.approve(intent.id);
      if (changed === 'provider') f.state.provider.baseUrl = 'https://changed.example.test/v1';
      if (changed === 'policy') f.state.policyRevision++;
      if (changed === 'preview') f.state.title = 'A different preview';
      if (changed === 'preview') {
        f.runner.resumeApproved(
          pair.dot.id,
          f.store.dots().get(pair.dot.id)?.revision ?? -1,
          intent.id,
        );
        await f.runner.wait(pair.dot.id);
      } else
        expect(() =>
          f.runner.resumeApproved(
            pair.dot.id,
            f.store.dots().get(pair.dot.id)?.revision ?? -1,
            intent.id,
          ),
        ).toThrow();
      expect(f.effects).toEqual([]);
      expect(f.store.dots().intent(intent.id)?.status).toBe('stale');
      expect(f.modelRequests).toHaveLength(1);
      expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
      expect(f.admission.owner).toBeUndefined();
    });
  });

test('policy revocation between permission decision and execute prevents durable dispatch', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    f.approve(intent.id);
    f.state.afterDecision = () => {
      f.state.policyRevision++;
    };
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await f.runner.wait(pair.dot.id);
    expect(f.effects).toEqual([]);
    expect(f.store.dots().intent(intent.id)?.status).toBe('stale');
    expect(
      f.store
        .dots()
        .intentEvents(intent.id)
        .some((event) => event.status === 'dispatching'),
    ).toBe(false);
    expect(f.modelRequests).toHaveLength(1);
  });
});

test('Chat admission blocks approved resumption without consuming it or initializing adapters', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    const approved = f.approve(intent.id);
    const chat = f.admission.acquire({ kind: 'chat', id: 'chat-1' });
    try {
      expect(() =>
        f.runner.resumeApproved(
          pair.dot.id,
          f.store.dots().get(pair.dot.id)?.revision ?? -1,
          intent.id,
        ),
      ).toThrow();
      expect(f.store.dots().intent(intent.id)).toEqual(approved);
      expect(f.state.models).toBe(1);
      expect(f.state.opens).toBe(1);
      expect(f.effects).toEqual([]);
    } finally {
      chat.release();
    }
  });
});

test('a dispatched effect failure becomes unknown and stops before any model continuation', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    f.approve(intent.id);
    f.state.failExecution = true;
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await f.runner.wait(pair.dot.id);
    expect(f.effects).toEqual([pair.run.id]);
    expect(f.modelRequests).toHaveLength(1);
    expect(f.store.dots().intent(intent.id)?.status).toBe('unknown');
    expect(f.store.dots().getRun(pair.run.id)?.status).toBe('interrupted');
    expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
    expect(
      f.events.some((event) => event.type === 'attention' && event.reason === 'uncertain'),
    ).toBe(true);
    expect(() =>
      f.runner.runNow(
        pair.dot.id,
        f.store.dots().get(pair.dot.id)?.revision ?? -1,
        f.state.provider.id,
      ),
    ).toThrow();
    expect(f.effects).toHaveLength(1);
  });
});

test('Stop of an inactive suspended Run atomically cancels its pending intent', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    await f.runner.stop(pair.dot.id);
    expect(f.store.dots().intent(intent.id)?.status).toBe('cancelled');
    expect(f.store.dots().getRun(pair.run.id)?.status).toBe('cancelled');
    expect(f.store.dots().get(pair.dot.id)?.inFlightRunId).toBeUndefined();
    expect(f.effects).toEqual([]);
  });
});

test('Quit during approved initialization preserves the unconsumed intent and discards a late model session', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    const approved = f.approve(intent.id);
    const entered = barrier<void>();
    const native = barrier<{ model: ModelPort; release(): void }>();
    f.models = async () => {
      entered.release();
      return native.promise;
    };
    f.renew();
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await entered.promise;
    await f.runner.shutdown();
    expect(f.store.dots().intent(intent.id)).toEqual(approved);
    expect(f.effects).toEqual([]);
    let lateReleases = 0;
    native.release({
      model: f.model,
      release: () => {
        lateReleases++;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateReleases).toBe(1);
    expect(f.modelRequests).toHaveLength(1);
  });
});

test('a later query in the same Run needs a different durable approval and cannot reuse the first one', async () => {
  await fixture(async (f) => {
    f.model.stream = async (request) => {
      f.modelRequests.push(request);
      const results = request.messages.filter((message) => message.role === 'tool');
      if (results.length < 2)
        return {
          content: '',
          toolCalls: [
            {
              id: `query-${results.length + 1}`,
              name: 'web_search',
              arguments: '{"query":"exact question"}',
            },
          ],
          finishReason: 'tool_calls',
        };
      if (!results.some((message) => message.content.startsWith('Continuation proposal recorded.')))
        return {
          content: '',
          toolCalls: [
            {
              id: 'save',
              name: 'record_progress',
              arguments: JSON.stringify({
                summary: 'Two separately approved requests finished.',
                completed: ['First request', 'Second request'],
                next: [],
              }),
            },
          ],
          finishReason: 'tool_calls',
        };
      return { content: 'Finished', toolCalls: [], finishReason: 'stop' };
    };
    const { pair, intent } = await f.start();
    f.approve(intent.id);
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await f.runner.wait(pair.dot.id);
    const second = f.store.dots().currentIntent(pair.run.id);
    if (!second) throw new Error('Missing second approval.');
    expect(second.id).not.toBe(intent.id);
    expect(second.status).toBe('pending');
    expect(second.request.requestId).not.toBe(intent.request.requestId);
    expect(f.store.dots().intent(intent.id)?.status).toBe('succeeded');
    expect(f.effects).toHaveLength(1);
    expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
    f.approve(second.id);
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      second.id,
    );
    await f.runner.wait(pair.dot.id);
    expect(f.effects).toEqual([pair.run.id, pair.run.id]);
    expect(f.store.dots().checkpoint(pair.dot.id)?.summary).toBe(
      'Two separately approved requests finished.',
    );
    expect(f.store.dots().runs(pair.dot.id)).toHaveLength(1);
    expect(
      f.store
        .dots()
        .intents(pair.dot.id)
        .map((entry) => entry.status),
    ).toEqual(['succeeded', 'succeeded']);
  });
});

test('receipt commit failure after an effect preserves the dispatch gap and no automatic model retry', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    f.approve(intent.id);
    const inspect = new (await import('node:sqlite')).DatabaseSync(f.path);
    try {
      inspect.exec(
        "CREATE TRIGGER fail_dot_receipt BEFORE UPDATE ON dot_intents WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      f.runner.resumeApproved(
        pair.dot.id,
        f.store.dots().get(pair.dot.id)?.revision ?? -1,
        intent.id,
      );
      await expect(f.runner.wait(pair.dot.id)).rejects.toThrow();
      expect(f.effects).toEqual([pair.run.id]);
      expect(f.modelRequests).toHaveLength(1);
      expect(f.store.dots().intent(intent.id)?.status).toBe('dispatching');
      expect(f.store.dots().getRun(pair.run.id)?.status).toBe('running');
      expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
      f.store.dots().recoverInFlight(Date.now(), () => true);
      expect(f.store.dots().intent(intent.id)?.status).toBe('unknown');
      expect(f.effects).toHaveLength(1);
    } finally {
      inspect.close();
    }
  });
});

test('a changed policy cannot be rebound to a preview prepared under the earlier configuration', async () => {
  await fixture(async (f) => {
    const open = f.research.open;
    f.research.open = async (input) => {
      const session = await open(input);
      const prepare = session.prepare;
      session.prepare = async (...args) => {
        const prepared = await prepare(...args);
        return {
          ...prepared,
          onSuspended: async () => {
            await prepared.onSuspended?.();
            f.state.policyRevision++;
          },
        };
      };
      return session;
    };
    const dot = f.store.dots().create({
      id: 'dot-1',
      name: 'Researcher',
      goal: { text: 'Inspect the bounded question.' },
      createdAt: Date.now(),
    });
    const pair = f.runner.runNow(dot.id, dot.revision, f.state.provider.id);
    await f.runner.wait(dot.id);
    expect(f.store.dots().getRun(pair.run.id)?.status).toBe('failed');
    expect(f.store.dots().intents(dot.id)).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(f.state.closes).toBe(1);
    expect(f.state.releases).toBe(1);
  });
});

test('a missing approved tool preserves its unconsumed intent and cannot manufacture a successful checkpoint', async () => {
  await fixture(async (f) => {
    const { pair, intent } = await f.start();
    const approved = f.approve(intent.id);
    const open = f.research.open;
    f.research.open = async (input) => ({ ...(await open(input)), definitions: [] });
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await f.runner.wait(pair.dot.id);
    expect(f.modelRequests).toHaveLength(1);
    expect(f.store.dots().intent(intent.id)).toEqual(approved);
    expect(f.store.dots().checkpoint(pair.dot.id)).toBeUndefined();
    expect(f.effects).toEqual([]);
    expect(f.state.closes).toBe(2);
    expect(f.state.releases).toBe(2);
    await f.runner.stop(pair.dot.id);
    expect(f.store.dots().intent(intent.id)?.status).toBe('cancelled');
  });
});

test('application review validates deliberate acknowledgement, never replays, and projects only safe request history', async () =>
  fixture(async (f) => {
    const { DotApplication } = await import('./dot-application');
    const { pair, intent } = await f.start();
    f.state.failExecution = true;
    f.approve(intent.id);
    f.runner.resumeApproved(
      pair.dot.id,
      f.store.dots().get(pair.dot.id)?.revision ?? -1,
      intent.id,
    );
    await f.runner.wait(pair.dot.id);
    const provider = {
      ...f.state.provider,
      displayName: 'Fixture',
      supportsTools: true,
      hasApiKey: false,
      timeoutMs: 30000,
    };
    const app = new DotApplication(
      f.store.dots(),
      f.runner,
      () => [provider],
      () => {},
      undefined,
      undefined,
      f.admission,
    );
    try {
      const view = await app.get(pair.dot.id);
      const current = view.approvals?.[0];
      if (!current) throw new Error('Missing request');
      expect(current.status).toBe('unknown');
      const before = { effects: f.effects.length, models: f.state.models };
      await expect(
        app.reviewUnknown(
          view.dot.id,
          view.dot.revision,
          current.id,
          current.revision,
          current.digest,
          { acknowledge: false, note: 'Reviewed' } as unknown as import('../bridge').DotReviewInput,
        ),
      ).rejects.toThrow('Confirm');
      const hold = f.admission.acquire({ kind: 'dot', id: view.dot.id });
      const blocked = app
        .reviewUnknown(
          view.dot.id,
          view.dot.revision,
          current.id,
          current.revision,
          current.digest,
          { acknowledge: true, note: 'Reviewed' },
        )
        .then(
          () => '',
          (error) => String(error),
        );
      hold.release();
      expect(await blocked).toContain('settling');
      const reviewed = await app.reviewUnknown(
        view.dot.id,
        view.dot.revision,
        current.id,
        current.revision,
        current.digest,
        { acknowledge: true, note: 'Inspected service; accept uncertainty.' },
      );
      expect(reviewed.approvals?.[0].status).toBe('unknown');
      expect(reviewed.approvals?.[0].review?.note).toContain('Inspected service');
      expect(reviewed.runCount).toBe(1);
      expect({ effects: f.effects.length, models: f.state.models }).toEqual(before);
      const history = await app.requests(view.dot.id, { limit: undefined, offset: undefined });
      expect(history.total).toBe(1);
      expect(history.requests[0].review).toEqual(reviewed.approvals?.[0].review);
      for (const key of ['continuation', 'request', 'provider', 'binding'])
        expect(Object.hasOwn(history.requests[0], key)).toBe(false);
      await app.run(view.dot.id, reviewed.dot.revision, provider.id);
      await f.runner.wait(view.dot.id);
      expect(f.effects).toHaveLength(before.effects);
      expect((await app.get(view.dot.id)).approvals?.[0].status).toBe('pending');
    } finally {
      app.dispose();
    }
  }));

test('supervision classifies policy continuation without approving it, and exposes the approval when its deadline expires', async () =>
  fixture(async (f) => {
    const repo = f.store.dots();
    const at = Date.now();
    const dot = repo.create({
      id: 'policy-inbox',
      name: 'Bounded',
      goal: { text: 'Inspect exact question' },
      createdAt: at,
    });
    repo.createPolicy(
      {
        id: 'inbox-policy',
        dotId: dot.id,
        createdAt: at,
        expiresAt: at + 3600000,
        provider: f.state.provider,
        configurationRevision: 0,
        queries: [{ query: 'exact question', maxResults: 5 }],
        allowDiscoveredPages: false,
        limits: {
          maxRuns: 2,
          maxSearches: 2,
          maxFetches: 0,
          maxResponseBytes: 1048576,
          maxModelTurns: 16,
          maxModelRequestBytes: 16 * 96 * 1024,
        },
      },
      0,
    );
    const pair = f.runner.runNow(dot.id, 0, f.state.provider.id);
    await f.runner.wait(dot.id);
    const intent = repo.currentIntent(pair.run.id);
    if (!intent) throw new Error('Missing fixture request');
    const { DotApplication } = await import('./dot-application');
    let now = Date.now();
    const hold = f.admission.acquire({ kind: 'chat', id: 'busy-chat' });
    const app = new DotApplication(
      repo,
      f.runner,
      () => [],
      () => {},
      undefined,
      undefined,
      f.admission,
      {
        now: () => now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
    );
    try {
      const automatic = await app.supervision();
      expect(automatic.items).toEqual([]);
      expect(automatic.recheckAt).toBe(intent.expiresAt);
      expect(repo.intent(intent.id)?.status).toBe('pending');
      expect(repo.intentEvents(intent.id)).toHaveLength(1);
      f.state.policyRevision = 1;
      expect((await app.supervision()).items[0].kind).toBe('approval');
      expect(repo.intentEvents(intent.id)).toHaveLength(1);
      f.state.policyRevision = 0;
      now = intent.expiresAt;
      const expired = await app.supervision();
      expect(expired.items[0].kind).toBe('approval');
      expect(expired.recheckAt).toBeUndefined();
      expect(repo.intentEvents(intent.id)).toHaveLength(1);
    } finally {
      app.dispose();
      hold.release();
    }
  }));
