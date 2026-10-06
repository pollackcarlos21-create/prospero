import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import type { Conversation } from '../../apps/desktop/src/bridge';
import type { PermissionRequest, SourceRecord } from '../../packages/core/src';
import { captureFileScope, createLocalToolHost } from '../../packages/local-host/src';
import { ProsperoStore } from '../../packages/persistence/src';
import { makeSource } from '../../packages/web/src/content';
import { createLiveActionBoundaries } from '../acceptance/live-action-boundaries';
import {
  createLiveFixture,
  renderLiveCaseTask,
  verifyLiveCaseOutcome,
  type LiveApprovalRecord,
  type LiveCaseFixture,
  type LiveOutcomeInput,
  type LivePageToolObservation,
} from '../acceptance/live-fixtures';

const status = (result: Awaited<ReturnType<typeof verifyLiveCaseOutcome>>, id: string) =>
  result.checks.find((check) => check.id === id)?.status;
function page(time: number): SourceRecord {
  const value = makeSource({
    url: 'https://public.example/paper',
    title: 'Offline correlation fixture',
    content: 'Synthetic offline source bytes; no research or HTTP proof.',
    kind: 'page',
    retrievedAt: new Date(time).toISOString(),
  });
  return { ...value, retrievedAt: time };
}
function research(fixture: LiveCaseFixture) {
  const at = Date.now() - 1000;
  const source = page(at + 15);
  const task = renderLiveCaseTask(fixture);
  const conversation: Conversation = {
    id: 'offline-retained-shape',
    title: 'Page correlation fixture only',
    state: 'completed',
    updatedAt: at + 30,
    attachments: [],
    streamingText: '',
    messages: [{ role: 'user', content: task }],
    sources: [source],
    timeline: [
      { id: 'user-initial', at, type: 'message', message: { role: 'user', content: task } },
      {
        id: 'tool-initial',
        at: at + 10,
        type: 'tool',
        call: { id: 'fetch-initial', name: 'fetch_source', arguments: '{"sourceId":"selected"}' },
        result: { content: 'Execution-only page body was removed from retained data.' },
      },
    ],
  };
  const fact: LivePageToolObservation = {
    phaseId: 'initial',
    toolCallId: 'fetch-initial',
    sourceId: source.id,
    url: source.url,
    contentHash: source.contentHash,
    retrievedAt: source.retrievedAt,
    at: at + 20,
    fetchReceiptId: 'receipt-initial',
  };
  return { at, source, conversation, fact };
}

test('retained successful result plus independently bound page facts passes without restoring sources to Conversation', async () => {
  const fixture = await createLiveFixture('W01');
  try {
    const { conversation, fact } = research(fixture);
    expect(conversation.timeline[1].result?.sources).toBeUndefined();
    const input = { conversation, approvals: [], pageToolResults: [fact] };
    const result = await verifyLiveCaseOutcome(fixture, input);
    expect(status(result, 'actual-page-result-and-registered-source')).toBe('pass');
    expect(result.objective).toBe('verified');
    expect(result.requiresHumanReview).toBe(true);
    expect(conversation.timeline[1].result?.sources).toBeUndefined();
    const anotherReceipt = await verifyLiveCaseOutcome(fixture, {
      ...input,
      pageToolResults: [{ ...fact, fetchReceiptId: 'receipt-other' }],
    });
    expect(anotherReceipt.evidenceSha256).not.toBe(result.evidenceSha256);
  } finally {
    await fixture.close();
  }
});

test('metadata alone, unsuccessful/missing tool results and mismatched correlation fields cannot prove a fetched page', async () => {
  const fixture = await createLiveFixture('W01');
  try {
    const { at, conversation, fact } = research(fixture);
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { conversation, approvals: [] }),
        'actual-page-result-and-registered-source',
      ),
    ).toBe('fail');
    for (const patch of [
      { toolCallId: 'other-call' },
      { sourceId: 'src_000000000000000000000000' },
      { url: 'https://public.example/other' },
      { contentHash: '0'.repeat(64) },
      { phaseId: 'not-a-case-phase' },
      { retrievedAt: fact.retrievedAt - 1 },
      { at: at + 14 },
      { at: conversation.updatedAt + 1 },
      { fetchReceiptId: '' },
      { fetchReceiptId: 'request body cannot be a receipt id' },
    ]) {
      const result = await verifyLiveCaseOutcome(fixture, {
        conversation,
        approvals: [],
        pageToolResults: [{ ...fact, ...patch }],
      });
      expect(status(result, 'actual-page-result-and-registered-source')).toBe('fail');
    }
    for (const result of [undefined, { content: 'Page failed', isError: true }]) {
      const altered = structuredClone(conversation);
      altered.timeline[1].result = result;
      expect(
        status(
          await verifyLiveCaseOutcome(fixture, {
            conversation: altered,
            approvals: [],
            pageToolResults: [fact],
          }),
          'actual-page-result-and-registered-source',
        ),
      ).toBe('fail');
    }
  } finally {
    await fixture.close();
  }
});

test('legacy genuine host-returned source fields remain valid, but source metadata with no matching result does not', async () => {
  const fixture = await createLiveFixture('W01');
  try {
    const { conversation, source } = research(fixture);
    conversation.timeline[1].result = { content: 'Offline host result', sources: [source] };
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { conversation, approvals: [] }),
        'actual-page-result-and-registered-source',
      ),
    ).toBe('pass');
    conversation.timeline[1].result.sources = [{ ...source, contentHash: '0'.repeat(64) }];
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { conversation, approvals: [] }),
        'actual-page-result-and-registered-source',
      ),
    ).toBe('fail');
  } finally {
    await fixture.close();
  }
});

test('W10 requires an actual successful page after restart with the right phase, tool and fresh retrieval time', async () => {
  const fixture = await createLiveFixture('W10');
  try {
    const { at, source, conversation, fact } = research(fixture);
    const task = renderLiveCaseTask(fixture, 'after-restart');
    const restartAt = at + 100;
    conversation.messages.push({ role: 'user', content: task });
    conversation.timeline.push(
      {
        id: 'user-restart',
        at: restartAt + 1,
        type: 'message',
        message: { role: 'user', content: task },
      },
      {
        id: 'tool-restart',
        at: restartAt + 10,
        type: 'tool',
        call: { id: 'fetch-restart', name: 'fetch_source', arguments: '{"sourceId":"selected"}' },
        result: { content: 'Execution-only body removed.' },
      },
    );
    conversation.updatedAt = restartAt + 30;
    const input: LiveOutcomeInput = {
      conversation,
      approvals: [],
      observations: [{ boundaryId: 'service-restart', phaseId: 'initial', at: restartAt }],
      pageToolResults: [fact],
    };
    // Initial page fact is still valid for the retained metadata, but cannot support a new fetch.
    const old = await verifyLiveCaseOutcome(fixture, input);
    expect(status(old, 'actual-page-result-and-registered-source')).toBe('pass');
    expect(status(old, 'new-fetch-after-actual-restart')).toBe('fail');
    const current = { ...source, retrievedAt: restartAt + 15 };
    conversation.sources = [current];
    const fresh: LivePageToolObservation = {
      ...fact,
      phaseId: 'after-restart',
      toolCallId: 'fetch-restart',
      retrievedAt: current.retrievedAt,
      at: restartAt + 20,
      fetchReceiptId: 'receipt-restart',
    };
    const accepted = await verifyLiveCaseOutcome(fixture, {
      ...input,
      pageToolResults: [fact, fresh],
    });
    expect(status(accepted, 'new-fetch-after-actual-restart')).toBe('pass');
    expect(accepted.objective).toBe('verified');
    for (const patch of [
      { phaseId: 'initial' },
      { toolCallId: 'fetch-initial' },
      { retrievedAt: fact.retrievedAt },
      { at: restartAt - 1 },
    ]) {
      const result = await verifyLiveCaseOutcome(fixture, {
        ...input,
        pageToolResults: [fact, { ...fresh, ...patch }],
      });
      expect(status(result, 'new-fetch-after-actual-restart')).toBe('fail');
    }
  } finally {
    await fixture.close();
  }
});

test('C09 same-content recovery uses a new real SQLite plan and independent approval instead of changing its digest', async () => {
  const fixture = await createLiveFixture('C09');
  const databasePath = join(dirname(fixture.root), 'page-oracle-profile.sqlite');
  const store = new ProsperoStore(databasePath);
  const scope = await captureFileScope(fixture.root, 'write');
  let phaseId = 'initial';
  const initialTask = renderLiveCaseTask(fixture);
  const conversation: Conversation = {
    id: 'offline-same-content-recovery',
    title: 'Actual host and SQLite, no real provider',
    state: 'idle',
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: initialTask }],
    timeline: [
      {
        id: 'user-initial',
        at: Date.now(),
        type: 'message',
        message: { role: 'user', content: initialTask },
      },
    ],
    attachments: [],
    streamingText: '',
  };
  const get = () => ({ ...conversation, actionPlans: store.actionPlans(conversation.id) });
  store.saveConversation(conversation);
  const boundaries = await createLiveActionBoundaries({
    fixture,
    store,
    databasePath,
    conversationId: conversation.id,
    phaseId: () => phaseId,
    getConversation: get,
    stopTask() {},
  });
  const approvals: LiveApprovalRecord[] = [];
  let count = 0;
  const execute = async () => {
    const host = createLocalToolHost({
      scopes: [scope],
      journal: boundaries.wrapJournal(store.actionJournal(conversation.id, `execution-${++count}`)),
    });
    const prepared = await host.prepare(
      {
        id: `call-${count}`,
        name: 'execute_plan',
        arguments: JSON.stringify({
          title: 'Same approved storage task',
          actions: [
            {
              kind: 'write_text',
              target: { scopeId: scope.id, path: 'storage-result.txt' },
              content: 'Recovered under fresh approval',
            },
          ],
        }),
      },
      new AbortController().signal,
    );
    const request: PermissionRequest = {
      requestId: `permission-${count}`,
      call: prepared.call,
      preview: prepared.preview,
      permissionKey: prepared.permissionKey,
      allowSession: prepared.allowSession,
    };
    approvals.push({ request, decision: 'allow-once', phaseId });
    await prepared.onDecision?.('allow-once');
    const result = await prepared.execute(new AbortController().signal);
    conversation.timeline.push({
      id: prepared.call.id,
      at: Date.now(),
      type: 'tool',
      call: prepared.call,
      result,
    });
    conversation.state = result.isError ? 'failed' : 'completed';
    conversation.updatedAt = Date.now();
    store.saveConversation(conversation);
    return result;
  };
  try {
    expect((await execute()).planOutcome?.status).toBe('failed');
    await boundaries.prepareFollowUp(
      'sqlite-before-running',
      'after-storage-failure',
      new AbortController().signal,
    );
    phaseId = 'after-storage-failure';
    const task = renderLiveCaseTask(fixture, phaseId);
    conversation.messages.push({ role: 'user', content: task });
    conversation.timeline.push({
      id: 'user-recovery',
      at: Date.now(),
      type: 'message',
      message: { role: 'user', content: task },
    });
    expect((await execute()).planOutcome?.status).toBe('completed');
    const [before, after] = store.actionPlans(conversation.id);
    expect(before.plan.digest).toBe(after.plan.digest);
    expect(before.plan.id).not.toBe(after.plan.id);
    const input: LiveOutcomeInput = { conversation: get(), approvals, ...boundaries.evidence() };
    const result = await verifyLiveCaseOutcome(fixture, input);
    expect(status(result, 'fresh-after-storage-failure')).toBe('pass');
    expect(result.objective).toBe('verified');
    const reused = structuredClone(approvals);
    reused[1].request.requestId = reused[0].request.requestId;
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { ...input, approvals: reused }),
        'fresh-after-storage-failure',
      ),
    ).toBe('fail');
    const samePhase = structuredClone(approvals);
    samePhase[1] = { ...samePhase[1], phaseId: 'initial' };
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { ...input, approvals: samePhase }),
        'fresh-after-storage-failure',
      ),
    ).toBe('fail');
    const altered = structuredClone(approvals);
    if (altered[0].request.preview.plan) altered[0].request.preview.plan.digest = '0'.repeat(64);
    expect(
      status(
        await verifyLiveCaseOutcome(fixture, { ...input, approvals: altered }),
        'fresh-after-storage-failure',
      ),
    ).toBe('fail');
  } finally {
    await boundaries.dispose();
    store.close();
    await fixture.close();
  }
});
