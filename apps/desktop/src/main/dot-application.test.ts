import { expect, test } from 'bun:test';
import { DotRepositoryError, ProsperoStore } from '@prospero/persistence';
import type { ModelPort } from '@prospero/core';
import type { DotView } from '../bridge';
import { DotApplication } from './dot-application';
import { DotExecutionService, type DotModelSession } from './dot-execution';
import { ExecutionAdmission } from './execution-admission';
import { registerDesktopIpc, type InvokeContext } from './ipc-boundary';
import { Channels } from '../ipc';
import type { DesktopService } from './service';

function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function model(): ModelPort {
  let calls = 0;
  return {
    stream: async () =>
      ++calls === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: 'progress',
                name: 'record_progress',
                arguments: JSON.stringify({
                  summary: 'A saved application result.',
                  completed: ['First question analysed'],
                  next: ['Continue next question'],
                }),
              },
            ],
            finishReason: 'tool_calls',
          }
        : { content: 'A bounded result is saved.', toolCalls: [], finishReason: 'stop' },
  };
}
async function fixture(
  body: (value: {
    app: DotApplication;
    runner: DotExecutionService;
    store: ProsperoStore;
    events: DotView[];
  }) => Promise<void>,
  models = async (_id: string, _signal: AbortSignal): Promise<DotModelSession> => ({
    model: model(),
    release: () => {},
  }),
) {
  const store = new ProsperoStore(':memory:');
  const events: DotView[] = [];
  let app: DotApplication | undefined;
  const runner = new DotExecutionService(store.dots(), new ExecutionAdmission(), models, (event) =>
    app?.notify(event),
  );
  app = new DotApplication(
    store.dots(),
    runner,
    () => [
      {
        id: 'offline',
        displayName: 'Offline',
        baseUrl: 'https://owned.example.test/v1',
        model: 'fixture',
        timeoutMs: 60000,
        supportsTools: true,
        hasApiKey: false,
      },
    ],
    (event) => events.push(event),
  );
  try {
    await body({ app, runner, store, events });
  } finally {
    app.dispose();
    await runner.shutdown();
    store.close();
  }
}

test('application creates separate Dots, publishes consistent snapshots and preserves successful progress', async () => {
  await fixture(async ({ app, runner, store, events }) => {
    const created = await app.create({ name: 'Researcher', goal: 'Maintain an evolving brief.' });
    expect((await app.list())[0]).toEqual(created.dot);
    expect(created.runCount).toBe(0);
    await expect(app.run(created.dot.id, created.dot.revision, 'missing-provider')).rejects.toThrow(
      'model with tool calling',
    );
    expect((await app.get(created.dot.id)).runCount).toBe(0);
    await app.run(created.dot.id, created.dot.revision, 'offline');
    await runner.wait(created.dot.id);
    const result = await app.get(created.dot.id);
    expect(result.runCount).toBe(1);
    expect(result.runs[0].status).toBe('succeeded');
    expect(result.checkpoint?.summary).toBe('A saved application result.');
    expect(result.dot.lifecycle).toBe('active');
    expect(store.conversations()).toEqual([]);
    for (const event of events)
      if (event.dot.inFlightRunId) {
        expect(
          event.runs.some(
            (run) => run.id === event.dot.inFlightRunId && run.dotRevision === event.dot.revision,
          ),
        ).toBe(true);
      }
    expect(
      events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence),
    ).toBe(true);
    await expect(app.transition(created.dot.id, created.dot.revision, 'archive')).rejects.toThrow(
      DotRepositoryError,
    );
    const archived = await app.transition(created.dot.id, result.dot.revision, 'archive');
    expect(archived.dot.lifecycle).toBe('archived');
    expect(await app.history(created.dot.id)).toHaveLength(1);
    expect(await app.checkpoints(created.dot.id)).toHaveLength(1);
  });
});

test('Pause aborts and joins initialization before the durable lifecycle transition', async () => {
  const entered = barrier<void>();
  const ready = barrier<DotModelSession>();
  const released = barrier<void>();
  let requests = 0;
  await fixture(
    async ({ app }) => {
      const created = await app.create({ name: 'Researcher', goal: 'Retain this goal.' });
      const pending = await app.run(created.dot.id, created.dot.revision, 'offline');
      await entered.promise;
      const paused = await app.transition(created.dot.id, pending.dot.revision, 'pause');
      expect(paused.dot.lifecycle).toBe('paused');
      expect(paused.dot.inFlightRunId).toBeUndefined();
      expect(paused.runs[0].status).toBe('cancelled');
      expect(paused.live).toBeUndefined();
      ready.release({
        model: {
          stream: async () => {
            requests++;
            throw new Error('No late dispatch.');
          },
        },
        release: () => released.release(),
      });
      await released.promise;
      expect(requests).toBe(0);
      const resumed = await app.transition(created.dot.id, paused.dot.revision, 'resume');
      expect(resumed.dot.lifecycle).toBe('active');
      expect(resumed.runCount).toBe(1);
    },
    async () => {
      entered.release();
      return ready.promise;
    },
  );
});

test('concurrent control requests cannot both overwrite the post-cleanup lifecycle', async () => {
  const entered = barrier<void>();
  const ready = barrier<DotModelSession>();
  await fixture(
    async ({ app }) => {
      const created = await app.create({ name: 'Researcher', goal: 'Retain this goal.' });
      const pending = await app.run(created.dot.id, created.dot.revision, 'offline');
      await entered.promise;
      const results = await Promise.allSettled([
        app.transition(created.dot.id, pending.dot.revision, 'pause'),
        app.transition(created.dot.id, pending.dot.revision, 'archive'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const current = await app.get(created.dot.id);
      expect(['paused', 'archived']).toContain(current.dot.lifecycle);
      expect(current.runs[0].status).toBe('cancelled');
      ready.release({ model: model(), release: () => {} });
    },
    async () => {
      entered.release();
      return ready.promise;
    },
  );
});

test('all focused Dot IPC methods retain frame, argument-count and payload validation', async () => {
  const handlers = new Map<string, (context: InvokeContext, ...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const fake = Object.fromEntries(
    [
      'list',
      'get',
      'create',
      'run',
      'stop',
      'transition',
      'history',
      'checkpoints',
      'context',
      'record',
      'decide',
      'resumeApproval',
      'openSource',
      'authorizeResearch',
      'revokeResearch',
      'scheduleWake',
      'cancelWake',
      'requests',
      'reviewUnknown',
      'supervision',
    ].map((name) => [
      name,
      (..._args: unknown[]) => {
        calls.push(name);
        return { safe: true };
      },
    ]),
  ) as unknown as DotApplication;
  registerDesktopIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {} as DesktopService,
    () => ({ senderId: 2, url: 'file:///app/index.html' }),
    () => {},
    fake,
  );
  const trusted = { senderId: 2, frameUrl: 'file:///app/index.html', isMainFrame: true };
  const entries: [string, unknown[]][] = [
    [Channels.dotsScheduleWake, ['dot', 0, 'policy', 200]],
    [Channels.dotsCancelWake, ['dot', 'wake', 0]],
    [Channels.dotsSupervision, []],
    [Channels.dotsContext, ['dot', {}]],
    [Channels.dotsRecord, ['dot', { kind: 'checkpoint', runId: 'run', section: 'summary' }]],
    [Channels.dotsRequests, ['dot', {}]],
    [
      Channels.dotsReviewUnknown,
      ['dot', 3, 'intent', 3, 'a'.repeat(64), { acknowledge: true, note: 'Reviewed' }],
    ],
    [Channels.dotsList, [{}]],
    [Channels.dotsGet, ['dot']],
    [Channels.dotsCreate, [{ name: 'Name', goal: 'Goal' }]],
    [Channels.dotsRun, ['dot', 0, 'offline']],
    [Channels.dotsStop, ['dot']],
    [Channels.dotsTransition, ['dot', 0, 'pause']],
    [Channels.dotsHistory, ['dot', {}]],
    [Channels.dotsCheckpoints, ['dot', {}]],
    [Channels.dotsDecide, ['dot', 2, 'intent', 0, 'a'.repeat(64), 'approve']],
    [Channels.dotsResumeApproval, ['dot', 2, 'intent']],
    [Channels.dotsOpenSource, ['dot', 'intent', 'src_123']],
    [
      Channels.dotsAuthorizeResearch,
      [
        'dot',
        0,
        'model',
        {
          queries: [{ query: 'bounded', maxResults: 1 }],
          allowDiscoveredPages: false,
          expiresAt: Date.now() + 3600000,
          limits: {
            maxRuns: 1,
            maxSearches: 1,
            maxFetches: 0,
            maxResponseBytes: 1024 * 1024,
            maxModelTurns: 8,
            maxModelRequestBytes: 8 * 96 * 1024,
          },
        },
      ],
    ],
    [Channels.dotsRevokeResearch, ['dot', 'policy', 0]],
  ];
  for (const [channel, args] of entries) {
    const invoke = handlers.get(channel);
    if (!invoke) throw new Error('Missing focused channel.');
    for (const context of [
      { ...trusted, senderId: 3 },
      { ...trusted, isMainFrame: false },
      { ...trusted, frameUrl: 'https://untrusted.test' },
    ])
      await expect(invoke(context, ...args)).rejects.toThrow('security boundary');
    await expect(invoke(trusted, ...args, 'extra')).rejects.toThrow('security boundary');
  }
  const create = handlers.get(Channels.dotsCreate);
  const run = handlers.get(Channels.dotsRun);
  const list = handlers.get(Channels.dotsList);
  const get = handlers.get(Channels.dotsGet);
  if (!create || !run || !list || !get) throw new Error('Missing handlers.');
  await expect(
    create(trusted, { name: 'Name', goal: 'Goal', lifecycle: 'completed' }),
  ).rejects.toThrow('Unexpected');
  await expect(run(trusted, 'dot', -1, 'offline')).rejects.toThrow('revision');
  await expect(list(trusted, { limit: 201 })).rejects.toThrow('page size');
  await expect(list(trusted, { offset: Number.NaN })).rejects.toThrow('offset');
  const context = handlers.get(Channels.dotsContext);
  if (!context) throw new Error('Missing context handler.');
  for (const query of [
    { dotId: 'another-dot' },
    { runId: 'run', beforeRunId: 'other' },
    { requestOffset: -1 },
    { requestOffset: 201 },
    { runId: '../../private' },
  ])
    await expect(context(trusted, 'dot', query)).rejects.toThrow();
  expect(calls).toEqual([]);
  await get(trusted, 'a'.repeat(128));
  expect(calls).toEqual(['get']);
});
