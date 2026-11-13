import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAgent, type ToolDefinition } from '@prospero/core';
import { ProsperoStore, DotRepositoryError, SCHEMA_VERSION, type DotRepository } from './index';
import type { DotResearchPolicyInput } from '@prospero/dots';
const provider = { id: 'model', baseUrl: 'https://model.example.test/v1', model: 'fixture' };
async function fixture(
  body: (store: ProsperoStore, inspect: DatabaseSync, path: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-policy-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const inspect = new DatabaseSync(path);
  try {
    await body(store, inspect, path);
  } finally {
    inspect.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function authorize(repo: DotRepository, limits: Partial<DotResearchPolicyInput['limits']> = {}) {
  const at = Date.now() - 100;
  const dot = repo.create({
    id: 'dot',
    name: 'Research',
    goal: { text: 'Keep a bounded brief' },
    createdAt: at,
  });
  return repo.createPolicy(
    {
      id: 'policy',
      dotId: dot.id,
      provider,
      configurationRevision: 7,
      createdAt: at,
      expiresAt: at + 3600000,
      queries: [{ query: 'bounded question', maxResults: 3 }],
      allowDiscoveredPages: true,
      limits: {
        maxRuns: 3,
        maxSearches: 6,
        maxFetches: 6,
        maxResponseBytes: 8 * 1024 * 1024,
        maxModelTurns: 24,
        maxModelRequestBytes: 24 * 96 * 1024,
        ...limits,
      },
    },
    dot.revision,
  );
}
async function pending(
  repo: DotRepository,
  seq: number,
  tool = 'web_search',
  args: unknown = { query: 'bounded question', maxResults: 3 },
) {
  const dot = repo.get('dot');
  if (!dot) throw new Error('Missing Dot');
  const queued = repo.createRun(dot.id, dot.revision, {
    id: `run-${seq}`,
    createdAt: Math.max(Date.now(), dot.updatedAt),
    provider,
    configurationRevision: 7,
  });
  const running = repo.startRun(dot.id, queued.run.id, queued.dot.revision, Date.now());
  const definition: ToolDefinition = {
    name: tool,
    description: 'bounded fixture',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: [tool === 'web_search' ? 'network.search' : 'network.fetch'],
  };
  const outcome = await runAgent({
    executionId: running.run.id,
    messages: [{ role: 'user', content: 'Inspect the bounded question.' }],
    signal: new AbortController().signal,
    onEvent: () => {},
    limits: { maxModelTurns: 8, maxContextBytes: 96 * 1024 },
    suspension: {},
    permissions: { decide: async () => 'suspend' },
    model: {
      stream: async () => ({
        content: '',
        toolCalls: [{ id: `call-${seq}`, name: tool, arguments: JSON.stringify(args) }],
        finishReason: 'tool_calls',
      }),
    },
    host: {
      definitions: [definition],
      prepare: async (call) => ({
        call,
        definition,
        preview: {
          kind: 'web',
          title: 'bounded fixture',
          effects: definition.effects,
          ...(tool === 'web_search'
            ? { query: String((args as { query: string }).query).trim() }
            : { url: String((args as { url: string }).url) }),
        },
        requiresPermission: true,
        allowSession: false,
        permissionKey: `exact-${seq}`,
        onSuspended: () => {},
        execute: async () => {
          throw new Error('No effect authorised by preparing fixtures.');
        },
      }),
    },
  });
  if (outcome.state !== 'suspended') throw new Error('Missing actual core suspension');
  const intent = repo.createIntent({
    id: `intent-${seq}`,
    dotId: dot.id,
    runId: running.run.id,
    dotRevision: running.dot.revision,
    provider,
    policyRevision: 7,
    request: outcome.request,
    continuation: outcome.continuation,
    createdAt: Date.now(),
    expiresAt: outcome.continuation.pending.expiresAt,
  });
  return { running, intent };
}
function complete(
  repo: DotRepository,
  value: Awaited<ReturnType<typeof pending>>,
  sources = false,
) {
  const { intent, running } = value;
  const approved = repo.approveByPolicy(intent.id, Date.now());
  if (!approved) throw new Error('Expected derived approval');
  const dispatched = repo.dispatchIntent(intent.id, approved.revision, intent.digest, Date.now());
  repo.settleIntent(
    intent.id,
    dispatched.revision,
    intent.digest,
    {
      status: 'succeeded',
      receipt: {
        summary: 'Observed response',
        sourceIds: sources ? ['source-1'] : [],
        ...(sources
          ? {
              sources: [
                {
                  id: 'source-1',
                  url: 'https://paper.example.test/article',
                  title: 'Observed source',
                  kind: 'search' as const,
                  retrievedAt: Date.now(),
                  contentHash: 'fixture-hash',
                  excerpt: '',
                },
              ],
            }
          : {}),
      },
    },
    Date.now(),
  );
  repo.finishRun(running.dot.id, running.run.id, running.dot.revision, 'succeeded', Date.now());
}
test('Run/model/Web reservations survive reopen and budget exhaustion creates no new Run', async () =>
  fixture(async (store, _inspect, path) => {
    const repo = store.dots();
    authorize(repo, { maxRuns: 2, maxModelTurns: 16, maxModelRequestBytes: 16 * 96 * 1024 });
    complete(repo, await pending(repo, 1));
    const reopened = new ProsperoStore(path);
    try {
      const second = await pending(reopened.dots(), 2);
      complete(reopened.dots(), second);
      const current = reopened.dots().currentPolicy('dot');
      expect(current?.usage).toEqual({
        runs: 2,
        searches: 2,
        fetches: 0,
        reservedResponseBytes: 512 * 1024,
        reservedModelTurns: 16,
        reservedModelRequestBytes: 16 * 96 * 1024,
      });
      const dot = reopened.dots().get('dot');
      if (!dot) throw new Error('Missing Dot');
      expect(() =>
        reopened.dots().createRun(dot.id, dot.revision, {
          id: 'over-budget',
          createdAt: Date.now(),
          provider,
          configurationRevision: 7,
        }),
      ).toThrow(DotRepositoryError);
      expect(reopened.dots().runs(dot.id)).toHaveLength(2);
      expect(reopened.dots().currentPolicy('dot')).toEqual(current);
    } finally {
      reopened.close();
    }
  }));
test('out-of-scope queries and arbitrary URLs receive no automatic approval', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    authorize(repo);
    const value = await pending(repo, 1, 'web_search', {
      query: 'outside question',
      maxResults: 3,
    });
    expect(repo.approveByPolicy(value.intent.id, Date.now())).toBeUndefined();
    expect(repo.intent(value.intent.id)?.status).toBe('pending');
    repo.cancelSuspendedRun('dot', value.running.run.id, value.running.dot.revision, Date.now());
    const fetch = await pending(repo, 2, 'fetch_page', {
      url: 'https://undiscovered.example.test/page',
    });
    expect(repo.approveByPolicy(fetch.intent.id, Date.now())).toBeUndefined();
    expect(repo.currentPolicy('dot')?.usage.fetches).toBe(0);
  }));
test('only successful in-scope search evidence enables discovered-page automatic approval', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    authorize(repo);
    complete(repo, await pending(repo, 1), true);
    const page = await pending(repo, 2, 'fetch_page', {
      url: 'https://paper.example.test/article',
    });
    expect(repo.approveByPolicy(page.intent.id, Date.now())?.status).toBe('approved');
    expect(repo.currentPolicy('dot')?.usage.reservedResponseBytes).toBe(256 * 1024);
  }));
test('revocation after approval prevents dispatch without consuming body budget and recovery interrupts the suspended Run', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    authorize(repo);
    const value = await pending(repo, 1);
    const approved = repo.approveByPolicy(value.intent.id, Date.now());
    if (!approved) throw new Error('No approval');
    repo.revokePolicy('dot', 'policy', 0, Date.now());
    expect(() =>
      repo.dispatchIntent(approved.id, approved.revision, approved.digest, Date.now()),
    ).toThrow(DotRepositoryError);
    expect(repo.currentPolicy('dot')?.usage.reservedResponseBytes).toBe(0);
    repo.recoverInFlight(Date.now(), () => true);
    expect(repo.intent(approved.id)?.status).toBe('stale');
    expect(repo.getRun(value.running.run.id)?.status).toBe('interrupted');
  }));
test('usage reservation and intent dispatch roll back together when the intent commit fails', async () =>
  fixture(async (store, inspect) => {
    const repo = store.dots();
    authorize(repo);
    const value = await pending(repo, 1);
    const approved = repo.approveByPolicy(value.intent.id, Date.now());
    if (!approved) throw new Error('No approval');
    inspect.exec(
      "CREATE TRIGGER fail_policy_dispatch BEFORE UPDATE ON dot_intents WHEN NEW.status='dispatching' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.dispatchIntent(approved.id, approved.revision, approved.digest, Date.now()),
    ).toThrow(DotRepositoryError);
    expect(repo.currentPolicy('dot')?.usage.searches).toBe(0);
    expect(repo.intent(approved.id)).toEqual(approved);
  }));
test('insufficient model budget blocks before a Run is created', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    authorize(repo, { maxModelTurns: 7 });
    const dot = repo.get('dot');
    if (!dot) throw new Error('Missing Dot');
    expect(() =>
      repo.createRun(dot.id, dot.revision, {
        id: 'no-run',
        createdAt: Date.now(),
        provider,
        configurationRevision: 7,
      }),
    ).toThrow();
    expect(repo.runs(dot.id)).toEqual([]);
    expect(repo.currentPolicy('dot')?.usage.runs).toBe(0);
  }));
test('an uncertain effect revokes its original repeat authorization and preserves the cumulative charge', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    authorize(repo);
    const value = await pending(repo, 1);
    const approved = repo.approveByPolicy(value.intent.id, Date.now());
    if (!approved) throw new Error('No approval');
    const dispatched = repo.dispatchIntent(
      approved.id,
      approved.revision,
      approved.digest,
      Date.now(),
    );
    repo.settleIntent(
      dispatched.id,
      dispatched.revision,
      dispatched.digest,
      { status: 'unknown' },
      Date.now(),
    );
    expect(repo.currentPolicy('dot')?.policy.status).toBe('revoked');
    expect(repo.currentPolicy('dot')?.usage.searches).toBe(1);
    expect(repo.intent(dispatched.id)?.status).toBe('unknown');
    expect(repo.getRun(value.running.run.id)?.status).toBe('interrupted');
  }));
test('a v6 DDL collision preserves v5 data and leaves no partially migrated policy tables', async () =>
  fixture(async (store, inspect, path) => {
    store.setSetting('marker', 'keep');
    inspect.exec(
      "DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; DROP TABLE dot_policy_approvals; DROP TABLE dot_policy_usage; DROP TABLE dot_policies; CREATE TABLE dot_policies(sentinel TEXT); INSERT INTO dot_policies VALUES('keep'); PRAGMA user_version=5",
    );
    const before = inspect.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
    expect(() => new ProsperoStore(path)).toThrow(DotRepositoryError);
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    expect(inspect.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
    expect(store.getSetting('marker', '')).toBe('keep');
  }));

test('expired/provider/configuration changes block Run creation without spending reservations', async () =>
  fixture(async (store) => {
    const repo = store.dots();
    const grant = authorize(repo);
    const dot = repo.get('dot');
    if (!dot) throw new Error('Missing Dot');
    for (const input of [
      {
        provider: { ...provider, model: 'different' },
        configurationRevision: 7,
        createdAt: Date.now(),
      },
      { provider, configurationRevision: 8, createdAt: Date.now() },
      { provider, configurationRevision: 7, createdAt: grant.policy.expiresAt },
    ])
      expect(() => repo.createRun(dot.id, dot.revision, { id: 'blocked', ...input })).toThrow(
        DotRepositoryError,
      );
    expect(repo.runs(dot.id)).toEqual([]);
    expect(repo.currentPolicy(dot.id)?.usage.runs).toBe(0);
  }));
test('migration from v5 adds only the policy tables and preserves pending Runs and expired unrelated sources', async () =>
  fixture(async (store, inspect, path) => {
    const repo = store.dots();
    const dot = repo.create({
      id: 'legacy',
      name: 'Legacy',
      goal: { text: 'Keep saved progress' },
      createdAt: 1,
    });
    const pending = repo.createRun(dot.id, 0, { id: 'legacy-run', createdAt: 2 });
    store.saveConversation({ id: 'legacy-chat', title: 'Keep', state: 'idle', updatedAt: 1 });
    inspect
      .prepare('INSERT INTO web_sources VALUES(?,?,?,?)')
      .run('legacy-chat', 'expired', '{"id":"expired"}', 0);
    inspect.exec(
      'DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; DROP TABLE dot_policy_approvals; DROP TABLE dot_policy_usage; DROP TABLE dot_policies; PRAGMA user_version=5',
    );
    const before = inspect.prepare('SELECT * FROM dot_runs').all();
    const sources = inspect.prepare('SELECT * FROM web_sources').all();
    const reopened = new ProsperoStore(path);
    try {
      expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      expect(reopened.dots().getRun(pending.run.id)).toEqual(pending.run);
      expect(inspect.prepare('SELECT * FROM dot_runs').all()).toEqual(before);
      expect(inspect.prepare('SELECT * FROM web_sources').all()).toEqual(sources);
      expect(reopened.dots().currentPolicy(dot.id)).toBeUndefined();
    } finally {
      reopened.close();
    }
  }));

for (const outcome of ['denied', 'unknown'] as const)
  test(`${outcome} invalidates a future wake in the same transaction, including while approval is pending`, async () =>
    fixture(async (store) => {
      const repo = store.dots();
      authorize(repo);
      const value = await pending(repo, 1);
      const dot = repo.get('dot');
      if (!dot) throw new Error('Missing fixture Dot');
      const at = Date.now();
      repo.scheduleWake(
        { id: 'waiting-wake', dotId: 'dot', policyId: 'policy', createdAt: at, dueAt: at + 1000 },
        dot.revision,
        provider,
        7,
      );
      expect(repo.nextWakeAt()).toBeUndefined();
      expect(repo.dueWakes(at + 2000)).toEqual([]);
      if (outcome === 'denied')
        repo.denySuspendedRun(
          'dot',
          dot.revision,
          value.intent.id,
          value.intent.revision,
          value.intent.digest,
          at,
        );
      else {
        const approved = repo.approveByPolicy(value.intent.id, at);
        if (!approved) throw new Error('Missing approval');
        const dispatched = repo.dispatchIntent(approved.id, approved.revision, approved.digest, at);
        repo.settleIntent(
          dispatched.id,
          dispatched.revision,
          dispatched.digest,
          { status: 'unknown' },
          at,
        );
      }
      expect(repo.wake('waiting-wake')?.status).toBe('blocked');
      expect(repo.wake('waiting-wake')?.reason).toBe('policy');
      expect(repo.dueWakes(at + 2000)).toEqual([]);
      expect(repo.currentPolicy('dot')?.usage.runs).toBe(1);
    }));
