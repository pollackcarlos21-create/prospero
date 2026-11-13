import { expect, test } from 'bun:test';
import { ProsperoStore } from '@prospero/persistence';
import { DotApplication, type DotSchedulerClock } from './dot-application';
import { DotExecutionService } from './dot-execution';
import { ExecutionAdmission } from './execution-admission';

class Clock implements DotSchedulerClock {
  value = Date.now();
  private sequence = 0;
  jobs = new Map<number, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.sequence;
    this.jobs.set(id, { at: this.value + delay, callback });
    return () => {
      this.jobs.delete(id);
    };
  };
  flush() {
    for (let i = 0; i < 100; i++) {
      const ready = [...this.jobs]
        .filter(([, job]) => job.at <= this.value)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) return;
      this.jobs.delete(ready[0]);
      ready[1].callback();
    }
    throw new Error('Scheduler spun without progress');
  }
  advance(ms: number) {
    this.value += ms;
    this.flush();
  }
}
const provider = {
  id: 'model',
  baseUrl: 'https://model.example.test/v1',
  model: 'fixture',
  displayName: 'Fixture',
  supportsTools: true,
  hasApiKey: false,
  timeoutMs: 30000,
};
async function fixture(
  body: (context: {
    store: ProsperoStore;
    clock: Clock;
    admission: ExecutionAdmission;
    runner: DotExecutionService;
    app: () => DotApplication;
    reopen: () => void;
    id: string;
    sessions: () => number;
    seen: string[];
    config: (value: number) => void;
  }) => Promise<void>,
  failInitialization = false,
) {
  const store = new ProsperoStore(':memory:');
  const clock = new Clock();
  const admission = new ExecutionAdmission();
  let app: DotApplication;
  let sessions = 0;
  let configuration = 7;
  const seen: string[] = [];
  const runner = new DotExecutionService(
    store.dots(),
    admission,
    async () => {
      sessions++;
      if (failInitialization) throw new Error('Fixture initialization failure');
      let calls = 0;
      return {
        release: () => {},
        model: {
          stream: async (request) => {
            seen.push(JSON.stringify(request.messages));
            return ++calls === 1
              ? {
                  content: '',
                  toolCalls: [
                    {
                      id: 'progress',
                      name: 'record_progress',
                      arguments: JSON.stringify({
                        summary: `Saved scheduled result ${sessions}`,
                        completed: ['Inspected fixture notes'],
                        next: ['Continue next time'],
                      }),
                    },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'Saved.', toolCalls: [], finishReason: 'stop' };
          },
        },
      };
    },
    (event) => app?.notify(event),
    clock.now,
    30000,
    {
      provider: () => provider,
      policyRevision: () => configuration,
      open: async () => ({
        definitions: [],
        prepare: async () => {
          throw new Error('No Web request in this timing fixture');
        },
        receipt: () => ({ summary: 'none', sourceIds: [] }),
        close: () => {},
      }),
    },
  );
  const open = () =>
    new DotApplication(
      store.dots(),
      runner,
      () => [provider],
      () => {},
      undefined,
      undefined,
      admission,
      clock,
    );
  app = open();
  const created = await app.create({ name: 'Scheduled', goal: 'Maintain a bounded brief' });
  await app.authorizeResearch(created.dot.id, created.dot.revision, provider.id, {
    queries: [{ query: 'bounded', maxResults: 1 }],
    allowDiscoveredPages: false,
    expiresAt: clock.now() + 3600000,
    limits: {
      maxRuns: 3,
      maxSearches: 3,
      maxFetches: 0,
      maxResponseBytes: 1048576,
      maxModelTurns: 24,
      maxModelRequestBytes: 24 * 96 * 1024,
    },
  });
  try {
    await body({
      store,
      clock,
      admission,
      runner,
      app: () => app,
      reopen: () => {
        app.dispose();
        app = open();
      },
      id: created.dot.id,
      sessions: () => sessions,
      seen,
      config: (value) => {
        configuration = value;
      },
    });
  } finally {
    app.dispose();
    await runner.shutdown();
    store.close();
  }
}
async function schedule(
  context: { app: () => DotApplication; id: string; clock: Clock },
  after = 1000,
) {
  const view = await context.app().get(context.id);
  if (!view.policy) throw new Error('Missing policy');
  return context
    .app()
    .scheduleWake(
      context.id,
      view.dot.revision,
      view.policy.policy.id,
      context.clock.now() + after,
    );
}
test('due wake waits for shared admission, then consumes the saved checkpoint exactly once', async () =>
  fixture(async (c) => {
    await c.app().run(c.id, 0, provider.id);
    await c.runner.wait(c.id);
    c.clock.flush();
    await schedule(c);
    c.clock.flush();
    const chat = c.admission.acquire({ kind: 'chat', id: 'chat' });
    c.clock.advance(1000);
    expect(c.sessions()).toBe(1);
    expect(c.clock.jobs.size).toBe(0);
    chat.release();
    c.clock.flush();
    await c.runner.wait(c.id);
    c.clock.flush();
    expect(c.sessions()).toBe(2);
    expect(c.store.dots().checkpoint(c.id)?.revision).toBe(2);
    expect(c.seen.slice(2).join(' ')).toContain('Saved scheduled result 1');
    expect(c.store.dots().snapshot(c.id).wakes[0].status).toBe('claimed');
    c.clock.advance(100000);
    c.app().refreshScheduler();
    c.clock.flush();
    expect(c.sessions()).toBe(2);
    expect(c.clock.jobs.size).toBe(0);
  }));
test('reopening catches up one overdue wake and repeated startup scans do not repeat its Run', async () =>
  fixture(async (c) => {
    await schedule(c);
    c.clock.flush();
    c.reopen();
    c.clock.value += 2000;
    c.clock.flush();
    await c.runner.wait(c.id);
    c.clock.flush();
    expect(c.sessions()).toBe(1);
    expect(c.store.dots().currentPolicy(c.id)?.usage.runs).toBe(1);
    c.reopen();
    c.clock.flush();
    expect(c.sessions()).toBe(1);
    expect(c.store.dots().runs(c.id)).toHaveLength(1);
  }));
test('clock reversal cannot dispatch early; resume notification catches a forward jump', async () =>
  fixture(async (c) => {
    const start = c.clock.now();
    await schedule(c, 60000);
    c.clock.flush();
    c.clock.value = start - 30000;
    c.app().refreshScheduler();
    c.clock.flush();
    expect(c.sessions()).toBe(0);
    c.clock.value = start + 59999;
    c.clock.flush();
    expect(c.sessions()).toBe(0);
    c.clock.value = start + 60000;
    c.app().refreshScheduler();
    c.clock.flush();
    await c.runner.wait(c.id);
    c.clock.flush();
    expect(c.sessions()).toBe(1);
  }));
for (const action of ['pause', 'stop', 'revoke'] as const)
  test(`${action} cancels pending wake and no timer revives it`, async () =>
    fixture(async (c) => {
      await schedule(c);
      c.clock.flush();
      if (action === 'pause') {
        const view = await c.app().get(c.id);
        const paused = await c.app().transition(c.id, view.dot.revision, 'pause');
        await c.app().transition(c.id, paused.dot.revision, 'resume');
      } else if (action === 'stop') await c.app().stop(c.id);
      else {
        const view = await c.app().get(c.id);
        if (!view.policy) throw new Error('No policy');
        await c.app().revokeResearch(c.id, view.policy.policy.id, view.policy.policy.revision);
      }
      c.clock.advance(2000);
      expect(c.sessions()).toBe(0);
      expect(c.store.dots().snapshot(c.id).wakes[0].status).not.toBe('scheduled');
      expect(c.clock.jobs.size).toBe(0);
    }));
test('configuration change blocks before model initialization and keeps an inspectable reason', async () =>
  fixture(async (c) => {
    await schedule(c);
    c.config(8);
    c.clock.advance(1000);
    expect(c.sessions()).toBe(0);
    expect(c.store.dots().snapshot(c.id).wakes[0].reason).toBe('configuration');
    expect(c.store.dots().runs(c.id)).toEqual([]);
    expect(c.clock.jobs.size).toBe(0);
  }));
test('failure after a committed claim never retries initialization through another timer or restart', async () =>
  fixture(async (c) => {
    await schedule(c);
    c.clock.advance(1000);
    await c.runner.wait(c.id);
    c.clock.flush();
    expect(c.sessions()).toBe(1);
    expect(c.store.dots().snapshot(c.id).wakes[0].status).toBe('claimed');
    c.reopen();
    c.clock.flush();
    c.clock.advance(100000);
    expect(c.sessions()).toBe(1);
    expect(c.store.dots().currentPolicy(c.id)?.usage.runs).toBe(1);
  }, true));
