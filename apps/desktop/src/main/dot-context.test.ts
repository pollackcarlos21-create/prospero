import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelPort, ModelRequest, SourceRecord, ToolDefinition } from '@prospero/core';
import { ProsperoStore } from '@prospero/persistence';
import { DotExecutionService } from './dot-execution';
import type { DotResearchRuntime } from './dot-intent-execution';
import { dotContextSeed, readDotContext } from './dot-context';
import { ExecutionAdmission } from './execution-admission';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture record');
  return value;
}

const source: SourceRecord = {
  id: 'retained-source',
  url: 'https://example.test/evidence',
  title: 'Earlier search result',
  kind: 'search',
  retrievedAt: 1,
  contentHash: 'a'.repeat(64),
  excerpt: '',
};
const definition: ToolDefinition = {
  name: 'web_search',
  description: 'Fixture research',
  inputSchema: { type: 'object' },
  riskLevel: 'read',
  effects: ['network.search'],
};
const call = (name: string, args: unknown, id = name) => ({
  content: '',
  toolCalls: [{ name, id, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});

// Actual core suspension and exact intent dispatch, with a temporary profile and fake research port.
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
  const root = mkdtempSync(join(tmpdir(), 'prospero-dot-context-'));
  const path = join(root, 'profile.sqlite');
  let phase: 'partial' | 'continue' | 'unknown' = 'partial';
  let effects = 0;
  let searches = 1;
  let sensitive = '';
  let researchSensitive = '';
  const requests: ModelRequest[] = [];
  const model: ModelPort = {
    stream: async (request) => {
      requests.push(request);
      const results = request.messages.filter((message) => message.role === 'tool');
      if (phase === 'partial' || phase === 'unknown')
        return results.length >= searches
          ? { content: 'Ended without a checkpoint.', toolCalls: [], finishReason: 'stop' }
          : call(
              'web_search',
              { query: `the original question ${results.length}` },
              `search-${results.length}`,
            );
      if (!results.length) return call('read_dot_context', {});
      const history = results.find((result) => result.content.includes('"requestCount"'));
      if (!results.some((result) => result.content.startsWith('Continuation proposal recorded.'))) {
        if (!history) throw new Error('The model did not receive durable context.');
        const record = JSON.parse(history.content);
        expect(record.run.status).toBe('failed');
        expect(record.requests[0].status).toBe('succeeded');
        expect(record.requests[0].receipt.sources[0].id).toBe(source.id);
        return call('record_progress', {
          summary: `Continued from confirmed request ${record.requests[0].id}; retained metadata, no new search.`,
          completed: ['Used earlier request evidence'],
          next: ['Inspect freshness separately'],
        });
      }
      return { content: 'Saved the next bounded step.', toolCalls: [], finishReason: 'stop' };
    },
  };
  const research: DotResearchRuntime = {
    provider: () => ({ id: 'offline', baseUrl: 'https://model.test/v1', model: 'fixture' }),
    policyRevision: () => 0,
    open: async () => ({
      isSensitive: (value: string) => !!researchSensitive && value.includes(researchSensitive),
      definitions: [definition],
      prepare: async (current) => ({
        call: current,
        definition,
        preview: {
          kind: 'web',
          title: 'One bounded search',
          query: JSON.parse(current.arguments).query,
          effects: ['network.search'],
        },
        permissionKey: `fixture-exact:${current.arguments}`,
        allowSession: false,
        requiresPermission: true,
        onSuspended: () => {},
        execute: async () => {
          effects++;
          if (phase === 'unknown') throw new Error('Uncertain remote effect');
          return {
            content: 'A transient body which must not be retained in cross-Run context.',
            sources: [source],
          };
        },
      }),
      receipt: () => ({
        summary: 'Confirmed one search response.',
        sourceIds: [source.id],
        sources: [source],
        responseBytes: 42,
      }),
      close: () => {},
    }),
  };
  const f = {
    root,
    path,
    store: new ProsperoStore(path),
    runner: undefined as unknown as DotExecutionService,
    requests,
    get effects() {
      return effects;
    },
    setSearches(value: number) {
      searches = value;
    },
    setSensitive(value: string, owner: 'model' | 'research' = 'model') {
      if (owner === 'model') sensitive = value;
      else researchSensitive = value;
    },
    setPhase(value: typeof phase) {
      phase = value;
    },
    renew() {
      this.runner = new DotExecutionService(
        this.store.dots(),
        new ExecutionAdmission(),
        async () => ({
          model,
          isSensitive: (value: string) => !!sensitive && value.includes(sensitive),
          release: () => {},
        }),
        () => {},
        Date.now,
        30000,
        research,
      );
    },
    async start(id = 'context-dot') {
      const dot = this.store.dots().create({
        id,
        name: 'Context research',
        goal: { text: 'Maintain a durable research brief' },
        createdAt: 1,
      });
      const pair = this.runner.runNow(dot.id, dot.revision, 'offline');
      await this.runner.wait(dot.id);
      let intentId = '';
      for (let index = 0; index < 5; index++) {
        const intent = this.store.dots().currentIntent(pair.run.id);
        if (intent?.status !== 'pending') break;
        intentId = intent.id;
        const approved = this.store
          .dots()
          .decideIntent(intent.id, intent.revision, intent.digest, 'approve', Date.now());
        this.runner.resumeApproved(
          dot.id,
          required(this.store.dots().get(dot.id)).revision,
          approved.id,
        );
        await this.runner.wait(dot.id);
      }
      return { dotId: dot.id, runId: pair.run.id, intentId };
    },
  };
  f.renew();
  return f;
}

test('a new core Run consumes successful partial-work receipts after profile reopen without repeating the research', async () =>
  fixture(async (f) => {
    const first = await f.start();
    expect(f.store.dots().getRun(first.runId)?.status).toBe('failed');
    expect(f.store.dots().checkpoint(first.dotId)).toBeUndefined();
    await f.runner.shutdown();
    f.store.close();
    f.store = new ProsperoStore(f.path);
    f.renew();
    const db = new DatabaseSync(f.path);
    try {
      const before = db.prepare('SELECT * FROM dot_intent_events').all();
      const page = readDotContext(f.store.dots(), first.dotId);
      expect(page.run?.id).toBe(first.runId);
      expect(page.requests[0].receipt?.sources[0].id).toBe(source.id);
      expect(JSON.stringify(page)).not.toContain('transient body');
      expect(JSON.stringify(page)).not.toContain('continuation');
      expect(JSON.stringify(page)).not.toContain('baseUrl');
      expect(db.prepare('SELECT * FROM dot_intent_events').all()).toEqual(before);
      f.setPhase('continue');
      const dot = required(f.store.dots().get(first.dotId));
      const second = f.runner.runNow(dot.id, dot.revision, 'offline');
      await f.runner.wait(dot.id);
      expect(f.store.dots().getRun(second.run.id)?.status).toBe('succeeded');
      expect(f.store.dots().checkpoint(dot.id)?.summary).toContain(first.intentId);
      expect(f.effects).toBe(1);
      expect(f.store.dots().runIntents(second.run.id)).toHaveLength(0);
      expect(
        f.requests
          .at(-3)
          ?.messages.some((message) => message.content.includes('Recent durable Dot context')),
      ).toBe(true);
      expect(db.prepare('SELECT * FROM dot_intent_events').all()).toEqual(before);
      expect(f.store.conversations()).toEqual([]);
    } finally {
      db.close();
    }
  }));

test('reviewed unknown remains unknown in the context read; inspection never creates a grant or Run', async () =>
  fixture(async (f) => {
    f.setPhase('unknown');
    const first = await f.start();
    const repo = f.store.dots();
    const intent = required(repo.intent(first.intentId));
    const dot = required(repo.get(first.dotId));
    expect(intent.status).toBe('unknown');
    const raw = readDotContext(repo, dot.id);
    expect(raw.requests[0].status).toBe('unknown');
    expect(raw.requests[0].review).toBeUndefined();
    const review = repo.acknowledgeUnknown(
      dot.id,
      dot.revision,
      intent.id,
      intent.revision,
      intent.digest,
      'Checked separately; delivery cannot be determined.',
      Date.now(),
    );
    const before = repo.snapshot(dot.id);
    const page = readDotContext(repo, dot.id);
    expect(page.requests[0].status).toBe('unknown');
    expect(page.requests[0].review).toEqual({ note: review.note, reviewedAt: review.reviewedAt });
    expect(page.requests[0].receipt).toBeUndefined();
    expect(repo.snapshot(dot.id)).toEqual(before);
    expect(f.effects).toBe(1);
  }));

test('terminal context cursors do not move when a newer Run is appended; foreign and in-flight cursors are rejected', async () =>
  fixture(async (f) => {
    const first = await f.start();
    const repo = f.store.dots();
    const dot = required(repo.get(first.dotId));
    const second = repo.createRun(dot.id, dot.revision, { id: 'second', createdAt: dot.updatedAt });
    expect(readDotContext(repo, dot.id).run?.id).toBe(first.runId);
    expect(() => readDotContext(repo, dot.id, { runId: second.run.id })).toThrow();
    expect(() => readDotContext(repo, dot.id, { beforeRunId: second.run.id })).toThrow();
    const terminal = repo.finishRun(
      dot.id,
      second.run.id,
      second.dot.revision,
      'cancelled',
      second.dot.updatedAt,
    );
    const page = readDotContext(repo, dot.id);
    expect(page.run?.id).toBe(second.run.id);
    expect(page.olderRunId).toBe(first.runId);
    const third = repo.createRun(dot.id, terminal.dot.revision, {
      id: 'third',
      createdAt: terminal.dot.updatedAt,
    });
    repo.finishRun(dot.id, third.run.id, third.dot.revision, 'cancelled', third.dot.updatedAt);
    expect(readDotContext(repo, dot.id, { beforeRunId: required(page.run).id }).run?.id).toBe(
      first.runId,
    );
    const other = repo.create({
      id: 'other-dot',
      name: 'Other',
      goal: { text: 'Private other goal' },
      createdAt: 1,
    });
    expect(() => readDotContext(repo, other.id, { runId: first.runId })).toThrow();
    expect(() => readDotContext(repo, other.id, { beforeRunId: first.runId })).toThrow();
    for (const query of [
      { dotId: other.id },
      { requestOffset: -1 },
      { requestOffset: 201 },
      { runId: first.runId, beforeRunId: first.runId },
      {
        get runId(): string {
          throw new Error('getter executed');
        },
      },
    ])
      expect(() => readDotContext(repo, dot.id, query)).toThrow();
    expect(readDotContext(repo, other.id).run).toBeUndefined();
  }));

test('corrupt Run, receipt or checkpoint storage is rejected without repair or automatic dispatch', async () =>
  fixture(async (f) => {
    const first = await f.start();
    const db = new DatabaseSync(f.path);
    try {
      const row = required(
        db.prepare('SELECT receipt FROM dot_intents WHERE id=?').get(first.intentId),
      );
      db.prepare("UPDATE dot_intents SET receipt='not json' WHERE id=?").run(first.intentId);
      expect(() => readDotContext(f.store.dots(), first.dotId)).toThrow();
      db.prepare('UPDATE dot_intents SET receipt=? WHERE id=?').run(
        String(row.receipt),
        first.intentId,
      );
      db.prepare('UPDATE dot_runs SET dot_revision=dot_revision+1 WHERE id=?').run(first.runId);
      expect(() => readDotContext(f.store.dots(), first.dotId)).toThrow();
      expect(f.effects).toBe(1);
    } finally {
      db.close();
    }
  }));

test('all requests in a terminal Run can be paged without changing ledgers or importing current-execution source authority', async () =>
  fixture(async (f) => {
    f.setSearches(3);
    const first = await f.start();
    const repo = f.store.dots();
    const before = repo.snapshot(first.dotId);
    const page = readDotContext(repo, first.dotId);
    expect(page.requestCount).toBe(3);
    expect(page.requests).toHaveLength(2);
    const next = readDotContext(repo, first.dotId, {
      runId: required(page.run).id,
      requestOffset: 2,
    });
    expect(next.requests).toHaveLength(1);
    expect(new Set([...page.requests, ...next.requests].map((request) => request.id)).size).toBe(3);
    expect(
      readDotContext(repo, first.dotId, { runId: first.runId, requestOffset: 3 }).requests,
    ).toEqual([]);
    expect(repo.snapshot(first.dotId)).toEqual(before);
    expect(f.effects).toBe(3);
  }));

test('large multilingual checkpoints are excerpted within the serialized page budget; corrupt originals fail closed', async () =>
  fixture(async (f) => {
    const repo = f.store.dots();
    let dot = repo.create({
      id: 'large-context',
      name: 'Large',
      goal: { text: 'Preserve notes' },
      createdAt: 1,
    });
    const pending = repo.createRun(dot.id, dot.revision, { id: 'large-run', createdAt: 2 });
    const running = repo.startRun(dot.id, pending.run.id, pending.dot.revision, 3);
    const notes = Array.from({ length: 20 }, (_, index) => `${index}:😀中文${'\t'.repeat(400)}end`);
    const result = repo.finishRunWithCheckpoint(
      dot.id,
      running.run.id,
      running.dot.revision,
      { summary: '😀中文'.repeat(1000), completed: notes, next: notes },
      4,
    );
    dot = result.dot;
    const before = repo.checkpoint(dot.id);
    const context = readDotContext(repo, dot.id);
    expect(context.checkpoint?.truncated).toBe(true);
    expect(context.checkpoint?.completed).toHaveLength(5);
    expect(JSON.stringify(context)).not.toContain('�');
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(dotContextSeed(context).checkpoint).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(dotContextSeed(context)), 'utf8')).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(repo.checkpoint(dot.id)).toEqual(before);
    const db = new DatabaseSync(f.path);
    try {
      db.prepare("UPDATE dot_checkpoints SET payload='broken' WHERE dot_id=?").run(dot.id);
      expect(() => readDotContext(repo, dot.id)).toThrow();
      expect(repo.get(dot.id)).toEqual(dot);
    } finally {
      db.close();
    }
  }));

for (const owner of ['model', 'research'] as const)
  for (const escaped of [false, true])
    test(`a known ${owner} credential (${escaped ? 'escaped' : 'plain'}) in a human review note cannot enter the next model request`, async () =>
      fixture(async (f) => {
        f.setPhase('unknown');
        const first = await f.start();
        const repo = f.store.dots();
        const intent = required(repo.intent(first.intentId));
        const dot = required(repo.get(first.dotId));
        const key = escaped ? 'fixture-sensitive-"value\\tail' : 'fixture-sensitive-value';
        repo.acknowledgeUnknown(
          dot.id,
          dot.revision,
          intent.id,
          intent.revision,
          intent.digest,
          `User note contains ${key}`,
          Date.now(),
        );
        f.setSensitive(key, owner);
        f.setPhase('continue');
        const beforeRequests = f.requests.length;
        const current = required(repo.get(dot.id));
        const next = f.runner.runNow(dot.id, current.revision, 'offline');
        await f.runner.wait(dot.id);
        expect(f.requests).toHaveLength(beforeRequests);
        expect(repo.getRun(next.run.id)?.status).toBe('failed');
        expect(repo.intent(intent.id)?.status).toBe('unknown');
        expect(f.effects).toBe(1);
      }));
