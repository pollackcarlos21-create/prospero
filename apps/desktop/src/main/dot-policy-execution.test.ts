import { expect, test } from 'bun:test';
import { ProsperoStore } from '@prospero/persistence';
import type { ModelPort, ToolDefinition } from '@prospero/core';
import { DotApplication } from './dot-application';
import { DotExecutionService } from './dot-execution';
import { ExecutionAdmission } from './execution-admission';
const provider = {
  id: 'model',
  baseUrl: 'https://fixture.example.test/v1',
  model: 'fixture',
  displayName: 'Fixture',
  supportsTools: true,
  hasApiKey: false,
  timeoutMs: 30000,
};
function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const terms = () => ({
  queries: [{ query: 'bounded question', maxResults: 5 }],
  allowDiscoveredPages: true,
  expiresAt: Date.now() + 3600000,
  limits: {
    maxRuns: 3,
    maxSearches: 6,
    maxFetches: 6,
    maxResponseBytes: 8 * 1024 * 1024,
    maxModelTurns: 24,
    maxModelRequestBytes: 24 * 96 * 1024,
  },
});
test('revoking a live policy cancels model work and preserves its conservative reservation', async () => {
  const store = new ProsperoStore(':memory:');
  const admission = new ExecutionAdmission();
  const entered = barrier<void>();
  const native = barrier<Awaited<ReturnType<ModelPort['stream']>>>();
  let calls = 0;
  let app: DotApplication | undefined;
  const runner = new DotExecutionService(
    store.dots(),
    admission,
    async () => ({
      model: {
        stream: async () => {
          calls++;
          entered.release();
          return native.promise;
        },
      },
      release: () => {},
    }),
    (event) => app?.notify(event),
    Date.now,
    30000,
    {
      provider: () => provider,
      policyRevision: () => 7,
      open: async () => ({
        definitions: [],
        prepare: async () => {
          throw new Error('No tools requested.');
        },
        receipt: () => ({ summary: 'none', sourceIds: [] }),
        close: () => {},
      }),
    },
  );
  app = new DotApplication(
    store.dots(),
    runner,
    () => [provider],
    () => {},
    undefined,
    undefined,
    admission,
  );
  try {
    const created = await app.create({ name: 'Bounded', goal: 'Inspect the bounded question.' });
    const authorized = await app.authorizeResearch(
      created.dot.id,
      created.dot.revision,
      provider.id,
      terms(),
    );
    await app.run(created.dot.id, authorized.dot.revision, provider.id);
    await entered.promise;
    const stopped = await app.revokeResearch(created.dot.id, authorized.policy?.policy.id ?? '', 0);
    expect(stopped.policy?.policy.status).toBe('revoked');
    expect(stopped.policy?.usage.reservedModelTurns).toBe(8);
    expect(stopped.runs[0].status).toBe('cancelled');
    expect(calls).toBe(1);
    native.release({ content: 'Late result', toolCalls: [], finishReason: 'stop' });
    await Promise.resolve();
    expect(store.dots().checkpoint(created.dot.id)).toBeUndefined();
    expect(calls).toBe(1);
  } finally {
    app.dispose();
    native.release({ content: 'Late result', toolCalls: [], finishReason: 'stop' });
    await runner.shutdown();
    store.close();
  }
});
test('policy pump makes one automatic initialization attempt and leaves an unconsumed approval for explicit retry', async () => {
  const store = new ProsperoStore(':memory:');
  const admission = new ExecutionAdmission();
  let app: DotApplication | undefined;
  let initializations = 0;
  const failed = barrier<void>();
  const definition: ToolDefinition = {
    name: 'web_search',
    description: 'bounded',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: ['network.search'],
  };
  const runner = new DotExecutionService(
    store.dots(),
    admission,
    async () => {
      if (++initializations > 1) {
        failed.release();
        throw new Error('Fixture initialization unavailable.');
      }
      return {
        model: {
          stream: async () => ({
            content: '',
            toolCalls: [
              {
                id: 'search',
                name: 'web_search',
                arguments: '{"query":"bounded question","maxResults":1}',
              },
            ],
            finishReason: 'tool_calls',
          }),
        },
        release: () => {},
      };
    },
    (event) => app?.notify(event),
    Date.now,
    30000,
    {
      provider: () => provider,
      policyRevision: () => 7,
      open: async () => ({
        definitions: [definition],
        prepare: async (call) => ({
          call,
          definition,
          preview: {
            kind: 'web',
            title: 'bounded query',
            query: 'bounded question',
            effects: ['network.search'],
          },
          permissionKey: 'bounded',
          requiresPermission: true,
          allowSession: false,
          onSuspended: () => {},
          execute: async () => {
            throw new Error('No effect may run in this fixture.');
          },
        }),
        receipt: () => ({ summary: 'none', sourceIds: [] }),
        close: () => {},
      }),
    },
  );
  app = new DotApplication(
    store.dots(),
    runner,
    () => [provider],
    () => {},
    undefined,
    undefined,
    admission,
  );
  try {
    const created = await app.create({ name: 'Bounded', goal: 'Inspect the bounded question.' });
    await app.authorizeResearch(created.dot.id, created.dot.revision, provider.id, terms());
    await app.run(created.dot.id, created.dot.revision, provider.id);
    await failed.promise;
    await runner.wait(created.dot.id);
    const chat = admission.acquire({ kind: 'chat', id: 'fixture-chat' });
    chat.release();
    // The pump timer is enqueued before this explicit timer-queue turn; no elapsed-time assumption.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(initializations).toBe(2);
    const view = await app.get(created.dot.id);
    expect(view.approvals?.[0].status).toBe('approved');
    expect(view.policy?.usage.searches).toBe(0);
    expect(view.policy?.usage.reservedModelTurns).toBe(8);
  } finally {
    app.dispose();
    await runner.shutdown();
    store.close();
  }
});
