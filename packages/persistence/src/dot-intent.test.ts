import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runAgent, type ToolDefinition } from '@prospero/core';
import { ProsperoStore, DotRepositoryError, SCHEMA_VERSION, type DotIntentInput } from './index';

async function fixture(
  body: (path: string, store: ProsperoStore, inspect: DatabaseSync) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-intent-'));
  const path = join(root, 'profile.sqlite');
  const store = new ProsperoStore(path);
  const inspect = new DatabaseSync(path);
  try {
    await body(path, store, inspect);
  } finally {
    inspect.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function pending(
  store: ProsperoStore,
  dotId = 'research',
  intentId = 'intent-1',
  reuse = false,
) {
  const at = Date.now() - 100;
  const repo = store.dots();
  const dot = reuse
    ? repo.get(dotId)
    : repo.create({
        id: dotId,
        name: 'Researcher',
        goal: { text: 'Maintain a brief.' },
        createdAt: at,
      });
  if (!dot) throw new Error('Missing fixture Dot');
  const runAt = reuse ? Math.max(Date.now(), dot.updatedAt) : at + 1;
  const queued = repo.createRun(dot.id, dot.revision, {
    id: reuse ? `run-${dotId}-${intentId}` : `run-${dotId}`,
    createdAt: runAt,
  });
  const running = repo.startRun(dot.id, queued.run.id, queued.dot.revision, reuse ? runAt : at + 2);
  const definition: ToolDefinition = {
    name: 'web_search',
    description: 'Search fixture',
    inputSchema: { type: 'object' },
    riskLevel: 'read',
    effects: ['network.search'],
  };
  const outcome = await runAgent({
    executionId: running.run.id,
    messages: [{ role: 'user', content: 'Search exactly one bounded query.' }],
    signal: new AbortController().signal,
    onEvent: () => {},
    model: {
      stream: async () => ({
        content: '',
        toolCalls: [
          { id: 'query-1', name: 'web_search', arguments: '{"query":"bounded question"}' },
        ],
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
          title: 'Search one query',
          query: 'bounded question',
          effects: ['network.search'],
        },
        permissionKey: 'exact-search-v1',
        allowSession: false,
        requiresPermission: true,
        onSuspended: () => {},
        execute: async () => {
          throw new Error('No dispatch allowed while preparing this fixture.');
        },
      }),
    },
    permissions: { decide: async () => 'suspend' },
    suspension: {},
  });
  if (outcome.state !== 'suspended') throw new Error('The actual core suspension did not succeed.');
  const input: DotIntentInput = {
    id: intentId,
    dotId,
    runId: running.run.id,
    dotRevision: running.dot.revision,
    provider: {
      id: 'provider-1',
      baseUrl: 'https://fixture.example.test/v1',
      model: 'fixture-model',
    },
    policyRevision: 0,
    request: outcome.request,
    continuation: outcome.continuation,
    createdAt: Math.max(Date.now(), outcome.continuation.suspendedAt),
    expiresAt: outcome.continuation.pending.expiresAt,
  };
  return { running, input, intent: repo.createIntent(input) };
}

test('approval is a durable exact binding; approve does not consume or execute it', async () => {
  await fixture(async (path, store, inspect) => {
    const { input, intent, running } = await pending(store);
    const repo = store.dots();
    expect(Object.isFrozen(intent.continuation.messages)).toBe(true);
    expect(intent.digest).toHaveLength(64);
    expect(intent.status).toBe('pending');
    expect(repo.intentEvents(intent.id)).toEqual([
      { sequence: 1, status: 'pending', at: input.createdAt },
    ]);
    const approved = repo.decideIntent(intent.id, 0, intent.digest, 'approve', input.createdAt + 1);
    expect(approved.status).toBe('approved');
    expect(approved.dispatchedAt).toBeUndefined();
    expect(repo.getRun(running.run.id)).toEqual(running.run);
    const before = inspect.prepare('SELECT * FROM dot_intents').all();
    const reopened = new ProsperoStore(path);
    try {
      expect(reopened.dots().intent(intent.id)).toEqual(approved);
      expect(
        reopened
          .dots()
          .intentEvents(intent.id)
          .map((event) => event.status),
      ).toEqual(['pending', 'approved']);
      expect(inspect.prepare('SELECT * FROM dot_intents').all()).toEqual(before);
      expect(reopened.dots().recoverInFlight(input.createdAt + 2, () => true)).toEqual([]);
      expect(reopened.dots().getRun(running.run.id)).toEqual(running.run);
      expect(reopened.dots().intent(intent.id)).toEqual(approved);
    } finally {
      reopened.close();
    }
  });
});

test('CAS decisions, exact digests and one-use dispatch reject competing or stale consumers', async () => {
  await fixture(async (path, store) => {
    const { intent } = await pending(store);
    const other = new ProsperoStore(path);
    try {
      const repo = store.dots();
      expect(() =>
        repo.decideIntent(intent.id, 0, '0'.repeat(64), 'approve', intent.createdAt + 1),
      ).toThrow(DotRepositoryError);
      const approved = repo.decideIntent(
        intent.id,
        0,
        intent.digest,
        'approve',
        intent.createdAt + 1,
      );
      expect(() =>
        other.dots().decideIntent(intent.id, 0, intent.digest, 'deny', intent.createdAt + 1),
      ).toThrow(DotRepositoryError);
      const dispatched = repo.dispatchIntent(
        intent.id,
        approved.revision,
        approved.digest,
        intent.createdAt + 2,
      );
      expect(dispatched.status).toBe('dispatching');
      expect(() =>
        other
          .dots()
          .dispatchIntent(intent.id, approved.revision, approved.digest, intent.createdAt + 3),
      ).toThrow(DotRepositoryError);
      const receipt = { summary: 'One search response received.', sourceIds: ['source-a'] };
      const succeeded = repo.settleIntent(
        intent.id,
        dispatched.revision,
        dispatched.digest,
        { status: 'succeeded', receipt },
        intent.createdAt + 3,
      );
      expect(succeeded.receipt).toEqual(receipt);
      expect(succeeded.digest).toBe(intent.digest);
      expect(repo.intentEvents(intent.id).map((event) => event.status)).toEqual([
        'pending',
        'approved',
        'dispatching',
        'succeeded',
      ]);
      expect(() =>
        repo.settleIntent(
          intent.id,
          dispatched.revision,
          dispatched.digest,
          { status: 'unknown' },
          intent.createdAt + 4,
        ),
      ).toThrow(DotRepositoryError);
    } finally {
      other.close();
    }
  });
});

test('denial, expiry and stale revalidation preserve intent history and grant no dispatch', async () => {
  await fixture(async (_path, store) => {
    const repo = store.dots();
    for (const status of ['denied', 'expired', 'stale'] as const) {
      const { intent } = await pending(store, status, `intent-${status}`);
      const next =
        status === 'denied'
          ? repo.decideIntent(intent.id, 0, intent.digest, 'deny', intent.createdAt + 1)
          : repo.invalidateIntent(
              intent.id,
              0,
              intent.digest,
              status,
              status === 'expired' ? intent.expiresAt : intent.createdAt + 1,
            );
      expect(next.status).toBe(status);
      expect(() =>
        repo.dispatchIntent(next.id, next.revision, next.digest, next.updatedAt),
      ).toThrow(DotRepositoryError);
      expect(repo.intentEvents(next.id).map((event) => event.status)).toEqual(['pending', status]);
    }
  });
});

test('suspended cancellation atomically ends the unconsumed intent and its Run', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    expect(() =>
      repo.finishRun(
        running.dot.id,
        running.run.id,
        running.dot.revision,
        'cancelled',
        intent.createdAt + 1,
      ),
    ).toThrow(DotRepositoryError);
    inspect.exec(
      "CREATE TRIGGER fail_cancel BEFORE UPDATE ON dot_runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.cancelSuspendedRun(
        running.dot.id,
        running.run.id,
        running.dot.revision,
        intent.createdAt + 1,
      ),
    ).toThrow(DotRepositoryError);
    expect(repo.intent(intent.id)).toEqual(intent);
    expect(repo.getRun(running.run.id)).toEqual(running.run);
    expect(repo.intentEvents(intent.id)).toHaveLength(1);
    inspect.exec('DROP TRIGGER fail_cancel');
    const stopped = repo.cancelSuspendedRun(
      running.dot.id,
      running.run.id,
      running.dot.revision,
      intent.createdAt + 1,
    );
    expect(stopped.run.status).toBe('cancelled');
    expect(stopped.dot.inFlightRunId).toBeUndefined();
    expect(repo.intent(intent.id)?.status).toBe('cancelled');
  });
});

test('a dispatch gap becomes unknown on startup and blocks every new Run for that Dot', async () => {
  await fixture(async (_path, store) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    expect(repo.intent(intent.id)).toEqual(dispatched);
    expect(repo.recoverInFlight(intent.createdAt + 3, () => true)).toHaveLength(1);
    expect(repo.intent(intent.id)?.status).toBe('unknown');
    const dot = repo.get(running.dot.id);
    if (!dot) throw new Error('Missing Dot.');
    expect(dot.inFlightRunId).toBeUndefined();
    expect(repo.getRun(running.run.id)?.status).toBe('interrupted');
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'never-replay', createdAt: intent.createdAt + 4 }),
    ).toThrow(DotRepositoryError);
    expect(repo.intentEvents(intent.id).map((event) => event.status)).toEqual([
      'pending',
      'approved',
      'dispatching',
      'unknown',
    ]);
    expect(repo.recoverInFlight(intent.createdAt + 5, () => true)).toEqual([]);
    expect(repo.intentEvents(intent.id)).toHaveLength(4);
  });
});

test('an explicit unknown settlement atomically interrupts the Run and never overwrites successful receipts', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    inspect.exec(
      "CREATE TRIGGER fail_unknown BEFORE UPDATE ON dot_runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.settleIntent(
        intent.id,
        dispatched.revision,
        intent.digest,
        { status: 'unknown' },
        intent.createdAt + 3,
      ),
    ).toThrow(DotRepositoryError);
    expect(repo.intent(intent.id)).toEqual(dispatched);
    expect(repo.getRun(running.run.id)).toEqual(running.run);
    inspect.exec('DROP TRIGGER fail_unknown');
    const unknown = repo.settleIntent(
      intent.id,
      dispatched.revision,
      intent.digest,
      { status: 'unknown' },
      intent.createdAt + 3,
    );
    expect(unknown.status).toBe('unknown');
    expect(repo.getRun(running.run.id)?.status).toBe('interrupted');
    expect(() =>
      repo.settleIntent(
        intent.id,
        unknown.revision,
        intent.digest,
        { status: 'succeeded', receipt: { summary: 'Invented late receipt', sourceIds: [] } },
        intent.createdAt + 4,
      ),
    ).toThrow(DotRepositoryError);
  });
});

test('successful dispatch receipts survive an interrupted continuation without becoming replay authority', async () => {
  await fixture(async (_path, store) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    const succeeded = repo.settleIntent(
      intent.id,
      dispatched.revision,
      intent.digest,
      { status: 'succeeded', receipt: { summary: 'Observed response', sourceIds: ['source-a'] } },
      intent.createdAt + 3,
    );
    repo.recoverInFlight(intent.createdAt + 4, () => true);
    expect(repo.getRun(running.run.id)?.status).toBe('interrupted');
    expect(repo.intent(intent.id)).toEqual(succeeded);
    expect(() =>
      repo.dispatchIntent(intent.id, succeeded.revision, intent.digest, intent.createdAt + 5),
    ).toThrow(DotRepositoryError);
  });
});

test('pending approvals expire during startup without starving later recovery batches', async () => {
  await fixture(async (_path, store) => {
    const a = await pending(store, 'a', 'intent-a');
    const b = await pending(store, 'b', 'intent-b');
    const repo = store.dots();
    expect(
      repo.recoverInFlight(Math.max(a.intent.expiresAt, b.intent.expiresAt), () => true, 1),
    ).toHaveLength(1);
    expect(repo.intent(a.intent.id)?.status).toBe('expired');
    expect(repo.intent(b.intent.id)?.status).toBe('expired');
    expect(
      repo.recoverInFlight(Math.max(a.intent.expiresAt, b.intent.expiresAt), () => true, 1),
    ).toHaveLength(1);
    expect(
      repo.recoverInFlight(Math.max(a.intent.expiresAt, b.intent.expiresAt), () => true, 1),
    ).toEqual([]);
  });
});

test('valid preserved approvals cannot prevent later unsuspended Runs from being recovered', async () => {
  await fixture(async (_path, store) => {
    const a = await pending(store, 'a', 'intent-a');
    const b = await pending(store, 'b', 'intent-b');
    const repo = store.dots();
    repo.decideIntent(b.intent.id, 0, b.intent.digest, 'deny', b.intent.createdAt + 1);
    expect(
      repo
        .recoverInFlight(Math.max(a.intent.createdAt, b.intent.createdAt) + 2, () => true, 1)
        .map((pair) => pair.dot.id),
    ).toEqual([b.running.dot.id]);
    expect(repo.getRun(a.running.run.id)).toEqual(a.running.run);
    expect(repo.getRun(b.running.run.id)?.status).toBe('interrupted');
  });
});

test('losing exclusive ownership rolls back both dispatch classification and interrupted Run', async () => {
  await fixture(async (_path, store) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    let checks = 0;
    expect(() => repo.recoverInFlight(intent.createdAt + 3, () => ++checks < 3)).toThrow(
      DotRepositoryError,
    );
    expect(repo.intent(intent.id)).toEqual(dispatched);
    expect(repo.getRun(running.run.id)).toEqual(running.run);
  });
});

for (const corruption of [
  "UPDATE dot_intents SET status='approved',revision=1",
  'UPDATE dot_intents SET revision=revision+1',
  'UPDATE dot_intents SET updated_at=updated_at+1',
  "INSERT INTO dot_intent_events VALUES('intent-1',2,'dispatching',9999999999999)",
])
  test(`intent corruption fails closed without repair: ${corruption}`, async () => {
    await fixture(async (_path, store, inspect) => {
      const { running } = await pending(store);
      inspect.exec(corruption);
      expect(() => store.dots().intent('intent-1')).toThrow(DotRepositoryError);
      expect(() => store.dots().recoverInFlight(Date.now(), () => true)).toThrow(
        DotRepositoryError,
      );
      expect(store.dots().getRun(running.run.id)).toEqual(running.run);
    });
  });

test('immutable bindings, append-only events and foreign keys reject direct overwrites', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent, input } = await pending(store);
    for (const mutation of [
      "UPDATE dot_intents SET binding='{}'",
      "UPDATE dot_intents SET digest=printf('%064d',0)",
      "UPDATE dot_intents SET dot_id='other'",
      "UPDATE dot_intent_events SET status='approved'",
      'DELETE FROM dot_intent_events',
      'DELETE FROM dot_intents',
    ])
      expect(() => inspect.exec(mutation)).toThrow();
    expect(store.dots().intent(intent.id)).toEqual(intent);
    expect(() =>
      store.dots().createIntent({
        ...input,
        id: 'replacement',
        request: {
          ...input.request,
          call: { ...input.request.call, arguments: '{"changed":true}' },
        },
      }),
    ).toThrow(DotRepositoryError);
    expect(() => store.dots().createIntent({ ...input, id: 'second-pending' })).toThrow(
      DotRepositoryError,
    );
    expect(store.dots().intents(input.dotId)).toEqual([intent]);
  });
});

test('an audit write failure rolls back an approval state change', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent } = await pending(store);
    inspect.exec(
      "CREATE TRIGGER fail_intent_audit BEFORE INSERT ON dot_intent_events WHEN NEW.sequence>1 BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      store.dots().decideIntent(intent.id, 0, intent.digest, 'approve', intent.createdAt + 1),
    ).toThrow(DotRepositoryError);
    expect(store.dots().intent(intent.id)).toEqual(intent);
    expect(store.dots().intentEvents(intent.id)).toHaveLength(1);
  });
});

test('v5 migration preserves v4 progress and expired unrelated sources without recovery', async () => {
  await fixture(async (path, store, inspect) => {
    const { running } = await pending(store);
    // Build an owned v4 fixture by removing only the newly added, unneeded v5 tables.
    inspect.exec(
      'DROP TRIGGER dot_intent_events_no_delete; DELETE FROM dot_intent_events; DELETE FROM dot_intents; DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; DROP TABLE dot_policy_approvals; DROP TABLE dot_policy_usage; DROP TABLE dot_policies; DROP TABLE dot_intent_events; DROP TABLE dot_intents; PRAGMA user_version=4;',
    );
    store.saveConversation({ id: 'legacy', title: 'Keep', state: 'idle', updatedAt: 1 });
    inspect
      .prepare('INSERT INTO web_sources VALUES(?,?,?,?)')
      .run('legacy', 'expired', '{"id":"expired"}', 0);
    const before = inspect.prepare('SELECT * FROM dot_runs').all();
    const sources = inspect.prepare('SELECT * FROM web_sources').all();
    const reopened = new ProsperoStore(path);
    try {
      expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      expect(reopened.dots().getRun(running.run.id)).toEqual(running.run);
      expect(inspect.prepare('SELECT * FROM dot_runs').all()).toEqual(before);
      expect(inspect.prepare('SELECT * FROM web_sources').all()).toEqual(sources);
      expect(reopened.dots().intents(running.dot.id)).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

test('a v5 DDL collision leaves the v4 schema and user data intact', async () => {
  await fixture(async (path, store, inspect) => {
    inspect.exec(
      "DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; DROP TABLE dot_wake_events; DROP TABLE dot_wakes; DROP TABLE dot_policy_approvals; DROP TABLE dot_policy_usage; DROP TABLE dot_policies; DROP TABLE dot_intent_events; DROP TABLE dot_intents; CREATE TABLE dot_intents(sentinel TEXT); INSERT INTO dot_intents VALUES('keep'); PRAGMA user_version=4;",
    );
    store.setSetting('marker', 'keep');
    const before = inspect.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
    expect(() => new ProsperoStore(path)).toThrow(DotRepositoryError);
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    expect(inspect.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
    expect(store.getSetting('marker', '')).toBe('keep');
    expect(inspect.prepare('SELECT sentinel FROM dot_intents').get()?.sentinel).toBe('keep');
  });
});

test('an independent process exit after an observed effect preserves an unknown outcome without replay', async () => {
  await fixture(async (path, store) => {
    const { intent, running } = await pending(store);
    store.dots().decideIntent(intent.id, 0, intent.digest, 'approve', intent.createdAt);
    const marker = join(path, '..', 'owned-effect.txt');
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures', 'dot-repository-process.ts'),
        'intent-crash-after-dispatch',
        path,
        marker,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect({ code: child.exitCode, error: child.stderr.toString() }).toEqual({
      code: 25,
      error: '',
    });
    expect(readFileSync(marker, 'utf8')).toBe('fixture effect occurred once');
    const reopened = new ProsperoStore(path);
    try {
      expect(reopened.dots().intent(intent.id)?.status).toBe('dispatching');
      reopened.dots().recoverInFlight(Date.now(), () => true);
      expect(reopened.dots().intent(intent.id)?.status).toBe('unknown');
      expect(reopened.dots().getRun(running.run.id)?.status).toBe('interrupted');
      expect(reopened.dots().recoverInFlight(Date.now(), () => true)).toEqual([]);
      expect(readFileSync(marker, 'utf8')).toBe('fixture effect occurred once');
      const dot = reopened.dots().get(running.dot.id);
      if (!dot) throw new Error('Missing Dot.');
      expect(() =>
        reopened
          .dots()
          .createRun(dot.id, dot.revision, { id: 'blocked-replay', createdAt: Date.now() }),
      ).toThrow(DotRepositoryError);
    } finally {
      reopened.close();
    }
  });
});

test('tampered saved bindings are rejected even when the row columns and prior audit are unchanged', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent, running } = await pending(store);
    const encoded = inspect
      .prepare('SELECT binding FROM dot_intents WHERE id=?')
      .get(intent.id)?.binding;
    if (typeof encoded !== 'string') throw new Error('Missing fixture binding.');
    const changed = JSON.parse(encoded);
    changed.provider.baseUrl = 'https://different.example.test/v1';
    // Prove normal writes are blocked, then inject owned test-only disk corruption.
    expect(() =>
      inspect
        .prepare('UPDATE dot_intents SET binding=? WHERE id=?')
        .run(JSON.stringify(changed), intent.id),
    ).toThrow();
    inspect.exec('DROP TRIGGER dot_intent_binding_immutable');
    inspect
      .prepare('UPDATE dot_intents SET binding=? WHERE id=?')
      .run(JSON.stringify(changed), intent.id);
    expect(() => store.dots().intent(intent.id)).toThrow(DotRepositoryError);
    expect(() => store.dots().recoverInFlight(Date.now(), () => true)).toThrow(DotRepositoryError);
    expect(store.dots().getRun(running.run.id)).toEqual(running.run);
  });
});

test('oversized UTF-8 receipts cannot commit an unreadable acknowledgement', async () => {
  await fixture(async (_path, store) => {
    const { intent } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    expect(() =>
      repo.settleIntent(
        intent.id,
        dispatched.revision,
        intent.digest,
        {
          status: 'succeeded',
          receipt: {
            summary: '界'.repeat(2048),
            sourceIds: Array.from({ length: 50 }, (_, index) => `${index}${'源'.repeat(250)}`),
          },
        },
        intent.createdAt + 3,
      ),
    ).toThrow(DotRepositoryError);
    expect(repo.intent(intent.id)).toEqual(dispatched);
    expect(repo.intentEvents(intent.id)).toHaveLength(3);
  });
});

test('denying a suspended request and cancelling its Run is atomic even when the paired write fails', async () => {
  await fixture(async (_path, store, inspect) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    inspect.exec(
      "CREATE TRIGGER fail_denied_run BEFORE UPDATE ON dot_runs BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.denySuspendedRun(
        running.dot.id,
        running.dot.revision,
        intent.id,
        intent.revision,
        intent.digest,
        intent.createdAt,
      ),
    ).toThrow(DotRepositoryError);
    expect(repo.intent(intent.id)).toEqual(intent);
    expect(repo.getRun(running.run.id)).toEqual(running.run);
    expect(repo.intentEvents(intent.id)).toHaveLength(1);
    inspect.exec('DROP TRIGGER fail_denied_run');
    repo.denySuspendedRun(
      running.dot.id,
      running.dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      intent.createdAt,
    );
    expect(repo.intent(intent.id)?.status).toBe('denied');
    expect(repo.getRun(running.run.id)?.status).toBe('cancelled');
  });
});

test('terminal Run time cannot precede a confirmed intent receipt, including backwards-clock startup recovery', async () => {
  await fixture(async (_path, store) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const approved = repo.decideIntent(
      intent.id,
      0,
      intent.digest,
      'approve',
      intent.createdAt + 1,
    );
    const dispatched = repo.dispatchIntent(
      intent.id,
      approved.revision,
      intent.digest,
      intent.createdAt + 2,
    );
    const succeeded = repo.settleIntent(
      intent.id,
      dispatched.revision,
      intent.digest,
      { status: 'succeeded', receipt: { summary: 'Confirmed response', sourceIds: [] } },
      intent.createdAt + 40,
    );
    expect(() =>
      repo.finishRun(
        running.dot.id,
        running.run.id,
        running.dot.revision,
        'succeeded',
        intent.createdAt + 3,
      ),
    ).toThrow();
    expect(repo.getRun(running.run.id)).toEqual(running.run);
    const recovered = repo.recoverInFlight(1, () => true);
    expect(recovered[0].run.updatedAt).toBe(succeeded.updatedAt);
    expect(repo.intent(intent.id)).toEqual(succeeded);
    expect(repo.snapshot(running.dot.id).intents[0]).toEqual(succeeded);
  });
});

async function uncertain(store: ProsperoStore) {
  const value = await pending(store);
  const repo = store.dots();
  const at = Date.now();
  const approved = repo.decideIntent(value.intent.id, 0, value.intent.digest, 'approve', at);
  const dispatched = repo.dispatchIntent(approved.id, approved.revision, approved.digest, at);
  const intent = repo.settleIntent(
    dispatched.id,
    dispatched.revision,
    dispatched.digest,
    { status: 'unknown' },
    at,
  );
  const dot = repo.get(intent.dotId);
  if (!dot) throw new Error('Missing fixture Dot');
  return { intent, dot, at };
}
test('explicit human acknowledgement survives reopen, preserves unknown facts and permits only a new explicit Run', async () =>
  fixture(async (path, store) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    const events = repo.intentEvents(intent.id);
    const run = repo.getRun(intent.runId);
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'blocked-before-review', createdAt: at }),
    ).toThrow(DotRepositoryError);
    const review = repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      'Inspected service history; accept the remaining uncertainty.',
      at,
    );
    expect(Object.isFrozen(review)).toBe(true);
    expect(repo.intent(intent.id)).toEqual(intent);
    expect(repo.intentEvents(intent.id)).toEqual(events);
    expect(repo.getRun(intent.runId)).toEqual(run);
    expect(repo.runs(dot.id)).toHaveLength(1);
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'stale-before-review', createdAt: at }),
    ).toThrow(DotRepositoryError);
    expect(repo.checkpoint(dot.id)).toBeUndefined();
    const reopened = new ProsperoStore(path);
    try {
      expect(reopened.dots().intentReview(intent.id)).toEqual(review);
      expect(reopened.dots().recoverInFlight(at, () => true)).toEqual([]);
      expect(reopened.dots().runs(dot.id)).toHaveLength(1);
      expect(() =>
        reopened
          .dots()
          .settleIntent(
            intent.id,
            intent.revision - 1,
            intent.digest,
            { status: 'succeeded', receipt: { summary: 'Late success', sourceIds: [] } },
            at,
          ),
      ).toThrow(DotRepositoryError);
      const next = reopened.dots().createRun(dot.id, reopened.dots().get(dot.id)?.revision ?? -1, {
        id: 'explicit-new-run',
        createdAt: at,
      });
      expect(next.run.status).toBe('pending');
      expect(reopened.dots().intentReview(intent.id)).toEqual(review);
    } finally {
      reopened.close();
    }
  }));
test('human review rejects mismatched owner, stale revisions, digest, empty and oversized notes without unblocking', async () =>
  fixture(async (_path, store) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    repo.create({ id: 'other', name: 'Other', goal: { text: 'Separate goal' }, createdAt: 1 });
    for (const [owner, revision, intentRevision, digest, note, time] of [
      ['other', 0, intent.revision, intent.digest, 'Reviewed', at],
      [dot.id, dot.revision - 1, intent.revision, intent.digest, 'Reviewed', at],
      [dot.id, dot.revision, intent.revision - 1, intent.digest, 'Reviewed', at],
      [dot.id, dot.revision, intent.revision, '0'.repeat(64), 'Reviewed', at],
      [dot.id, dot.revision, intent.revision, intent.digest, '', at],
      [dot.id, dot.revision, intent.revision, intent.digest, '界'.repeat(1400), at],
      [dot.id, dot.revision, intent.revision, intent.digest, 'Reviewed', at - 1],
    ] as const)
      expect(() =>
        repo.acknowledgeUnknown(owner, revision, intent.id, intentRevision, digest, note, time),
      ).toThrow();
    expect(repo.intentReview(intent.id)).toBeUndefined();
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'still-blocked', createdAt: at }),
    ).toThrow(DotRepositoryError);
  }));
test('pending approvals cannot be acknowledged as unknown and review records are insert-once', async () =>
  fixture(async (path, store, db) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    expect(() =>
      repo.acknowledgeUnknown(
        intent.dotId,
        running.dot.revision,
        intent.id,
        intent.revision,
        intent.digest,
        'Reviewed',
        Date.now(),
      ),
    ).toThrow(DotRepositoryError);
    const at = Date.now();
    const approved = repo.decideIntent(intent.id, 0, intent.digest, 'approve', at);
    const dispatched = repo.dispatchIntent(intent.id, approved.revision, intent.digest, at);
    const unknown = repo.settleIntent(
      intent.id,
      dispatched.revision,
      intent.digest,
      { status: 'unknown' },
      at,
    );
    const dot = repo.get(intent.dotId);
    if (!dot) throw new Error('Missing Dot');
    repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      unknown.id,
      unknown.revision,
      unknown.digest,
      'Reviewed once',
      at,
    );
    const other = new ProsperoStore(path);
    try {
      expect(() =>
        other
          .dots()
          .acknowledgeUnknown(
            dot.id,
            dot.revision,
            unknown.id,
            unknown.revision,
            unknown.digest,
            'Reviewed twice',
            at,
          ),
      ).toThrow(DotRepositoryError);
    } finally {
      other.close();
    }
    expect(() => db.exec("UPDATE dot_intent_reviews SET payload='{}'")).toThrow();
    expect(() => db.exec('DELETE FROM dot_intent_reviews')).toThrow();
  }));
test('review storage failure leaves unknown gate blocked and old ledger unchanged', async () =>
  fixture(async (_path, store, db) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    const before = repo.snapshot(dot.id);
    db.exec(
      "CREATE TRIGGER fail_review BEFORE INSERT ON dot_intent_reviews BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() =>
      repo.acknowledgeUnknown(
        dot.id,
        dot.revision,
        intent.id,
        intent.revision,
        intent.digest,
        'Reviewed',
        at,
      ),
    ).toThrow(DotRepositoryError);
    expect(repo.snapshot(dot.id)).toEqual(before);
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'still-blocked', createdAt: at }),
    ).toThrow(DotRepositoryError);
  }));
test('corrupt human review fails closed instead of granting a new Run', async () =>
  fixture(async (_path, store, db) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      'Reviewed',
      at,
    );
    db.exec("DROP TRIGGER dot_review_no_update; UPDATE dot_intent_reviews SET payload='{}'");
    expect(() => repo.intentReview(intent.id)).toThrow(DotRepositoryError);
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'never-authorized-by-corruption', createdAt: at }),
    ).toThrow(DotRepositoryError);
    expect(repo.runs(dot.id)).toHaveLength(1);
  }));
test('backwards time cannot create a new Run before its acknowledgement and history preserves earlier reviewed unknown', async () =>
  fixture(async (_path, store) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      'Reviewed source logs',
      at,
    );
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'backwards', createdAt: at - 1 }),
    ).toThrow();
    const second = await pending(store, dot.id, 'intent-2', true);
    const now = Math.max(Date.now(), second.intent.updatedAt);
    const approved = repo.decideIntent(second.intent.id, 0, second.intent.digest, 'approve', now);
    const dispatched = repo.dispatchIntent(approved.id, approved.revision, approved.digest, now);
    repo.settleIntent(
      dispatched.id,
      dispatched.revision,
      dispatched.digest,
      { status: 'succeeded', receipt: { summary: 'A new request result', sourceIds: [] } },
      now,
    );
    repo.finishRun(dot.id, second.running.run.id, second.running.dot.revision, 'succeeded', now);
    const latest = repo.requestHistory(dot.id, { limit: 1 });
    expect(latest.total).toBe(2);
    expect(latest.entries[0].intent.id).toBe('intent-2');
    const earlier = repo.requestHistory(dot.id, { limit: 1, offset: 1 });
    expect(earlier.entries[0].intent.status).toBe('unknown');
    expect(earlier.entries[0].review?.note).toBe('Reviewed source logs');
    expect(() => repo.requestHistory(dot.id, { limit: 21 })).toThrow();
    expect(repo.requestHistory(dot.id, { offset: 100 }).entries).toEqual([]);
  }));
test('v8 review migration is additive, preserves pending intents and unrelated expired sources, and rolls back a collision', async () =>
  fixture(async (path, store, db) => {
    const { intent } = await pending(store);
    store.saveConversation({ id: 'legacy-chat', title: 'Keep', state: 'idle', updatedAt: 1 });
    db.prepare('INSERT INTO web_sources VALUES(?,?,?,?)').run(
      'legacy-chat',
      'expired',
      '{"id":"expired"}',
      0,
    );
    const before = db.prepare('SELECT * FROM dot_intents').all();
    const sources = db.prepare('SELECT * FROM web_sources').all();
    db.exec(
      "DROP TABLE IF EXISTS dot_alert_claims; DROP TABLE dot_intent_reviews; CREATE TABLE dot_intent_reviews(sentinel TEXT); INSERT INTO dot_intent_reviews VALUES('keep'); PRAGMA user_version=7",
    );
    expect(() => new ProsperoStore(path)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
    expect(db.prepare('SELECT sentinel FROM dot_intent_reviews').get()?.sentinel).toBe('keep');
    db.exec('DROP TABLE dot_intent_reviews');
    const reopened = new ProsperoStore(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      expect(reopened.dots().intent(intent.id)).toEqual(intent);
      expect(db.prepare('SELECT * FROM dot_intents').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM web_sources').all()).toEqual(sources);
    } finally {
      reopened.close();
    }
  }));

test('a review without its paired Dot revision cannot unblock future work', async () =>
  fixture(async (_path, store, db) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      'Reviewed',
      at,
    );
    db.prepare('UPDATE dots SET revision=?,updated_at=?,payload=? WHERE id=?').run(
      dot.revision,
      dot.updatedAt,
      JSON.stringify(dot),
      dot.id,
    );
    expect(repo.get(dot.id)).toEqual(dot);
    expect(() => repo.intentReview(intent.id)).toThrow(DotRepositoryError);
    expect(() =>
      repo.createRun(dot.id, dot.revision, { id: 'never-from-unpaired-review', createdAt: at }),
    ).toThrow(DotRepositoryError);
  }));

test('bounded human notes preserve JSON-escaped text at the full UTF-8 limit', async () =>
  fixture(async (path, store) => {
    const { intent, dot, at } = await uncertain(store);
    const note = `${'\n'.repeat(4095)}x`;
    store
      .dots()
      .acknowledgeUnknown(
        dot.id,
        dot.revision,
        intent.id,
        intent.revision,
        intent.digest,
        note,
        at,
      );
    const reopened = new ProsperoStore(path);
    try {
      expect(reopened.dots().intentReview(intent.id)?.note).toBe(note);
    } finally {
      reopened.close();
    }
  }));

test(
  'reviewed history beyond one gate page cannot hide a later unresolved unknown',
  async () =>
    fixture(async (_path, store) => {
      const repo = store.dots();
      let last: Awaited<ReturnType<typeof pending>> | undefined;
      for (let i = 0; i < 201; i++) {
        const value = await pending(
          store,
          'research',
          `intent-${String(i).padStart(3, '0')}`,
          i > 0,
        );
        const at = Date.now();
        const approved = repo.decideIntent(value.intent.id, 0, value.intent.digest, 'approve', at);
        const dispatched = repo.dispatchIntent(approved.id, approved.revision, approved.digest, at);
        const unknown = repo.settleIntent(
          dispatched.id,
          dispatched.revision,
          dispatched.digest,
          { status: 'unknown' },
          at,
        );
        if (i < 200)
          repo.acknowledgeUnknown(
            'research',
            repo.get('research')?.revision ?? -1,
            unknown.id,
            unknown.revision,
            unknown.digest,
            'Inspected and accepted uncertainty',
            at,
          );
        else last = value;
      }
      if (!last) throw new Error('Missing last fixture request');
      const dot = repo.get('research');
      const unknown = repo.intent(last.intent.id);
      if (!dot || !unknown) throw new Error('Missing fixture state');
      expect(repo.requestHistory(dot.id).total).toBe(201);
      expect(() =>
        repo.createRun(dot.id, dot.revision, {
          id: 'blocked-after-page-one',
          createdAt: Date.now(),
        }),
      ).toThrow(DotRepositoryError);
      repo.acknowledgeUnknown(
        dot.id,
        dot.revision,
        unknown.id,
        unknown.revision,
        unknown.digest,
        'Reviewed the last unresolved request',
        Date.now(),
      );
      const next = repo.createRun(dot.id, repo.get(dot.id)?.revision ?? -1, {
        id: 'explicit-after-last-review',
        createdAt: Date.now(),
      });
      expect(String(next.run.id)).toBe('explicit-after-last-review');
    }),
  30000,
);

test('supervision alert claims survive reopen, deduplicate attempts and never decide or dispatch', async () =>
  fixture(async (path, store) => {
    const { intent, running } = await pending(store);
    const repo = store.dots();
    const entry = repo.supervisionPage().items[0];
    expect(entry.kind).toBe('approval');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(repo.canApproveByPolicy(intent.id, Date.now())).toBe(false);
    const at = Date.now();
    expect(repo.claimSupervisionAlerts([entry], at)).toEqual([entry]);
    expect(repo.intent(intent.id)).toEqual(intent);
    expect(repo.intentEvents(intent.id)).toHaveLength(1);
    expect(repo.runs(intent.dotId)).toHaveLength(1);
    const other = new ProsperoStore(path);
    try {
      expect(other.dots().claimSupervisionAlerts([entry], at)).toEqual([]);
      expect(other.dots().alertClaim(intent.id, 'approval')?.claimedAt).toBe(at);
    } finally {
      other.close();
    }
    const approved = repo.decideIntent(intent.id, 0, intent.digest, 'approve', at);
    const dispatched = repo.dispatchIntent(intent.id, approved.revision, intent.digest, at);
    const unknown = repo.settleIntent(
      intent.id,
      dispatched.revision,
      intent.digest,
      { status: 'unknown' },
      at,
    );
    const attention = repo.supervisionPage().items[0];
    expect(attention.kind).toBe('uncertain');
    expect(repo.claimSupervisionAlerts([attention], at)).toEqual([attention]);
    expect(repo.alertClaim(intent.id, 'approval')?.intentRevision).toBe(0);
    repo.acknowledgeUnknown(
      intent.dotId,
      repo.get(intent.dotId)?.revision ?? -1,
      unknown.id,
      unknown.revision,
      unknown.digest,
      'Reviewed',
      at,
    );
    expect(repo.supervisionPage().items).toEqual([]);
    expect(repo.claimSupervisionAlerts([attention], at)).toEqual([]);
    expect(repo.getRun(running.run.id)?.status).toBe('interrupted');
  }));
test('stale and paused supervision snapshots cannot claim a native alert', async () =>
  fixture(async (_path, store) => {
    const { intent, dot, at } = await uncertain(store);
    const repo = store.dots();
    const entry = repo.supervisionPage().items[0];
    expect(
      repo.claimSupervisionAlerts([{ ...entry, intentRevision: entry.intentRevision + 1 }], at),
    ).toEqual([]);
    const paused = repo.transition(dot.id, dot.revision, 'pause', at);
    expect(repo.claimSupervisionAlerts([entry], at)).toEqual([]);
    expect(repo.supervisionPage().items).toEqual([]);
    repo.transition(dot.id, paused.revision, 'resume', at);
    expect(repo.supervisionPage().items).toEqual([entry]);
    expect(repo.claimSupervisionAlerts([entry], at - 1)).toEqual([]);
    expect(repo.alertClaim(intent.id, 'uncertain')).toBeUndefined();
  }));
test('alert batch failure rolls back every attempt and leaves both approvals pending', async () =>
  fixture(async (_path, store, db) => {
    const first = await pending(store, 'first', 'first-intent');
    const second = await pending(store, 'second', 'second-intent');
    const repo = store.dots();
    const entries = repo.supervisionPage().items;
    db.exec(
      "CREATE TRIGGER fail_alert BEFORE INSERT ON dot_alert_claims WHEN NEW.intent_id='second-intent' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    expect(() => repo.claimSupervisionAlerts(entries, Date.now())).toThrow(DotRepositoryError);
    expect(repo.alertClaim(first.intent.id, 'approval')).toBeUndefined();
    expect(repo.alertClaim(second.intent.id, 'approval')).toBeUndefined();
    expect(repo.intent(first.intent.id)?.status).toBe('pending');
    expect(repo.intent(second.intent.id)?.status).toBe('pending');
  }));
test('alert audit is immutable and malformed owner facts fail closed', async () =>
  fixture(async (_path, store, db) => {
    const { intent } = await pending(store);
    const repo = store.dots();
    const entry = repo.supervisionPage().items[0];
    repo.claimSupervisionAlerts([entry], Date.now());
    expect(() => db.exec('UPDATE dot_alert_claims SET claimed_at=1')).toThrow();
    expect(() => db.exec('DELETE FROM dot_alert_claims')).toThrow();
    repo.create({ id: 'other', name: 'Other', goal: { text: 'Separate owner' }, createdAt: 1 });
    db.exec("DROP TRIGGER dot_alert_claim_no_update; UPDATE dot_alert_claims SET dot_id='other'");
    expect(() => repo.alertClaim(intent.id, 'approval')).toThrow(DotRepositoryError);
    expect(() => repo.claimSupervisionAlerts([entry], Date.now())).toThrow(DotRepositoryError);
  }));
test('v9 alert migration preserves pending work and unrelated expired sources across a DDL collision', async () =>
  fixture(async (path, store, db) => {
    const { intent } = await pending(store);
    store.saveConversation({ id: 'alert-legacy', title: 'Keep', state: 'idle', updatedAt: 1 });
    db.prepare('INSERT INTO web_sources VALUES(?,?,?,?)').run(
      'alert-legacy',
      'expired',
      '{"id":"expired"}',
      0,
    );
    const sources = db.prepare('SELECT * FROM web_sources').all();
    db.exec(
      "DROP TABLE dot_alert_claims; CREATE TABLE dot_alert_claims(sentinel TEXT); INSERT INTO dot_alert_claims VALUES('keep'); PRAGMA user_version=8",
    );
    expect(() => new ProsperoStore(path)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
    expect(db.prepare('SELECT sentinel FROM dot_alert_claims').get()?.sentinel).toBe('keep');
    db.exec('DROP TABLE dot_alert_claims');
    const other = new ProsperoStore(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      expect(other.dots().intent(intent.id)).toEqual(intent);
      expect(db.prepare('SELECT * FROM web_sources').all()).toEqual(sources);
    } finally {
      other.close();
    }
  }));
