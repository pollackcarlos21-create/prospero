import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionPlanRecord, Conversation } from '../../apps/desktop/src/bridge';
import type {
  ActionJournalPort,
  PermissionRequest,
  StructuredAction,
} from '../../packages/core/src';
import { captureFileScope, createLocalToolHost } from '../../packages/local-host/src';
import { LIVE_CASE_IDS } from '../acceptance/live-report';
import {
  getLiveCase,
  LIVE_CASE_CATALOG,
  LIVE_CATALOG_SHA256,
  selectLiveCases,
} from '../acceptance/live-cases';
import {
  captureLiveFixtureCheckpoint,
  createLiveFixture,
  LIVE_CONTROLLED_EDIT_TEXT,
  LIVE_TIME_RANGE,
  type LiveApprovalRecord,
  type LiveCaseFixture,
  renderLiveCaseTask,
  verifyLiveCaseOutcome,
} from '../acceptance/live-fixtures';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function conversation(fixture: LiveCaseFixture): Conversation {
  return {
    id: 'unit-machine-oracle',
    title: 'fixture oracle only',
    state: 'completed',
    updatedAt: Date.now(),
    attachments: [],
    streamingText: '',
    timeline: [],
    actionPlans: [],
    messages: [{ role: 'user', content: renderLiveCaseTask(fixture) }],
  };
}
/** Real host effects and journal protocol; this is not a live model or SQLite runner. */
async function execute(
  fixture: LiveCaseFixture,
  value: Conversation,
  approvals: LiveApprovalRecord[],
  makeActions: (scopeId: string) => StructuredAction[],
  options: {
    phase?: string;
    before?: () => Promise<void>;
    native?: NonNullable<Parameters<typeof createLocalToolHost>[0]>['native'];
    decision?: 'allow-once' | 'deny';
  } = {},
) {
  const scope = await captureFileScope(fixture.root, 'write');
  let record!: ActionPlanRecord;
  const journal: ActionJournalPort = {
    prepare(plan) {
      record = {
        plan,
        status: 'prepared',
        executionId: `execution-${value.actionPlans?.length}`,
        journal: [],
      };
      value.actionPlans?.push(record);
    },
    decision(_planId, decision) {
      record.status = decision === 'deny' ? 'denied' : 'approved';
    },
    transition(planId, actionId, status) {
      record.journal.push({
        planId,
        actionId,
        status,
        sequence: record.journal.length + 1,
        at: Date.now(),
      });
    },
    finish(_planId, status) {
      record.status = status;
    },
    entries() {
      return record.journal;
    },
  };
  const host = createLocalToolHost({ scopes: [scope], journal, native: options.native });
  const signal = new AbortController().signal;
  const prepared = await host.prepare(
    {
      id: `call-${approvals.length}`,
      name: 'execute_plan',
      arguments: JSON.stringify({ title: 'Fixture actions', actions: makeActions(scope.id) }),
    },
    signal,
  );
  const request: PermissionRequest = {
    requestId: `request-${approvals.length}`,
    call: prepared.call,
    preview: prepared.preview,
    permissionKey: prepared.permissionKey,
    allowSession: prepared.allowSession,
  };
  approvals.push({
    request,
    decision: options.decision ?? 'allow-once',
    phaseId: options.phase ?? 'initial',
  });
  await options.before?.();
  await prepared.onDecision?.(options.decision ?? 'allow-once');
  if (options.decision !== 'deny') {
    const result = await prepared.execute(signal);
    value.timeline.push({
      id: prepared.call.id,
      at: Date.now(),
      type: 'tool',
      call: prepared.call,
      result,
    });
  }
  return { record, request };
}
const ref = (scopeId: string, path: string) => ({ scopeId, path });
const status = (result: Awaited<ReturnType<typeof verifyLiveCaseOutcome>>, id: string) =>
  result.checks.find((check) => check.id === id)?.status;

test('catalog freezes exactly 30 IDs, natural phases and human rubrics; subsets cannot impersonate a round', () => {
  expect(LIVE_CASE_CATALOG.map((item) => item.id)).toEqual([...LIVE_CASE_IDS]);
  expect(new Set(LIVE_CASE_CATALOG.map((item) => item.id)).size).toBe(30);
  expect(LIVE_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(LIVE_CATALOG_SHA256).toBe(hash(JSON.stringify(LIVE_CASE_CATALOG)));
  for (const item of LIVE_CASE_CATALOG) {
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.humanRubric)).toBe(true);
    expect(item.initial.length).toBeGreaterThan(20);
    expect(item.humanRubric.length).toBeGreaterThan(0);
    expect(item.controlledBoundaries.every((fault) => fault.disclosure.length > 20)).toBe(true);
  }
  expect(selectLiveCases([...['W07', 'C07']]).map((item) => item.id)).toEqual(['W07', 'C07']);
  expect(() => selectLiveCases(['W01', 'W01'])).toThrow('selection');
  expect(() => selectLiveCases(['C11'])).toThrow('case ID');
  expect(() => selectLiveCases([])).toThrow('selection');
  expect(getLiveCase('C07').controlledBoundaries[0].id).toBe(
    'process-exit-after-effect-before-journal',
  );
});

test('fixture bytes, filenames, dates and catalog identity freeze independently of allocated temp paths', async () => {
  const a = await createLiveFixture('F04');
  const b = await createLiveFixture('F04');
  try {
    expect(a.root).not.toBe(b.root);
    expect(a.fixtureSha256).toBe(b.fixtureSha256);
    expect(a.catalogSha256).toBe(LIVE_CATALOG_SHA256);
    expect((await stat(join(a.root, 'Downloads/recent.pdf'))).mtimeMs).toBe(
      Date.parse(LIVE_TIME_RANGE.recent),
    );
    expect((await stat(join(a.root, 'Downloads/old.pdf'))).mtimeMs).toBe(
      Date.parse(LIVE_TIME_RANGE.old),
    );
    expect((await stat(join(a.root, 'Downloads/future.pdf'))).mtimeMs).toBe(
      Date.parse(LIVE_TIME_RANGE.future),
    );
    expect(await readFile(join(a.root, 'Downloads/recent.pdf'), 'utf8')).toContain(
      'NOT AN ACTUAL PDF',
    );
    expect(a.placeholderPdf).toBe(true);
    expect(renderLiveCaseTask(a)).not.toContain('{{ROOT}}');
    expect(renderLiveCaseTask(a)).toContain('modifiedAt');
    expect(Object.isFrozen(a.fileNames)).toBe(true);
  } finally {
    await a.close();
    await b.close();
  }
});

test('real host UTF8/BOM effect must match complete approved diff; state alone never passes', async () => {
  const f = await createLiveFixture('F01');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    const empty = await verifyLiveCaseOutcome(f, { conversation: value, approvals });
    expect(empty.objective).toBe('failed');
    const text = '\uFEFFProspero fixture\n中文与 emoji 📄\n';
    await execute(f, value, approvals, (scope) => [
      { kind: 'create_directory', target: ref(scope, 'Notes') },
      { kind: 'write_text', target: ref(scope, 'Notes/note.txt'), content: text },
    ]);
    const result = await verifyLiveCaseOutcome(f, { conversation: value, approvals });
    expect(result.objective).toBe('verified');
    expect(result.requiresHumanReview).toBe(true);
    expect(status(result, 'complete-approved-diff-bytes')).toBe('pass');
    expect(await readFile(join(f.root, 'Notes/note.txt'))).toEqual(Buffer.from(text));
    const corrupted = structuredClone(approvals);
    if (corrupted[0].request.preview.plan)
      corrupted[0].request.preview.plan.actions[1].afterHash = hash('different');
    expect(
      (await verifyLiveCaseOutcome(f, { conversation: value, approvals: corrupted })).objective,
    ).toBe('failed');
    await writeFile(join(f.root, 'Notes/note.txt'), text.slice(1));
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals })).objective).toBe(
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('copy verifies actual binary source/target and rejects sentinel corruption or unapproved additions', async () => {
  const f = await createLiveFixture('F02');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    const original = await readFile(join(f.root, 'source.bin'));
    expect(original.byteLength).toBe(2048);
    await execute(f, value, approvals, (scope) => [
      { kind: 'copy_file', source: ref(scope, 'source.bin'), target: ref(scope, 'copy.bin') },
    ]);
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals })).objective).toBe(
      'verified',
    );
    expect(await readFile(join(f.root, 'copy.bin'))).toEqual(original);
    await writeFile(join(f.root, 'unexpected.txt'), 'not approved');
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals }),
        'no-unapproved-added-file',
      ),
    ).toBe('fail');
    await rm(join(f.root, 'unexpected.txt'));
    await writeFile(join(f.root, '.preserve/sentinel.bin'), 'changed');
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals }),
        'sentinel-unchanged',
      ),
    ).toBe('fail');
  } finally {
    await f.close();
  }
});

test('mtime selection retains outside-range files and the machine oracle does not call it download time', async () => {
  const f = await createLiveFixture('F04');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    await execute(f, value, approvals, (scope) => [
      { kind: 'create_directory', target: ref(scope, 'Selected') },
      {
        kind: 'move_file',
        source: ref(scope, 'Downloads/recent.pdf'),
        target: ref(scope, 'Selected/recent.pdf'),
      },
    ]);
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals })).objective).toBe(
      'verified',
    );
    expect(await readdir(join(f.root, 'Selected'))).toEqual(['recent.pdf']);
    await writeFile(join(f.root, 'Downloads/old.pdf'), 'changed');
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals }),
        'out-of-range-and-non-paper-preserved',
      ),
    ).toBe('fail');
  } finally {
    await f.close();
  }
});

test('actual host paginates all 617 seeded files; repeated or missing pages fail despite completed state', async () => {
  const f = await createLiveFixture('F05');
  const value = conversation(f);
  try {
    expect(await readdir(join(f.root, 'Large'))).toHaveLength(617);
    const scope = await captureFileScope(f.root, 'read');
    const host = createLocalToolHost({ scopes: [scope] });
    let cursor: string | null = null;
    let count = 0;
    do {
      const signal = new AbortController().signal;
      const prepared = await host.prepare(
        {
          id: `page-${count++}`,
          name: 'list_directory',
          arguments: JSON.stringify({
            scopeId: scope.id,
            path: 'Large',
            maxEntries: 500,
            ...(cursor ? { cursor } : {}),
          }),
        },
        signal,
      );
      const result = await prepared.execute(signal);
      value.timeline.push({
        id: prepared.call.id,
        at: Date.now(),
        type: 'tool',
        call: prepared.call,
        result,
      });
      cursor = (JSON.parse(result.content) as { nextCursor: string | null }).nextCursor;
    } while (cursor);
    expect(count).toBeGreaterThan(1);
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] })).objective).toBe(
      'verified',
    );
    value.timeline.push(structuredClone(value.timeline[0]));
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] }),
        '617-unique-without-silent-omission',
      ),
    ).toBe('fail');
    value.timeline.pop();
    value.timeline.pop();
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] })).objective).toBe(
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('stale-before-approval is actually observed; only a fresh current-byte copy completes recovery', async () => {
  const f = await createLiveFixture('F10');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    const first = await execute(
      f,
      value,
      approvals,
      (scope) => [
        { kind: 'copy_file', source: ref(scope, 'input.txt'), target: ref(scope, 'result.txt') },
      ],
      { before: () => writeFile(join(f.root, 'input.txt'), LIVE_CONTROLLED_EDIT_TEXT) },
    );
    expect(first.record.status).toBe('stale');
    expect(await readFile(join(f.root, 'input.txt'), 'utf8')).toBe(LIVE_CONTROLLED_EDIT_TEXT);
    const checkpoint = await captureLiveFixtureCheckpoint(f, 'after-stale');
    expect(checkpoint.files.some((entry) => entry.path === 'result.txt')).toBe(false);
    value.messages.push({ role: 'user', content: renderLiveCaseTask(f, 'after-stale') });
    await execute(
      f,
      value,
      approvals,
      (scope) => [
        { kind: 'copy_file', source: ref(scope, 'input.txt'), target: ref(scope, 'result.txt') },
      ],
      { phase: 'after-stale' },
    );
    const input = {
      conversation: value,
      approvals,
      checkpoints: [checkpoint],
      observations: [
        {
          boundaryId: 'stale-before-approve' as const,
          phaseId: 'initial',
          at: Date.now(),
          planId: first.record.plan.id,
        },
      ],
    };
    expect((await verifyLiveCaseOutcome(f, input)).objective).toBe('verified');
    expect((await verifyLiveCaseOutcome(f, { ...input, observations: [] })).objective).toBe(
      'unknown',
    );
    expect(
      (await verifyLiveCaseOutcome(f, { ...input, checkpoints: [structuredClone(checkpoint)] }))
        .objective,
    ).toBe('unknown');
    await writeFile(join(f.root, 'input.txt'), 'lost external edit');
    expect((await verifyLiveCaseOutcome(f, input)).objective).toBe('failed');
  } finally {
    await f.close();
  }
});

test('real host partial copy is preserved; an offline Trash rename cannot count as live native recovery', async () => {
  const f = await createLiveFixture('C06');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    const first = await execute(
      f,
      value,
      approvals,
      (scope) => [
        { kind: 'copy_file', source: ref(scope, 'input.txt'), target: ref(scope, 'copied.txt') },
        { kind: 'trash_file', target: ref(scope, 'trash-me.txt') },
        {
          kind: 'write_text',
          target: ref(scope, 'remaining.txt'),
          content: 'Completed remaining work',
        },
      ],
      {
        native: {
          reveal() {},
          copyPath() {},
          async trash() {
            throw new Error('controlled native failure');
          },
        },
      },
    );
    expect(first.record.status).toBe('partial');
    expect(await readFile(join(f.root, 'copied.txt'), 'utf8')).toBe('Source stays intact');
    const checkpoint = await captureLiveFixtureCheckpoint(f, 'after-partial');
    value.messages.push({ role: 'user', content: renderLiveCaseTask(f, 'after-partial') });
    const receipts = [
      {
        adapter: 'offline-injected' as const,
        path: join(f.root, 'trash-me.txt'),
        beforeSha256: hash('Native failure fixture'),
        outcome: 'completed' as const,
      },
    ];
    await execute(
      f,
      value,
      approvals,
      (scope) => [
        { kind: 'trash_file', target: ref(scope, 'trash-me.txt') },
        {
          kind: 'write_text',
          target: ref(scope, 'remaining.txt'),
          content: 'Completed remaining work',
        },
      ],
      {
        phase: 'after-partial',
        native: {
          reveal() {},
          copyPath() {},
          async trash(path: string) {
            await rm(path);
          },
        },
      },
    );
    const input = {
      conversation: value,
      approvals,
      checkpoints: [checkpoint],
      observations: [
        {
          boundaryId: 'native-failure-after-first-effect' as const,
          phaseId: 'initial',
          at: Date.now(),
          planId: first.record.plan.id,
        },
      ],
      nativeTrashReceipts: receipts,
    };
    const result = await verifyLiveCaseOutcome(f, input);
    expect(status(result, 'partial-effects-checkpoint')).toBe('pass');
    expect(status(result, 'fresh-after-partial')).toBe('pass');
    expect(status(result, 'partial-recovery-bytes')).toBe('pass');
    expect(status(result, 'copy-not-replayed')).toBe('pass');
    expect(status(result, 'actual-native-trash')).toBe('fail');
    expect(result.objective).toBe('failed');
    expect((await verifyLiveCaseOutcome(f, { ...input, nativeTrashReceipts: [] })).objective).toBe(
      'unknown',
    );
  } finally {
    await f.close();
  }
});

test('unexercised crash/stop/summary boundaries stay pending even when somebody labels state completed', async () => {
  for (const id of ['C02', 'C04', 'C07']) {
    const f = await createLiveFixture(id);
    try {
      const result = await verifyLiveCaseOutcome(f, {
        conversation: conversation(f),
        approvals: [],
      });
      expect(result.objective).not.toBe('verified');
      expect(
        result.checks.some(
          (check) => check.id.startsWith('boundary:') && check.status === 'pending',
        ),
      ).toBe(true);
      expect(result.requiresHumanReview).toBe(true);
    } finally {
      await f.close();
    }
  }
});

test('fixture paths refuse symlink escape and swapped roots; cleanup cannot delete the replacement', async () => {
  const f = await createLiveFixture('F02');
  const value = conversation(f);
  try {
    await symlink('/etc', join(f.root, 'outside'));
    expect((await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] })).objective).toBe(
      'failed',
    );
    await rm(join(f.root, 'outside'));
    const saved = `${f.root}-saved`;
    await rename(f.root, saved);
    await mkdir(f.root);
    await writeFile(join(f.root, 'replacement.txt'), 'preserve replacement');
    await expect(f.close()).rejects.toThrow('boundary');
    expect(await readFile(join(f.root, 'replacement.txt'), 'utf8')).toBe('preserve replacement');
    await rm(f.root, { recursive: true });
    await rename(saved, f.root);
  } finally {
    await f.close();
  }
});

test('a denied proposal mentioning an unselected seed cannot remove its integrity protection', async () => {
  const f = await createLiveFixture('F04');
  const value = conversation(f);
  const approvals: LiveApprovalRecord[] = [];
  try {
    await execute(f, value, approvals, (scope) => [
      { kind: 'create_directory', target: ref(scope, 'Selected') },
      {
        kind: 'move_file',
        source: ref(scope, 'Downloads/recent.pdf'),
        target: ref(scope, 'Selected/recent.pdf'),
      },
    ]);
    await execute(
      f,
      value,
      approvals,
      (scope) => [
        {
          kind: 'move_file',
          source: ref(scope, 'Downloads/future.pdf'),
          target: ref(scope, 'forbidden.pdf'),
        },
      ],
      { decision: 'deny' },
    );
    await writeFile(join(f.root, 'Downloads/future.pdf'), 'unapproved change');
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals }),
        'unselected-seed-files-unchanged',
      ),
    ).toBe('fail');
  } finally {
    await f.close();
  }
});

test('followup phases must occur once and in order instead of appearing somewhere in history', async () => {
  const f = await createLiveFixture('F10');
  const value = conversation(f);
  try {
    value.messages.unshift({ role: 'user', content: renderLiveCaseTask(f, 'after-stale') });
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] }),
        'all-phases-observed',
      ),
    ).toBe('fail');
    value.messages.reverse();
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] }),
        'all-phases-observed',
      ),
    ).toBe('pass');
    value.messages.push(structuredClone(value.messages[1]));
    expect(
      status(
        await verifyLiveCaseOutcome(f, { conversation: value, approvals: [] }),
        'all-phases-observed',
      ),
    ).toBe('fail');
  } finally {
    await f.close();
  }
});
